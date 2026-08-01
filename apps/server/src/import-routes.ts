import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { streamArray } from 'stream-json/streamers/stream-array.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import {
  PlanChangeSetSchema, type ImportPreviewDto, type ImportSettingsDto,
  type PlanChangeSet, type PlanSnapshot, type PlanSnapshotEdge, type PlanSnapshotNode
} from '@sixplan/shared';
import { z } from 'zod';
import { requireReadyUser } from './auth.js';
import { AppError } from './errors.js';
import { applyChangeSet, insertSnapshot, prepareChangeSet, validateSnapshot } from './plan-transfer.js';
import { getArea, getPlan, type EdgeRow, type NodeRow } from './repository.js';

interface SessionRow {
  id: string;
  user_id: string;
  kind: 'snapshot' | 'changeset';
  file_path: string;
  status: 'ready' | 'applied';
  target_plan_id: string | null;
  source_name: string;
  expires_at: string;
  created_at: string;
}

interface SettingsRow {
  user_id: string;
  max_nodes: number;
  max_edges: number;
  max_markdown_bytes: number;
  max_file_bytes: number;
  session_hours: number;
  version: number;
  updated_at: string;
}

const PromptScopeSchema = z.enum(['all','leaves']);
type PromptScope = z.infer<typeof PromptScopeSchema>;

const activeByUser = new Map<string, number>();
let activeGlobal = 0;

function hard(app: FastifyInstance) {
  return {
    fileBytes: app.config.importMaxFileBytes ?? 512 * 1024 * 1024,
    nodes: app.config.importMaxNodes ?? 50_000,
    edges: app.config.importMaxEdges ?? 250_000,
    markdownBytes: app.config.importMaxMarkdownBytes ?? 5 * 1024 * 1024,
    tempBytes: app.config.importMaxTempBytes ?? 2 * 1024 * 1024 * 1024,
    sessionHours: app.config.importSessionHours ?? 24,
    perUser: app.config.importMaxConcurrentPerUser ?? 2,
    global: app.config.importMaxConcurrentGlobal ?? 8
  };
}

function getSettingsRow(app: FastifyInstance, userId: string): SettingsRow {
  let row = app.database.sqlite.prepare('SELECT * FROM user_import_settings WHERE user_id = ?').get(userId) as SettingsRow | undefined;
  if (!row) {
    const now = new Date().toISOString();
    app.database.sqlite.prepare(`INSERT INTO user_import_settings
      (user_id,max_nodes,max_edges,max_markdown_bytes,max_file_bytes,session_hours,version,updated_at)
      VALUES (?,0,0,0,0,24,1,?)`).run(userId, now);
    row = app.database.sqlite.prepare('SELECT * FROM user_import_settings WHERE user_id = ?').get(userId) as SettingsRow;
  }
  return row;
}

function mapSettings(row: SettingsRow): ImportSettingsDto {
  return { maxNodes: row.max_nodes, maxEdges: row.max_edges, maxMarkdownBytes: row.max_markdown_bytes,
    maxFileBytes: row.max_file_bytes, sessionHours: row.session_hours, version: row.version };
}

function limited(userValue: number, serverValue: number): number {
  return userValue === 0 ? serverValue : Math.min(userValue, serverValue);
}

function effectiveLimits(app: FastifyInstance, userId: string) {
  const settings = getSettingsRow(app, userId); const server = hard(app);
  return {
    fileBytes: limited(settings.max_file_bytes, server.fileBytes), nodes: limited(settings.max_nodes, server.nodes),
    edges: limited(settings.max_edges, server.edges), markdownBytes: limited(settings.max_markdown_bytes, server.markdownBytes),
    sessionHours: Math.min(settings.session_hours, server.sessionHours), tempBytes: server.tempBytes
  };
}

