import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { existsSync, unlinkSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { isDag } from './graph.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const scryptAsync = promisify(scryptCallback);
const MAGIC = 'SIXPLAN-BACKUP/1\n';

const backupHeaderSchema = z.object({
  format: z.literal('sixplan-backup'), version: z.literal(1), scope: z.enum(['user', 'site']),
  encrypted: z.boolean(), salt: z.string().optional(), iv: z.string().optional(), tag: z.string().optional()
});

const backupPayloadSchema = z.object({
  format: z.literal('sixplan-backup'), version: z.literal(1), scope: z.enum(['user', 'site']), createdAt: z.string().datetime(),
  data: z.object({
    users: z.array(z.record(z.unknown())).optional(),
    settings: z.array(z.record(z.unknown())).optional(),
    userSettings: z.array(z.record(z.unknown())).optional(),
    areas: z.array(z.record(z.unknown())), plans: z.array(z.record(z.unknown())),
    nodes: z.array(z.record(z.unknown())), steps: z.array(z.record(z.unknown())).optional().default([]),
    edges: z.array(z.record(z.unknown()))
  })
});

export type BackupPayload = z.infer<typeof backupPayloadSchema>;

const tableColumns: Record<string, string[]> = {
  users: ['id','username','username_normalized','password_hash','role','is_disabled','must_change_password','version','created_at','updated_at'],
  system_settings: ['key','value','version','updated_at'],
  areas: ['id','user_id','name','name_normalized','sort_order','version','created_at','updated_at'],
  plans: ['id','area_id','name','description','status','archived_at','version','graph_revision','created_at','updated_at'],
  nodes: ['id','plan_id','node_key','title','status','start_date','end_date','summary','extra_content','position_x','position_y','version','created_at','updated_at'],
  node_steps: ['id','node_id','step_key','title','status','start_date','end_date','summary','sort_order','version','created_at','updated_at'],
  user_import_settings: ['user_id','max_nodes','max_edges','max_markdown_bytes','max_file_bytes','session_hours','version','updated_at'],
  edges: ['id','plan_id','source_node_id','target_node_id','version','created_at','updated_at']
};

function validateRows(payload: BackupPayload): void {
  payload.data.plans.forEach((row) => { if (!('graph_revision' in row)) row.graph_revision = 1; });
  payload.data.nodes.forEach((row) => { if (!('node_key' in row)) row.node_key = `node-${String(row.id).replaceAll('-', '').slice(0, 12).toLowerCase()}`; });
  const required = (table: keyof typeof payload.data, columns: string[]) => {
    const rows = payload.data[table];
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (columns.some((column) => !(column in row))) throw new AppError(400, 'INVALID_BACKUP', `备份中的 ${table} 数据不完整`);
  };
  required('areas', tableColumns.areas!); required('plans', tableColumns.plans!); required('nodes', tableColumns.nodes!);
  required('steps', tableColumns.node_steps!); required('edges', tableColumns.edges!);
  if (payload.scope === 'site') { required('users', tableColumns.users!); required('settings', tableColumns.system_settings!); }
  const areaIds = new Set(payload.data.areas.map((row) => String(row.id)));
  const planIds = new Set(payload.data.plans.map((row) => String(row.id)));
  const nodeIds = new Set(payload.data.nodes.map((row) => String(row.id)));
  if (payload.data.plans.some((row) => !areaIds.has(String(row.area_id)))) throw new AppError(400, 'INVALID_BACKUP', '备份中的计划引用了不存在的领域');
  if (payload.data.nodes.some((row) => !planIds.has(String(row.plan_id)))) throw new AppError(400, 'INVALID_BACKUP', '备份中的节点引用了不存在的计划');
  if (payload.data.steps.some((row) => !nodeIds.has(String(row.node_id)))) throw new AppError(400, 'INVALID_BACKUP', '备份中的子阶段引用了不存在的节点');
  const stepKeys = new Set<string>();
  for (const row of payload.data.steps) {
    const token = `${String(row.node_id)}:${String(row.step_key)}`;
    if (stepKeys.has(token)) throw new AppError(400, 'INVALID_BACKUP', '备份中的子阶段 key 重复');
    stepKeys.add(token);
  }
  if (payload.data.edges.some((row) => !planIds.has(String(row.plan_id)) || !nodeIds.has(String(row.source_node_id)) || !nodeIds.has(String(row.target_node_id)))) {
    throw new AppError(400, 'INVALID_BACKUP', '备份中的连接引用无效');
  }
  for (const planId of planIds) {
    const graphNodes = payload.data.nodes.filter((row) => String(row.plan_id) === planId).map((row) => String(row.id));
    const graphEdges = payload.data.edges.filter((row) => String(row.plan_id) === planId).map((row) => ({ sourceNodeId: String(row.source_node_id), targetNodeId: String(row.target_node_id) }));
    if (!isDag(graphNodes, graphEdges)) throw new AppError(400, 'INVALID_BACKUP', '备份中包含非 DAG 计划');
    if (new Set(graphEdges.map((edge) => `${edge.sourceNodeId}:${edge.targetNodeId}`)).size !== graphEdges.length) throw new AppError(400, 'INVALID_BACKUP', '备份中包含重复连接');
  }
}

export function collectBackup(app: FastifyInstance, scope: 'user' | 'site', userId?: string): BackupPayload {
  if (scope === 'user' && !userId) throw new Error('userId is required for user backup');
  const filter = scope === 'user' ? ' WHERE a.user_id = ?' : '';
  const args = scope === 'user' ? [userId] : [];
  const areas = app.database.sqlite.prepare(`SELECT a.* FROM areas a${filter} ORDER BY a.sort_order`).all(...args) as Record<string, unknown>[];
  const plans = app.database.sqlite.prepare(`SELECT p.* FROM plans p JOIN areas a ON a.id = p.area_id${filter} ORDER BY p.created_at`).all(...args) as Record<string, unknown>[];
  const nodes = app.database.sqlite.prepare(`SELECT n.* FROM nodes n JOIN plans p ON p.id = n.plan_id JOIN areas a ON a.id = p.area_id${filter} ORDER BY n.created_at`).all(...args) as Record<string, unknown>[];
  const steps = app.database.sqlite.prepare(`SELECT s.* FROM node_steps s JOIN nodes n ON n.id=s.node_id JOIN plans p ON p.id=n.plan_id JOIN areas a ON a.id=p.area_id${filter} ORDER BY s.node_id,s.sort_order`).all(...args) as Record<string, unknown>[];
  const edges = app.database.sqlite.prepare(`SELECT e.* FROM edges e JOIN plans p ON p.id = e.plan_id JOIN areas a ON a.id = p.area_id${filter} ORDER BY e.created_at`).all(...args) as Record<string, unknown>[];
  return {
    format: 'sixplan-backup', version: 1, scope, createdAt: new Date().toISOString(),
    data: {
      ...(scope === 'site' ? {
        users: app.database.sqlite.prepare('SELECT * FROM users ORDER BY created_at').all() as Record<string, unknown>[],
        settings: app.database.sqlite.prepare('SELECT * FROM system_settings').all() as Record<string, unknown>[],
        userSettings: app.database.sqlite.prepare('SELECT * FROM user_import_settings').all() as Record<string, unknown>[]
      } : {}),
      ...(scope === 'user' ? { userSettings: app.database.sqlite.prepare('SELECT * FROM user_import_settings WHERE user_id = ?').all(userId) as Record<string, unknown>[] } : {}),
      areas, plans, nodes, steps, edges
    }
  };
}

export async function encodeBackup(payload: BackupPayload, password?: string): Promise<Buffer> {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload)));
  if (!password) {
    const header = JSON.stringify({ format: 'sixplan-backup', version: 1, scope: payload.scope, encrypted: false });
    return Buffer.concat([Buffer.from(MAGIC + header + '\n'), compressed]);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await scryptAsync(password, salt, 32) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const header = JSON.stringify({ format: 'sixplan-backup', version: 1, scope: payload.scope, encrypted: true,
    salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
  return Buffer.concat([Buffer.from(MAGIC + header + '\n'), encrypted]);
}

export async function decodeBackup(file: Buffer, password?: string): Promise<BackupPayload> {
  if (!file.subarray(0, MAGIC.length).equals(Buffer.from(MAGIC))) throw new AppError(400, 'INVALID_BACKUP', '不是有效的 sixPlan 备份文件');
  const headerEnd = file.indexOf(10, MAGIC.length);
  if (headerEnd < 0) throw new AppError(400, 'INVALID_BACKUP', '备份文件头损坏');
  let header: z.infer<typeof backupHeaderSchema>;
  try { header = backupHeaderSchema.parse(JSON.parse(file.subarray(MAGIC.length, headerEnd).toString('utf8'))); }
  catch { throw new AppError(400, 'INVALID_BACKUP', '备份文件头无效'); }
  let compressed = file.subarray(headerEnd + 1);
  if (header.encrypted) {
    if (!password) throw new AppError(400, 'BACKUP_PASSWORD_REQUIRED', '该备份需要密码');
    try {
      const key = await scryptAsync(password, Buffer.from(header.salt!, 'base64url'), 32) as Buffer;
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv!, 'base64url'));
      decipher.setAuthTag(Buffer.from(header.tag!, 'base64url'));
      compressed = Buffer.concat([decipher.update(compressed), decipher.final()]);
    } catch { throw new AppError(400, 'BACKUP_PASSWORD_INVALID', '备份密码错误或文件已损坏'); }
  }
  try {
    const payload = backupPayloadSchema.parse(JSON.parse((await gunzipAsync(compressed)).toString('utf8')));
    if (payload.scope !== header.scope) throw new Error('scope mismatch');
    validateRows(payload);
    return payload;
  } catch { throw new AppError(400, 'INVALID_BACKUP', '备份数据损坏或版本不受支持'); }
}

