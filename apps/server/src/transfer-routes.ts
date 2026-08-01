import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AreaFileSchema, PlanFilePayloadSchema, PlanFileSchema,
  type AreaFile, type ImportResult, type PlanFile, type PlanFilePayload
} from '@sixplan/shared';
import { z } from 'zod';
import { AppError } from './errors.js';
import { isDag } from './graph.js';
import { requireReadyUser } from './auth.js';
import { collectBackup, decodeBackup, encodeBackup, restoreUserBackup } from './backup.js';
import { getArea, getPlan, mapPlan, type EdgeRow, type NodeRow } from './repository.js';

function validatePlanPayload(input: unknown): PlanFilePayload {
  const payload = PlanFilePayloadSchema.parse(input);
  const nodeIds = new Set(payload.nodes.map((node) => node.id));
  const directions = new Set<string>();
  for (const node of payload.nodes) {
    if (node.startDate && node.endDate && node.endDate < node.startDate) {
      throw new AppError(400, 'INVALID_DATE_RANGE', '导入文件包含无效日期范围');
    }
  }
  for (const edge of payload.edges) {
    if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
      throw new AppError(400, 'INVALID_EDGE_REFERENCE', '导入文件中的连接引用了不存在的节点');
    }
    if (edge.sourceNodeId === edge.targetNodeId) throw new AppError(400, 'SELF_EDGE', '导入文件包含自环');
    const key = `${edge.sourceNodeId}:${edge.targetNodeId}`;
    if (directions.has(key)) throw new AppError(400, 'DUPLICATE_EDGE', '导入文件包含重复连接');
    directions.add(key);
  }
  if (!isDag([...nodeIds], payload.edges)) throw new AppError(400, 'CYCLE_DETECTED', '导入文件不是 DAG');
  return payload;
}

function validatePlanFile(input: unknown): PlanFile {
  const file = PlanFileSchema.parse(input);
  validatePlanPayload(file);
  return file;
}

function validateAreaFile(input: unknown): AreaFile {
  const file = AreaFileSchema.parse(input);
  file.plans.forEach(validatePlanPayload);
  return file;
}

function createPlanPayload(app: FastifyInstance, userId: string, planId: string): PlanFilePayload {
  const plan = getPlan(app, userId, planId);
  const nodes = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id = ? ORDER BY created_at').all(planId) as NodeRow[];
  const edges = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id = ? ORDER BY created_at').all(planId) as EdgeRow[];
  return {
    plan: { name: plan.name, description: plan.description, status: plan.status, archivedAt: plan.archived_at, createdAt: plan.created_at, updatedAt: plan.updated_at },
    nodes: nodes.map((node) => ({ id: node.id, title: node.title, status: node.status, startDate: node.start_date, endDate: node.end_date,
      summary: node.summary, extraContent: node.extra_content, positionX: node.position_x, positionY: node.position_y,
      createdAt: node.created_at, updatedAt: node.updated_at })),
    edges: edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source_node_id, targetNodeId: edge.target_node_id,
      createdAt: edge.created_at, updatedAt: edge.updated_at }))
  };
}

function createPlanFile(app: FastifyInstance, userId: string, planId: string): PlanFile {
  const plan = getPlan(app, userId, planId);
  return {
    format: 'sixplan-plan', version: 1, exportedAt: new Date().toISOString(), areaName: plan.area_name,
    ...createPlanPayload(app, userId, planId)
  };
}

function createAreaFile(app: FastifyInstance, userId: string, areaId: string): AreaFile {
  const area = getArea(app, userId, areaId);
  const planIds = app.database.sqlite.prepare('SELECT id FROM plans WHERE area_id = ? ORDER BY created_at').all(areaId) as Array<{ id: string }>;
  return {
    format: 'sixplan-area', version: 1, exportedAt: new Date().toISOString(),
    area: { name: area.name, createdAt: area.created_at, updatedAt: area.updated_at },
    plans: planIds.map(({ id }) => createPlanPayload(app, userId, id))
  };
}

