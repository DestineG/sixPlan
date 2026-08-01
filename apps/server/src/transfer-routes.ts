import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AreaFileSchema, type AreaFile, type ImportResult, type PlanSnapshot } from '@sixplan/shared';
import { z } from 'zod';
import { AppError } from './errors.js';
import { requireReadyUser } from './auth.js';
import { collectBackup, decodeBackup, encodeBackup, restoreUserBackup } from './backup.js';
import { getArea } from './repository.js';
import { createSnapshot, createSnapshotPayload, insertSnapshot, validateSnapshot, validateSnapshotPayload } from './plan-transfer.js';

function validateAreaFile(input: unknown): AreaFile {
  const file = AreaFileSchema.parse(input);
  file.plans.forEach(validateSnapshotPayload);
  return file;
}

function createAreaFile(app: FastifyInstance, userId: string, areaId: string): AreaFile {
  const area = getArea(app, userId, areaId);
  const planIds = app.database.sqlite.prepare('SELECT id FROM plans WHERE area_id = ? ORDER BY created_at').all(areaId) as Array<{ id: string }>;
  return {
    format: 'sixplan-area', version: 2, exportedAt: new Date().toISOString(),
    area: { name: area.name, createdAt: area.created_at, updatedAt: area.updated_at },
    plans: planIds.map(({ id }) => createSnapshotPayload(app, userId, id))
  };
}

function createArea(app: FastifyInstance, userId: string, name: string, createdAt: string, updatedAt: string): string {
  const areaId = randomUUID();
  const order = app.database.sqlite.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 value FROM areas WHERE user_id = ?').get(userId) as { value: number };
  app.database.sqlite.prepare(`INSERT INTO areas (id,user_id,name,name_normalized,sort_order,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`)
    .run(areaId, userId, name, name.toLocaleLowerCase(), order.value, createdAt, updatedAt);
  return areaId;
}

function importOne(app: FastifyInstance, userId: string, file: PlanSnapshot, targetAreaId?: string, createAreaName?: string) {
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
    return insertSnapshot(app, userId, areaId, { plan: file.plan, nodes: file.nodes, edges: file.edges });
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
    const file = createSnapshot(app, request.currentUser!.id, id);
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
        const file = validateSnapshot(item.content);
        const duplicate = app.database.sqlite.prepare(`SELECT COUNT(*) value FROM plans p JOIN areas a ON a.id = p.area_id
          WHERE a.user_id = ? AND p.name = ? AND p.area_id = ?`).get(request.currentUser!.id, file.plan.name, item.targetAreaId ?? '') as { value: number };
        const imported = importOne(app, request.currentUser!.id, file, item.targetAreaId, item.createAreaName);
        results.push({ fileName: item.fileName, success: true, plan: imported.plan, autoActivated: imported.autoActivated,
          ...(duplicate.value > 0 ? { message: '已导入同名计划副本' } : {}) });
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
      const plans = file.plans.map((plan) => insertSnapshot(app, request.currentUser!.id, areaId, plan));
      return { areaId, areaName, importedPlanCount: plans.length, autoActivatedPlanCount: plans.filter((plan) => plan.autoActivated).length };
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