function insertRows(app: FastifyInstance, table: string, rows: Record<string, unknown>[]): void {
  const columns = tableColumns[table];
  if (!columns) throw new Error(`Unsupported restore table: ${table}`);
  for (const row of rows) {
    if (columns.some((column) => !(column in row))) throw new AppError(400, 'INVALID_BACKUP', `备份中的 ${table} 数据不完整`);
    const effectiveColumns = table === 'plans'
      && (app.database.sqlite.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>).some((column) => column.name === 'plan_key')
      ? [...columns, 'plan_key'] : columns;
    const statement = `INSERT INTO ${table} (${effectiveColumns.join(',')}) VALUES (${effectiveColumns.map(() => '?').join(',')})`;
    app.database.sqlite.prepare(statement).run(...effectiveColumns.map((column) => column === 'plan_key'
      ? row.plan_key ?? `plan-${String(row.id).replaceAll('-', '').slice(0, 12).toLowerCase()}` : row[column]));
  }
}

export function restoreUserBackup(app: FastifyInstance, userId: string, payload: BackupPayload): void {
  if (payload.scope !== 'user') throw new AppError(400, 'BACKUP_SCOPE_MISMATCH', '请选择用户级备份文件');
  const importFiles = app.database.sqlite.prepare('SELECT file_path FROM import_sessions WHERE user_id = ?').all(userId) as Array<{ file_path: string }>;
  app.database.sqlite.transaction(() => {
    app.database.sqlite.prepare('DELETE FROM import_sessions WHERE user_id = ?').run(userId);
    app.database.sqlite.prepare('DELETE FROM areas WHERE user_id = ?').run(userId);
    app.database.sqlite.prepare('DELETE FROM user_import_settings WHERE user_id = ?').run(userId);
    const restoredAreas = payload.data.areas.map((row) => ({ ...row, user_id: userId }));
    insertRows(app, 'areas', restoredAreas);
    insertRows(app, 'plans', payload.data.plans);
    insertRows(app, 'nodes', payload.data.nodes);
    insertRows(app, 'node_steps', payload.data.steps);
    insertRows(app, 'edges', payload.data.edges);
    if (payload.data.userSettings?.[0]) insertRows(app, 'user_import_settings', [{ ...payload.data.userSettings[0], user_id: userId }]);
  })();
  for (const file of importFiles) if (existsSync(file.file_path)) unlinkSync(file.file_path);
}