function insertPlan(app: FastifyInstance, userId: string, areaId: string, payload: PlanFilePayload) {
  const planId = randomUUID();
  app.database.sqlite.prepare(`INSERT INTO plans (id,area_id,name,description,status,archived_at,version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)`)
    .run(planId, areaId, payload.plan.name, payload.plan.description, payload.plan.status, payload.plan.archivedAt, payload.plan.createdAt, payload.plan.updatedAt);
  const idMap = new Map<string, string>();
  const nodeStatement = app.database.sqlite.prepare(`INSERT INTO nodes
    (id,plan_id,title,status,start_date,end_date,summary,extra_content,position_x,position_y,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  for (const node of payload.nodes) {
    const id = randomUUID();
    idMap.set(node.id, id);
    nodeStatement.run(id, planId, node.title, node.status, node.startDate, node.endDate, node.summary, node.extraContent,
      node.positionX, node.positionY, node.createdAt, node.updatedAt);
  }
  const edgeStatement = app.database.sqlite.prepare(`INSERT INTO edges
    (id,plan_id,source_node_id,target_node_id,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`);
  for (const edge of payload.edges) {
    edgeStatement.run(randomUUID(), planId, idMap.get(edge.sourceNodeId), idMap.get(edge.targetNodeId), edge.createdAt, edge.updatedAt);
  }
  return mapPlan(getPlan(app, userId, planId));
}

function createArea(app: FastifyInstance, userId: string, name: string, createdAt: string, updatedAt: string): string {
  const areaId = randomUUID();
  const order = app.database.sqlite.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 value FROM areas WHERE user_id = ?').get(userId) as { value: number };
  app.database.sqlite.prepare(`INSERT INTO areas (id,user_id,name,name_normalized,sort_order,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`)
    .run(areaId, userId, name, name.toLocaleLowerCase(), order.value, createdAt, updatedAt);
  return areaId;
}

function importOne(app: FastifyInstance, userId: string, file: PlanFile, targetAreaId?: string, createAreaName?: string) {
  return app.database.sqlite.transaction(() => {
    let areaId = targetAreaId;
    if (createAreaName) {
      const existing = app.database.sqlite.prepare('SELECT id FROM areas WHERE user_id = ? AND name_normalized = ?')
        .get(userId, createAreaName.toLocaleLowerCase()) as { id: string } | undefined;
      if (existing) areaId = existing.id;
      else {
        const now = new Date().toISOString();
        areaId = createArea(app, userId, createAreaName, now, now);
      }
    }
    if (!areaId) throw new AppError(400, 'AREA_DECISION_REQUIRED', '需要选择或创建目标领域');
    getArea(app, userId, areaId);
    return insertPlan(app, userId, areaId, file);
  })();
}

function attachmentName(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.sixplan.backup`;
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

export async function registerTransferRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireReadyUser);
  app.get('/api/plans/:id/export', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const file = createPlanFile(app, request.currentUser!.id, id);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFileName(file.plan.name)}.plan.json`)}`);
    return JSON.stringify(file, null, 2);
  });

  app.get('/api/areas/:id/export', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const file = createAreaFile(app, request.currentUser!.id, id);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeFileName(file.area.name)}.area.json`)}`);
    return JSON.stringify(file, null, 2);
  });

  app.post('/api/plan-imports', async (request) => {
    const body = z.object({ files: z.array(z.object({ fileName: z.string().min(1), content: z.unknown(),
      targetAreaId: z.string().uuid().optional(), createAreaName: z.string().trim().min(1).max(100).optional() })).min(1) }).parse(request.body);
    const results: ImportResult[] = [];
    for (const item of body.files) {
      try {
        const file = validatePlanFile(item.content);
        const duplicate = app.database.sqlite.prepare(`SELECT COUNT(*) value FROM plans p JOIN areas a ON a.id = p.area_id
          WHERE a.user_id = ? AND p.name = ? AND p.area_id = ?`).get(request.currentUser!.id, file.plan.name, item.targetAreaId ?? '') as { value: number };
        const plan = importOne(app, request.currentUser!.id, file, item.targetAreaId, item.createAreaName);
        results.push({ fileName: item.fileName, success: true, plan, ...(duplicate.value > 0 ? { message: '已导入同名计划副本' } : {}) });
      } catch (error) {
        const known = error instanceof AppError ? error : new AppError(400, 'IMPORT_FAILED', error instanceof Error ? error.message : '导入失败');
        results.push({ fileName: item.fileName, success: false, code: known.code, message: known.message });
      }
    }
    return { results };
  });

  app.post('/api/area-imports', async (request, reply) => {
    const body = z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('merge'), content: z.unknown(), targetAreaId: z.string().uuid() }),
      z.object({ mode: z.literal('create'), content: z.unknown(), createAreaName: z.string().trim().min(1).max(100) })
    ]).parse(request.body);
    const file = validateAreaFile(body.content);
    const result = app.database.sqlite.transaction(() => {
      let areaId: string;
      let areaName: string;
      if (body.mode === 'merge') {
        const target = getArea(app, request.currentUser!.id, body.targetAreaId);
        areaId = target.id;
        areaName = target.name;
      } else {
        const normalized = body.createAreaName.toLocaleLowerCase();
        const existing = app.database.sqlite.prepare('SELECT id FROM areas WHERE user_id = ? AND name_normalized = ?')
          .get(request.currentUser!.id, normalized) as { id: string } | undefined;
        if (existing) throw new AppError(409, 'AREA_NAME_EXISTS', '领域名称已存在，请修改新领域名称');
        areaId = createArea(app, request.currentUser!.id, body.createAreaName, file.area.createdAt, file.area.updatedAt);
        areaName = body.createAreaName;
      }
      const plans = file.plans.map((plan) => insertPlan(app, request.currentUser!.id, areaId, plan));
      return { areaId, areaName, importedPlanCount: plans.length };
    })();
    reply.code(201);
    return result;
  });

  app.post('/api/backups/user/export', async (request, reply) => {
    const body = z.object({ password: z.string().min(8).max(128).optional() }).parse(request.body ?? {});
    const buffer = await encodeBackup(collectBackup(app, 'user', request.currentUser!.id), body.password);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${attachmentName('sixplan-user')}"`);
    return buffer;
  });

  app.post('/api/backups/user/restore', async (request) => {
    const part = await request.file({ limits: { fileSize: 1024 * 1024 * 1024, files: 1 } });
    if (!part) throw new AppError(400, 'BACKUP_FILE_REQUIRED', '请选择备份文件');
    const passwordField = part.fields.password as { value?: unknown } | undefined;
    const password = typeof passwordField?.value === 'string' ? passwordField.value : undefined;
    const payload = await decodeBackup(await part.toBuffer(), password || undefined);
    const before = await encodeBackup(collectBackup(app, 'user', request.currentUser!.id));
    await writeFile(join(app.config.backupDir, attachmentName(`before-user-restore-${request.currentUser!.id}`)), before);
    restoreUserBackup(app, request.currentUser!.id, payload);
    return { success: true };
  });
}

export { attachmentName };
