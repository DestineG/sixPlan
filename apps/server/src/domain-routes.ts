import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { deriveDateManagedNodeStatus, NODE_STATUSES, PLAN_STATUSES, type GraphDto } from '@sixplan/shared';
import { z } from 'zod';
import { requireReadyUser } from './auth.js';
import { AppError } from './errors.js';
import { wouldCreateCycle } from './graph.js';
import { assertPlanningStatusAllowed, promotePlanningPlan } from './plan-status.js';
import {
  ensureEditable, ensureVersion, getArea, getNode, getPlan, mapArea, mapEdge, mapNode, mapPlan,
  type AreaRow, type EdgeRow, type NodeRow, type PlanRow
} from './repository.js';

const idParams = z.object({ id: z.string().uuid() });
const planParams = z.object({ planId: z.string().uuid() });
const nodeParams = z.object({ nodeId: z.string().uuid() });
const edgeParams = z.object({ edgeId: z.string().uuid() });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const requiredDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function validateDates(startDate: string | null, endDate: string | null): void {
  if (startDate && endDate && endDate < startDate) throw new AppError(400, 'INVALID_DATE_RANGE', '结束日期不得早于开始日期');
}

export async function registerDomainRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireReadyUser);

  app.get('/api/areas', async (request) => {
    const rows = app.database.sqlite.prepare(`SELECT a.*,
      SUM(CASE WHEN p.archived_at IS NULL AND p.id IS NOT NULL THEN 1 ELSE 0 END) AS plan_count,
      SUM(CASE WHEN p.archived_at IS NULL AND p.status = 'active' THEN 1 ELSE 0 END) AS active_plan_count,
      SUM(CASE WHEN p.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_plan_count
      FROM areas a LEFT JOIN plans p ON p.area_id = a.id WHERE a.user_id = ?
      GROUP BY a.id ORDER BY a.sort_order, a.created_at`).all(request.currentUser!.id) as AreaRow[];
    return { areas: rows.map(mapArea) };
  });

  app.post('/api/areas', async (request, reply) => {
    const body = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const now = new Date().toISOString();
    const sort = app.database.sqlite.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM areas WHERE user_id = ?')
      .get(request.currentUser!.id) as { value: number };
    const row: AreaRow = { id: randomUUID(), user_id: request.currentUser!.id, name: body.name,
      name_normalized: body.name.toLocaleLowerCase(), sort_order: sort.value, version: 1, created_at: now, updated_at: now };
    try {
      app.database.sqlite.prepare(`INSERT INTO areas
        (id,user_id,name,name_normalized,sort_order,version,created_at,updated_at)
        VALUES (@id,@user_id,@name,@name_normalized,@sort_order,@version,@created_at,@updated_at)`).run(row);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppError(409, 'AREA_NAME_EXISTS', '领域名称已存在');
      throw error;
    }
    reply.code(201);
    return { area: mapArea(row) };
  });

  app.patch('/api/areas/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(100), expectedVersion: z.number().int().positive() }).parse(request.body);
    const area = getArea(app, request.currentUser!.id, id);
    ensureVersion(area.version, body.expectedVersion);
    const now = new Date().toISOString();
    try {
      app.database.sqlite.prepare(`UPDATE areas SET name = ?, name_normalized = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(body.name, body.name.toLocaleLowerCase(), now, id);
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new AppError(409, 'AREA_NAME_EXISTS', '领域名称已存在');
      throw error;
    }
    return { area: mapArea(getArea(app, request.currentUser!.id, id)) };
  });

  app.put('/api/areas/order', async (request) => {
    const body = z.object({ items: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int().min(0), expectedVersion: z.number().int().positive() })) }).parse(request.body);
    app.database.sqlite.transaction(() => {
      for (const item of body.items) {
        const area = getArea(app, request.currentUser!.id, item.id);
        ensureVersion(area.version, item.expectedVersion);
        app.database.sqlite.prepare('UPDATE areas SET sort_order = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run(item.sortOrder, new Date().toISOString(), item.id);
      }
    })();
    return { success: true };
  });

  app.delete('/api/areas/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const area = getArea(app, request.currentUser!.id, id);
    ensureVersion(area.version, body.expectedVersion);
    const count = app.database.sqlite.prepare('SELECT COUNT(*) AS value FROM plans WHERE area_id = ?').get(id) as { value: number };
    if (count.value > 0) throw new AppError(409, 'AREA_NOT_EMPTY', '领域中仍有计划，无法删除');
    app.database.sqlite.prepare('DELETE FROM areas WHERE id = ?').run(id);
    return { success: true };
  });

  app.get('/api/plans', async (request) => {
    const query = z.object({ areaId: z.string().uuid().optional(), status: z.enum(PLAN_STATUSES).optional(),
      archive: z.enum(['all', 'unarchived', 'archived']).default('unarchived'), q: z.string().trim().max(200).optional(),
      sort: z.enum(['updated', 'created', 'name']).default('updated') }).parse(request.query);
    const predicates = ['a.user_id = ?']; const parameters: string[] = [request.currentUser!.id];
    if (query.archive === 'unarchived') predicates.push('p.archived_at IS NULL');
    if (query.archive === 'archived') predicates.push('p.archived_at IS NOT NULL');
    if (query.areaId) { predicates.push('p.area_id = ?'); parameters.push(query.areaId); }
    if (query.status) { predicates.push('p.status = ?'); parameters.push(query.status); }
    if (query.q) { predicates.push('(instr(lower(p.name), lower(?)) > 0 OR instr(lower(p.description), lower(?)) > 0)'); parameters.push(query.q, query.q); }
    const orderBy = query.sort === 'created' ? 'p.created_at DESC, p.id' : query.sort === 'name'
      ? 'p.name COLLATE NOCASE ASC, p.created_at DESC' : 'p.updated_at DESC, p.id';
    const sql = `SELECT p.*, a.name AS area_name, a.user_id,
      (SELECT COUNT(*) FROM nodes n WHERE n.plan_id = p.id) AS node_count
      FROM plans p JOIN areas a ON a.id = p.area_id
      WHERE ${predicates.join(' AND ')} ORDER BY ${orderBy}`;
    const rows = app.database.sqlite.prepare(sql).all(...parameters) as PlanRow[];
    return { plans: rows.map(mapPlan) };
  });

  app.get('/api/plans/archived', async (request) => {
    const rows = app.database.sqlite.prepare(`SELECT p.*, a.name AS area_name, a.user_id,
      (SELECT COUNT(*) FROM nodes n WHERE n.plan_id = p.id) AS node_count
      FROM plans p JOIN areas a ON a.id = p.area_id WHERE a.user_id = ? AND p.archived_at IS NOT NULL
      ORDER BY a.sort_order, p.archived_at DESC`).all(request.currentUser!.id) as PlanRow[];
    return { plans: rows.map(mapPlan) };
  });

  app.delete('/api/plans/archived/batch', async (request) => {
    const body = z.object({ items: z.array(z.object({ id: z.string().uuid(), expectedVersion: z.number().int().positive() })).min(1).max(500) })
      .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, '计划不能重复选择').parse(request.body);
    app.database.sqlite.transaction(() => {
      for (const item of body.items) {
        const plan = getPlan(app, request.currentUser!.id, item.id); ensureVersion(plan.version, item.expectedVersion);
        if (!plan.archived_at) throw new AppError(409, 'PLAN_NOT_ARCHIVED', '批量删除只能包含归档计划');
      }
      const remove = app.database.sqlite.prepare('DELETE FROM plans WHERE id = ?');
      for (const item of body.items) remove.run(item.id);
    })();
    return { success: true, deletedCount: body.items.length };
  });

  app.post('/api/plans', async (request, reply) => {
    const body = z.object({ areaId: z.string().uuid(), name: z.string().trim().min(1).max(200),
      description: z.string().max(5000).default(''), status: z.enum(PLAN_STATUSES).default('planning') }).parse(request.body);
    const area = getArea(app, request.currentUser!.id, body.areaId);
    const now = new Date().toISOString();
    const row: PlanRow = { id: randomUUID(), area_id: area.id, area_name: area.name, user_id: area.user_id,
      name: body.name, description: body.description, status: body.status, archived_at: null, version: 1,
      graph_revision: 1, created_at: now, updated_at: now, node_count: 0 };
    app.database.sqlite.prepare(`INSERT INTO plans
      (id,area_id,name,description,status,archived_at,version,graph_revision,created_at,updated_at)
      VALUES (@id,@area_id,@name,@description,@status,@archived_at,@version,@graph_revision,@created_at,@updated_at)`).run(row);
    reply.code(201);
    return { plan: mapPlan(row) };
  });

  app.get('/api/plans/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return { plan: mapPlan(getPlan(app, request.currentUser!.id, id)) };
  });

  app.patch('/api/plans/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ name: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(),
      status: z.enum(PLAN_STATUSES).optional(), expectedVersion: z.number().int().positive() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, id);
    ensureEditable(plan); ensureVersion(plan.version, body.expectedVersion);
    app.database.sqlite.transaction(() => {
      if (body.status === 'planning') assertPlanningStatusAllowed(app, id);
      app.database.sqlite.prepare(`UPDATE plans SET name = ?, description = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`)
        .run(body.name ?? plan.name, body.description ?? plan.description, body.status ?? plan.status, new Date().toISOString(), id);
    })();
    return { plan: mapPlan(getPlan(app, request.currentUser!.id, id)) };
  });

  app.post('/api/plans/:id/archive', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, id); ensureEditable(plan); ensureVersion(plan.version, body.expectedVersion);
    const now = new Date().toISOString();
    app.database.sqlite.prepare('UPDATE plans SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run(now, now, id);
    return { plan: mapPlan(getPlan(app, request.currentUser!.id, id)) };
  });

  app.post('/api/plans/:id/restore', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, id); ensureVersion(plan.version, body.expectedVersion);
    if (!plan.archived_at) throw new AppError(409, 'PLAN_NOT_ARCHIVED', '计划尚未归档');
    const now = new Date().toISOString();
    const autoActivated = app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare('UPDATE plans SET archived_at = NULL, version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
      return promotePlanningPlan(app, id, now);
    })();
    return { plan: mapPlan(getPlan(app, request.currentUser!.id, id)), autoActivated };
  });

  app.post('/api/plans/:id/move', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ areaId: z.string().uuid(), expectedVersion: z.number().int().positive() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, id); ensureEditable(plan); ensureVersion(plan.version, body.expectedVersion);
    getArea(app, request.currentUser!.id, body.areaId);
    app.database.sqlite.prepare('UPDATE plans SET area_id = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(body.areaId, new Date().toISOString(), id);
    return { plan: mapPlan(getPlan(app, request.currentUser!.id, id)) };
  });

  app.delete('/api/plans/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, id); ensureVersion(plan.version, body.expectedVersion);
    if (!plan.archived_at) throw new AppError(409, 'PLAN_NOT_ARCHIVED', '普通计划不能永久删除');
    app.database.sqlite.transaction(() => app.database.sqlite.prepare('DELETE FROM plans WHERE id = ?').run(id))();
    return { success: true };
  });

  app.get('/api/plans/:planId/graph', async (request) => {
    const { planId } = planParams.parse(request.params);
    const plan = getPlan(app, request.currentUser!.id, planId);
    const nodeRows = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id = ? ORDER BY created_at').all(planId) as NodeRow[];
    const edgeRows = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id = ? ORDER BY created_at').all(planId) as EdgeRow[];
    const graph: GraphDto = { plan: mapPlan(plan), nodes: nodeRows.map(mapNode), edges: edgeRows.map(mapEdge) };
    return { graph };
  });

  app.post('/api/plans/:planId/nodes/reconcile-statuses', async (request) => {
    const { planId } = planParams.parse(request.params);
    const { today } = z.object({ today: requiredDateOnly }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, planId); ensureEditable(plan);
    const rows = app.database.sqlite.prepare("SELECT * FROM nodes WHERE plan_id = ? AND status IN ('not_started', 'in_progress') ORDER BY created_at")
      .all(planId) as NodeRow[];
    const changed = rows.filter((row) => deriveDateManagedNodeStatus(row.status, row.start_date, today) !== row.status);
    const now = new Date().toISOString();
    const update = app.database.sqlite.prepare('UPDATE nodes SET status = ?, version = version + 1, updated_at = ? WHERE id = ?');
    const result = app.database.sqlite.transaction(() => {
      const updated = changed.map((row) => {
        update.run(deriveDateManagedNodeStatus(row.status, row.start_date, today), now, row.id);
        return mapNode(getNode(app, request.currentUser!.id, row.id));
      });
      return { updated, autoActivated: promotePlanningPlan(app, planId, now) };
    })();
    return { nodes: result.updated, plan: mapPlan(getPlan(app, request.currentUser!.id, planId)), autoActivated: result.autoActivated };
  });

  app.post('/api/plans/:planId/nodes', async (request, reply) => {
    const { planId } = planParams.parse(request.params);
    const body = z.object({ title: z.string().trim().min(1).max(200).default('新节点'), positionX: z.number().finite(), positionY: z.number().finite() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, planId); ensureEditable(plan);
    const now = new Date().toISOString();
    const id = randomUUID();
    const row: NodeRow = { id, plan_id: planId, node_key: `node-${id.replaceAll('-', '').slice(0, 12)}`, title: body.title, status: 'not_started', start_date: null,
      end_date: null, summary: '', extra_content: '', position_x: body.positionX, position_y: body.positionY,
      version: 1, created_at: now, updated_at: now };
    app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare(`INSERT INTO nodes
        (id,plan_id,node_key,title,status,start_date,end_date,summary,extra_content,position_x,position_y,version,created_at,updated_at)
        VALUES (@id,@plan_id,@node_key,@title,@status,@start_date,@end_date,@summary,@extra_content,@position_x,@position_y,@version,@created_at,@updated_at)`).run(row);
      app.database.sqlite.prepare('UPDATE plans SET graph_revision = graph_revision + 1 WHERE id = ?').run(planId);
    })();
    reply.code(201); return { node: mapNode(row) };
  });

  app.patch('/api/nodes/:nodeId', async (request) => {
    const { nodeId } = nodeParams.parse(request.params);
    const body = z.object({ title: z.string().trim().min(1).max(200).optional(), status: z.enum(NODE_STATUSES).optional(),
      startDate: dateOnly.optional(), endDate: dateOnly.optional(), summary: z.string().max(2000).optional(),
      extraContent: z.string().optional(), expectedVersion: z.number().int().positive() }).parse(request.body);
    const node = getNode(app, request.currentUser!.id, nodeId); ensureEditable(node); ensureVersion(node.version, body.expectedVersion);
    const startDate = body.startDate === undefined ? node.start_date : body.startDate;
    const endDate = body.endDate === undefined ? node.end_date : body.endDate;
    validateDates(startDate, endDate);
    const now = new Date().toISOString();
    const autoActivated = app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare(`UPDATE nodes SET title = ?, status = ?, start_date = ?, end_date = ?, summary = ?, extra_content = ?,
        version = version + 1, updated_at = ? WHERE id = ?`).run(body.title ?? node.title, body.status ?? node.status,
        startDate, endDate, body.summary ?? node.summary, body.extraContent ?? node.extra_content, now, nodeId);
      return promotePlanningPlan(app, node.plan_id, now);
    })();
    return { node: mapNode(getNode(app, request.currentUser!.id, nodeId)),
      plan: mapPlan(getPlan(app, request.currentUser!.id, node.plan_id)), autoActivated };
  });

  app.delete('/api/nodes/:nodeId', async (request) => {
    const { nodeId } = nodeParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const node = getNode(app, request.currentUser!.id, nodeId); ensureEditable(node); ensureVersion(node.version, body.expectedVersion);
    app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
      app.database.sqlite.prepare('UPDATE plans SET graph_revision = graph_revision + 1 WHERE id = ?').run(node.plan_id);
    })();
    return { success: true };
  });

  app.put('/api/plans/:planId/nodes/positions', async (request) => {
    const { planId } = planParams.parse(request.params);
    const body = z.object({ positions: z.array(z.object({ id: z.string().uuid(), positionX: z.number().finite(), positionY: z.number().finite(), expectedVersion: z.number().int().positive() })) }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, planId); ensureEditable(plan);
    const updated = app.database.sqlite.transaction(() => body.positions.map((position) => {
      const node = getNode(app, request.currentUser!.id, position.id);
      if (node.plan_id !== planId) throw new AppError(400, 'NODE_PLAN_MISMATCH', '节点不属于当前计划');
      ensureVersion(node.version, position.expectedVersion);
      app.database.sqlite.prepare('UPDATE nodes SET position_x = ?, position_y = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(position.positionX, position.positionY, new Date().toISOString(), position.id);
      return mapNode(getNode(app, request.currentUser!.id, position.id));
    }))();
    return { nodes: updated };
  });

  app.post('/api/plans/:planId/edges', async (request, reply) => {
    const { planId } = planParams.parse(request.params);
    const body = z.object({ sourceNodeId: z.string().uuid(), targetNodeId: z.string().uuid() }).parse(request.body);
    const plan = getPlan(app, request.currentUser!.id, planId); ensureEditable(plan);
    if (body.sourceNodeId === body.targetNodeId) throw new AppError(409, 'SELF_EDGE', '不能将节点连接到自身');
    const source = getNode(app, request.currentUser!.id, body.sourceNodeId);
    const target = getNode(app, request.currentUser!.id, body.targetNodeId);
    if (source.plan_id !== planId || target.plan_id !== planId) throw new AppError(400, 'NODE_PLAN_MISMATCH', '连接节点不属于当前计划');
    const existing = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id = ?').all(planId) as EdgeRow[];
    if (existing.some((edge) => edge.source_node_id === body.sourceNodeId && edge.target_node_id === body.targetNodeId)) {
      throw new AppError(409, 'DUPLICATE_EDGE', '该连接已经存在');
    }
    if (wouldCreateCycle(existing.map(mapEdge), body.sourceNodeId, body.targetNodeId)) {
      throw new AppError(409, 'CYCLE_DETECTED', '该连接会形成有向环');
    }
    const now = new Date().toISOString();
    const row: EdgeRow = { id: randomUUID(), plan_id: planId, source_node_id: body.sourceNodeId,
      target_node_id: body.targetNodeId, version: 1, created_at: now, updated_at: now };
    app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare(`INSERT INTO edges
        (id,plan_id,source_node_id,target_node_id,version,created_at,updated_at)
        VALUES (@id,@plan_id,@source_node_id,@target_node_id,@version,@created_at,@updated_at)`).run(row);
      app.database.sqlite.prepare('UPDATE plans SET graph_revision = graph_revision + 1 WHERE id = ?').run(planId);
    })();
    reply.code(201); return { edge: mapEdge(row) };
  });

  app.delete('/api/edges/:edgeId', async (request) => {
    const { edgeId } = edgeParams.parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const edge = app.database.sqlite.prepare(`SELECT e.* FROM edges e JOIN plans p ON p.id = e.plan_id
      JOIN areas a ON a.id = p.area_id WHERE e.id = ? AND a.user_id = ?`).get(edgeId, request.currentUser!.id) as EdgeRow | undefined;
    if (!edge) throw new AppError(404, 'NOT_FOUND', '连接不存在');
    const plan = getPlan(app, request.currentUser!.id, edge.plan_id); ensureEditable(plan); ensureVersion(edge.version, body.expectedVersion);
    app.database.sqlite.transaction(() => {
      app.database.sqlite.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);
      app.database.sqlite.prepare('UPDATE plans SET graph_revision = graph_revision + 1 WHERE id = ?').run(edge.plan_id);
    })();
    return { success: true };
  });
}