export function restoreSiteBackup(app: FastifyInstance, payload: BackupPayload): void {
  if (payload.scope !== 'site' || !payload.data.users || !payload.data.settings) {
    throw new AppError(400, 'BACKUP_SCOPE_MISMATCH', '请选择全站备份文件');
  }
  const importFiles = app.database.sqlite.prepare('SELECT file_path FROM import_sessions').all() as Array<{ file_path: string }>;
  app.database.sqlite.transaction(() => {
    app.database.sqlite.exec('DELETE FROM sessions; DELETE FROM import_sessions; DELETE FROM edges; DELETE FROM node_steps; DELETE FROM nodes; DELETE FROM plans; DELETE FROM areas; DELETE FROM user_import_settings; DELETE FROM system_settings; DELETE FROM users;');
    insertRows(app, 'users', payload.data.users!);
    insertRows(app, 'system_settings', payload.data.settings!);
    insertRows(app, 'areas', payload.data.areas);
    insertRows(app, 'plans', payload.data.plans);
    insertRows(app, 'nodes', payload.data.nodes);
    insertRows(app, 'node_steps', payload.data.steps);
    insertRows(app, 'edges', payload.data.edges);
    if (payload.data.userSettings) insertRows(app, 'user_import_settings', payload.data.userSettings);
  })();
  for (const file of importFiles) if (existsSync(file.file_path)) unlinkSync(file.file_path);
}