async function withImportSlot<T>(app: FastifyInstance, userId: string, task: () => Promise<T>): Promise<T> {
  const server = hard(app); const userActive = activeByUser.get(userId) ?? 0;
  if (userActive >= server.perUser || activeGlobal >= server.global) {
    throw new AppError(429, 'IMPORT_BUSY', '当前导入任务较多，请稍后重试');
  }
  activeByUser.set(userId, userActive + 1); activeGlobal += 1;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(408, 'IMPORT_TIMEOUT', '导入任务处理超时')), app.config.importTaskTimeoutMs ?? 30 * 60 * 1000); });
  try { return await Promise.race([task(), timeout]); }
  finally {
    if (timer) clearTimeout(timer);
    activeGlobal -= 1;
    const next = (activeByUser.get(userId) ?? 1) - 1;
    if (next <= 0) activeByUser.delete(userId); else activeByUser.set(userId, next);
  }
}

function deleteSessionFile(row: Pick<SessionRow, 'file_path'>): void {
  if (existsSync(row.file_path)) unlinkSync(row.file_path);
}

function cleanupExpired(app: FastifyInstance): void {
  const rows = app.database.sqlite.prepare('SELECT file_path FROM import_sessions WHERE expires_at <= ?').all(new Date().toISOString()) as Array<{ file_path: string }>;
  for (const row of rows) deleteSessionFile(row);
  app.database.sqlite.prepare('DELETE FROM import_sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

function userTempBytes(app: FastifyInstance, userId: string): number {
  const rows = app.database.sqlite.prepare('SELECT file_path FROM import_sessions WHERE user_id = ?').all(userId) as Array<{ file_path: string }>;
  return rows.reduce((sum, row) => sum + (existsSync(row.file_path) ? statSync(row.file_path).size : 0), 0);
}

async function readValue(filePath: string, filter: string): Promise<unknown> {
  const stream = createReadStream(filePath).pipe(parser.asStream()).pipe(pick.asStream({ filter })).pipe(streamValues.asStream());
  for await (const item of stream as AsyncIterable<{ value: unknown }>) return item.value;
  return undefined;
}

async function readArray<T>(filePath: string, filter: string): Promise<T[]> {
  const values: T[] = [];
  const stream = createReadStream(filePath).pipe(parser.asStream()).pipe(pick.asStream({ filter })).pipe(streamArray.asStream());
  for await (const item of stream as AsyncIterable<{ value: T }>) values.push(item.value);
  return values;
}

async function inspectKeys(filePath: string): Promise<{ top: Set<string>; operations: Set<string> }> {
  const top = new Set<string>(); const operations = new Set<string>();
  let depth = 0; let operationsDepth = -1; let nextIsOperations = false;
  const stream = createReadStream(filePath).pipe(parser.asStream({ streamValues: false }));
  for await (const token of stream as AsyncIterable<{ name: string; value?: unknown }>) {
    if (token.name === 'keyValue' && depth === 1) {
      const key = String(token.value); top.add(key); nextIsOperations = key === 'operations';
    } else if (token.name === 'keyValue' && depth === operationsDepth) operations.add(String(token.value));
    if (token.name === 'startObject' || token.name === 'startArray') {
      depth += 1;
      if (nextIsOperations && token.name === 'startObject') { operationsDepth = depth; nextIsOperations = false; }
    } else if (token.name === 'endObject' || token.name === 'endArray') {
      if (depth === operationsDepth) operationsDepth = -1;
      depth -= 1;
    }
  }
  return { top, operations };
}

function rejectUnknown(actual: Set<string>, allowed: string[], where: string): void {
  const unknown = [...actual].filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError(400, 'UNKNOWN_FIELD', `${where}包含未知字段：${unknown.join('、')}`);
}

async function parseFile(filePath: string): Promise<PlanSnapshot | PlanChangeSet> {
  try {
  const keys = await inspectKeys(filePath);
  const format = await readValue(filePath, 'format'); const version = await readValue(filePath, 'version');
  if (version !== 2) throw new AppError(400, 'UNSUPPORTED_FILE_VERSION', '仅支持 version 2，不兼容旧版文件');
  if (format === 'sixplan-plan-snapshot') {
    rejectUnknown(keys.top, ['format','version','exportedAt','areaName','plan','nodes','edges'], '文件顶层');
    if (!keys.top.has('plan') || !keys.top.has('nodes')) throw new AppError(400, 'VALIDATION_ERROR', '快照必须包含 plan 和 nodes');
    const snapshot = {
      format, version, exportedAt: await readValue(filePath, 'exportedAt'), areaName: await readValue(filePath, 'areaName'),
      plan: await readValue(filePath, 'plan'), nodes: await readArray<PlanSnapshotNode>(filePath, 'nodes'),
      edges: await readArray<PlanSnapshotEdge>(filePath, 'edges')
    };
    return validateSnapshot(snapshot);
  }
  if (format === 'sixplan-plan-changeset') {
    rejectUnknown(keys.top, ['format','version','targetPlanName','baseRevision','planChanges','operations'], '文件顶层');
    rejectUnknown(keys.operations, ['addNodes','updateNodes','removeNodes','addEdges','removeEdges'], 'operations');
    if (!keys.top.has('operations')) throw new AppError(400, 'VALIDATION_ERROR', '增量文件必须包含 operations');
    return PlanChangeSetSchema.parse({
      format, version, targetPlanName: await readValue(filePath, 'targetPlanName'), baseRevision: await readValue(filePath, 'baseRevision'),
      planChanges: await readValue(filePath, 'planChanges'), operations: {
        addNodes: await readArray(filePath, 'operations.addNodes'), updateNodes: await readArray(filePath, 'operations.updateNodes'),
        removeNodes: await readArray(filePath, 'operations.removeNodes'), addEdges: await readArray(filePath, 'operations.addEdges'),
        removeEdges: await readArray(filePath, 'operations.removeEdges')
      }
    });
  }
  throw new AppError(400, 'UNSUPPORTED_FILE_FORMAT', '仅支持 sixplan-plan-snapshot 或 sixplan-plan-changeset');
  } catch (error) {
    if (error instanceof AppError || error instanceof z.ZodError) throw error;
    throw new AppError(400, 'INVALID_JSON', error instanceof Error ? `JSON 解析失败：${error.message}` : 'JSON 解析失败');
  }
}

function validateLimits(app: FastifyInstance, userId: string, value: PlanSnapshot | PlanChangeSet, fileBytes: number): void {
  const limits = effectiveLimits(app, userId);
  if (fileBytes > limits.fileBytes) throw new AppError(413, 'IMPORT_FILE_TOO_LARGE', `文件超过 ${limits.fileBytes} 字节限制`);
  const nodes = value.format === 'sixplan-plan-snapshot' ? value.nodes : value.operations.addNodes;
  const edgeCount = value.format === 'sixplan-plan-snapshot' ? value.edges.length : value.operations.addEdges.length;
  if (nodes.length > limits.nodes) throw new AppError(413, 'IMPORT_NODE_LIMIT', `节点数量超过 ${limits.nodes} 个限制`);
  if (edgeCount > limits.edges) throw new AppError(413, 'IMPORT_EDGE_LIMIT', `连接数量超过 ${limits.edges} 条限制`);
  for (const node of nodes) if (Buffer.byteLength(node.markdown, 'utf8') > limits.markdownBytes) {
    throw new AppError(413, 'IMPORT_MARKDOWN_LIMIT', `节点 ${node.key} 的 Markdown 超过 ${limits.markdownBytes} 字节限制`);
  }
}

function snapshotPreview(snapshot: PlanSnapshot, sessionId: string, expiresAt: string): ImportPreviewDto {
  return {
    sessionId, kind: 'snapshot', planName: snapshot.plan.name, ...(snapshot.areaName ? { suggestedAreaName: snapshot.areaName } : {}),
    nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length, addNodeCount: snapshot.nodes.length,
    updateNodeCount: 0, removeNodeCount: 0, addEdgeCount: snapshot.edges.length, removeEdgeCount: 0,
    needsLayout: snapshot.nodes.some((node) => !node.position), expiresAt,
    previewNodes: snapshot.nodes.slice(0, 200).map((node) => ({ key: node.key, title: node.title, status: node.status, change: 'add' })),
    previewEdges: snapshot.edges.slice(0, 300).map((edge) => ({ source: edge.source, target: edge.target, change: 'add' }))
  };
}

function validatePromptScope(app: FastifyInstance, planId: string, changeSet: PlanChangeSet, scope?: PromptScope): void {
  if (!scope) return;
  const nodes = app.database.sqlite.prepare('SELECT id,node_key FROM nodes WHERE plan_id=?').all(planId) as Array<{ id: string; node_key: string }>;
  const edges = app.database.sqlite.prepare('SELECT source_node_id FROM edges WHERE plan_id=?').all(planId) as Array<{ source_node_id: string }>;
  const sourceIds = new Set(edges.map((edge) => edge.source_node_id));
  const allowedKeys = new Set(scope === 'all' ? nodes.map((node) => node.node_key) : nodes.filter((node) => !sourceIds.has(node.id)).map((node) => node.node_key));
  const operations = changeSet.operations;
  for (const key of [...operations.updateNodes.map((operation) => operation.key), ...operations.removeNodes]) {
    if (!allowedKeys.has(key)) throw new AppError(400, 'PROMPT_SCOPE_VIOLATION', `模型修改了操作范围外的节点：${key}`);
  }
  const addedKeys = new Set(operations.addNodes.map((node) => node.key));
  for (const edge of [...operations.addEdges, ...operations.removeEdges]) for (const key of [edge.source, edge.target]) {
    if (!addedKeys.has(key) && !allowedKeys.has(key)) throw new AppError(400, 'PROMPT_SCOPE_VIOLATION', `模型操作的连接引用了范围外节点：${key}`);
  }
}

async function previewSession(app: FastifyInstance, row: SessionRow): Promise<ImportPreviewDto> {
  const value = await parseFile(row.file_path);
  validateLimits(app, row.user_id, value, statSync(row.file_path).size);
  if (value.format === 'sixplan-plan-snapshot') return snapshotPreview(value, row.id, row.expires_at);
  if (!row.target_plan_id) throw new AppError(400, 'TARGET_PLAN_REQUIRED', '增量文件需要选择目标计划');
  return prepareChangeSet(app, row.user_id, row.target_plan_id, value, row.id, row.expires_at).preview;
}

function getSession(app: FastifyInstance, userId: string, id: string): SessionRow {
  cleanupExpired(app);
  const row = app.database.sqlite.prepare('SELECT * FROM import_sessions WHERE id = ? AND user_id = ?').get(id, userId) as SessionRow | undefined;
  if (!row || !existsSync(row.file_path)) throw new AppError(404, 'IMPORT_SESSION_NOT_FOUND', '导入会话不存在或已过期');
  return row;
}

async function createSession(app: FastifyInstance, userId: string, filePath: string, sourceName: string, targetPlanId?: string, promptScope?: PromptScope): Promise<ImportPreviewDto> {
  const value = await parseFile(filePath); const limits = effectiveLimits(app, userId);
  validateLimits(app, userId, value, statSync(filePath).size);
  if (value.format === 'sixplan-plan-changeset' && !targetPlanId) throw new AppError(400, 'TARGET_PLAN_REQUIRED', '增量文件需要选择目标计划');
  if (value.format === 'sixplan-plan-snapshot' && targetPlanId) throw new AppError(400, 'TARGET_PLAN_NOT_ALLOWED', '全新计划快照不能指定目标计划');
  if (targetPlanId) getPlan(app, userId, targetPlanId);
  if (value.format === 'sixplan-plan-changeset') validatePromptScope(app, targetPlanId!, value, promptScope);
  const id = randomUUID(); const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + limits.sessionHours * 60 * 60 * 1000).toISOString();
  app.database.sqlite.prepare(`INSERT INTO import_sessions
    (id,user_id,kind,file_path,status,target_plan_id,source_name,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, value.format === 'sixplan-plan-snapshot' ? 'snapshot' : 'changeset', filePath, 'ready', targetPlanId ?? null, sourceName, expiresAt, createdAt);
  return value.format === 'sixplan-plan-snapshot' ? snapshotPreview(value, id, expiresAt) : prepareChangeSet(app, userId, targetPlanId!, value, id, expiresAt).preview;
}

function createArea(app: FastifyInstance, userId: string, name: string): string {
  const normalized = name.toLocaleLowerCase();
  const existing = app.database.sqlite.prepare('SELECT id FROM areas WHERE user_id=? AND name_normalized=?').get(userId, normalized) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomUUID(); const now = new Date().toISOString();
  const order = app.database.sqlite.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 value FROM areas WHERE user_id=?').get(userId) as { value: number };
  app.database.sqlite.prepare(`INSERT INTO areas (id,user_id,name,name_normalized,sort_order,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`)
    .run(id, userId, name, normalized, order.value, now, now);
  return id;
}

export async function registerImportRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireReadyUser);
  cleanupExpired(app);

  app.get('/api/import-settings', async (request) => ({ settings: mapSettings(getSettingsRow(app, request.currentUser!.id)), serverLimits: hard(app) }));
  app.put('/api/import-settings', async (request) => {
    const body = z.object({ maxNodes: z.number().int().min(0), maxEdges: z.number().int().min(0), maxMarkdownBytes: z.number().int().min(0),
      maxFileBytes: z.number().int().min(0), sessionHours: z.number().int().min(1).max(24), expectedVersion: z.number().int().positive() }).parse(request.body);
    const row = getSettingsRow(app, request.currentUser!.id);
    if (row.version !== body.expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '设置已被其他请求修改，请刷新后重试');
    app.database.sqlite.prepare(`UPDATE user_import_settings SET max_nodes=?,max_edges=?,max_markdown_bytes=?,max_file_bytes=?,session_hours=?,version=version+1,updated_at=? WHERE user_id=?`)
      .run(body.maxNodes, body.maxEdges, body.maxMarkdownBytes, body.maxFileBytes, body.sessionHours, new Date().toISOString(), request.currentUser!.id);
    return { settings: mapSettings(getSettingsRow(app, request.currentUser!.id)) };
  });

  app.post('/api/import-sessions/json', async (request) => withImportSlot(app, request.currentUser!.id, async () => {
    cleanupExpired(app);
    const body = z.object({ content: z.union([z.string(), z.record(z.unknown())]), targetPlanId: z.string().uuid().optional(), sourceName: z.string().max(255).optional(),
      promptScope: PromptScopeSchema.optional() }).parse(request.body);
    const text = typeof body.content === 'string' ? body.content : JSON.stringify(body.content);
    const limits = effectiveLimits(app, request.currentUser!.id); const size = Buffer.byteLength(text);
    if (size > limits.fileBytes) throw new AppError(413, 'IMPORT_FILE_TOO_LARGE', `内容超过 ${limits.fileBytes} 字节限制`);
    if (userTempBytes(app, request.currentUser!.id) + size > limits.tempBytes) throw new AppError(413, 'IMPORT_TEMP_LIMIT', '临时导入空间不足，请删除旧会话后重试');
    const directory = join(app.config.importDir ?? app.config.dataDir, request.currentUser!.id); await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${randomUUID()}.json`); await writeFile(filePath, text, 'utf8');
    try { return { preview: await createSession(app, request.currentUser!.id, filePath, body.sourceName ?? 'pasted.json', body.targetPlanId, body.promptScope) }; }
    catch (error) { if (existsSync(filePath)) unlinkSync(filePath); throw error; }
  }));

  app.post('/api/import-sessions/upload', async (request) => withImportSlot(app, request.currentUser!.id, async () => {
    cleanupExpired(app);
    const query = z.object({ targetPlanId: z.string().uuid().optional(), scope: PromptScopeSchema.optional() }).parse(request.query);
    const limits = effectiveLimits(app, request.currentUser!.id);
    const part = await request.file({ limits: { fileSize: limits.fileBytes, files: 1 } });
    if (!part) throw new AppError(400, 'IMPORT_FILE_REQUIRED', '请选择 JSON 文件');
    const directory = join(app.config.importDir ?? app.config.dataDir, request.currentUser!.id); await mkdir(directory, { recursive: true });
    const filePath = join(directory, `${randomUUID()}.json`);
    try {
      await pipeline(part.file, createWriteStream(filePath, { flags: 'wx' }));
      if (part.file.truncated) throw new AppError(413, 'IMPORT_FILE_TOO_LARGE', `文件超过 ${limits.fileBytes} 字节限制`);
      const size = statSync(filePath).size;
      if (userTempBytes(app, request.currentUser!.id) + size > limits.tempBytes) throw new AppError(413, 'IMPORT_TEMP_LIMIT', '临时导入空间不足，请删除旧会话后重试');
      return { preview: await createSession(app, request.currentUser!.id, filePath, part.filename, query.targetPlanId, query.scope) };
    } catch (error) { if (existsSync(filePath)) unlinkSync(filePath); throw error; }
  }));

  app.get('/api/import-sessions/:id', async (request) => withImportSlot(app, request.currentUser!.id, async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = getSession(app, request.currentUser!.id, id);
    return { preview: await previewSession(app, row), sourceName: row.source_name, targetPlanId: row.target_plan_id };
  }));

  app.post('/api/import-sessions/:id/apply', async (request, reply) => withImportSlot(app, request.currentUser!.id, async () => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ targetAreaId: z.string().uuid().optional(), createAreaName: z.string().trim().min(1).max(100).optional(),
      confirmedRevision: z.number().int().positive().optional() }).parse(request.body ?? {});
    const row = getSession(app, request.currentUser!.id, id); const value = await parseFile(row.file_path);
    validateLimits(app, row.user_id, value, statSync(row.file_path).size);
    let plan;
    if (value.format === 'sixplan-plan-snapshot') {
      let areaId = body.targetAreaId;
      if (body.createAreaName) areaId = createArea(app, row.user_id, body.createAreaName);
      if (!areaId) throw new AppError(400, 'AREA_DECISION_REQUIRED', '请选择或创建目标领域');
      getArea(app, row.user_id, areaId);
      plan = app.database.sqlite.transaction(() => insertSnapshot(app, row.user_id, areaId!, { plan: value.plan, nodes: value.nodes, edges: value.edges }))();
      reply.code(201);
    } else {
      if (!row.target_plan_id) throw new AppError(400, 'TARGET_PLAN_REQUIRED', '增量文件需要选择目标计划');
      plan = applyChangeSet(app, row.user_id, row.target_plan_id, value, body.confirmedRevision);
    }
    deleteSessionFile(row); app.database.sqlite.prepare('DELETE FROM import_sessions WHERE id=?').run(id);
    return { plan };
  }));

  app.delete('/api/import-sessions/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params); const row = getSession(app, request.currentUser!.id, id);
    deleteSessionFile(row); app.database.sqlite.prepare('DELETE FROM import_sessions WHERE id=?').run(id); return { success: true };
  });

  app.get('/api/plans/:id/prompt-context', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const query = z.object({ scope: z.enum(['all','leaves']).default('all') }).parse(request.query);
    const plan = getPlan(app, request.currentUser!.id, id);
    const nodes = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id=? ORDER BY created_at').all(id) as NodeRow[];
    const edges = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id=? ORDER BY created_at').all(id) as EdgeRow[];
    const keyById = new Map(nodes.map((node) => [node.id, node.node_key]));
    const sourceKeys = new Set(edges.map((edge) => keyById.get(edge.source_node_id)!));
    const leafKeys = nodes.filter((node) => !sourceKeys.has(node.node_key)).map((node) => node.node_key);
    const targetKeys = query.scope === 'all' ? nodes.map((node) => node.node_key) : leafKeys;
    const included = new Set(targetKeys);
    if (query.scope === 'leaves') for (const edge of edges) {
      const source = keyById.get(edge.source_node_id)!; const target = keyById.get(edge.target_node_id)!;
      if (included.has(target)) included.add(source);
    }
    return { context: { plan: { name: plan.name, description: plan.description, status: plan.status, graphRevision: plan.graph_revision },
      scope: query.scope, targetKeys, totalNodeCount: nodes.length, leafNodeCount: leafKeys.length,
      nodes: nodes.filter((node) => included.has(node.node_key)).map((node) => ({ key: node.node_key, title: node.title, status: node.status,
        startDate: node.start_date, endDate: node.end_date, summary: node.summary })),
      edges: edges.map((edge) => ({ source: keyById.get(edge.source_node_id)!, target: keyById.get(edge.target_node_id)! }))
        .filter((edge) => included.has(edge.source) && included.has(edge.target)) } };
  });
}
