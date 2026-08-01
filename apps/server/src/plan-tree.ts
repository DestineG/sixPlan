import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PlanTreeItemDto } from '@sixplan/shared';
import { AppError } from './errors.js';
import { ensureEditable, ensureVersion, getNode, getPlan, mapPlan, type PlanLinkRow } from './repository.js';

interface TreeRow {
  id: string;
  depth: number;
  parent_node_id: string | null;
  parent_node_key: string | null;
  parent_node_title: string | null;
}

export function createPlanKey(): string {
  return `plan-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function getLinkByParentNode(app: FastifyInstance, nodeId: string): PlanLinkRow | undefined {
  return app.database.sqlite.prepare('SELECT * FROM plan_links WHERE parent_node_id = ?').get(nodeId) as PlanLinkRow | undefined;
}

export function getParentLink(app: FastifyInstance, planId: string): PlanLinkRow | undefined {
  return app.database.sqlite.prepare('SELECT * FROM plan_links WHERE child_plan_id = ?').get(planId) as PlanLinkRow | undefined;
}

function descendantRows(app: FastifyInstance, userId: string, rootPlanId: string): TreeRow[] {
  getPlan(app, userId, rootPlanId);
  return app.database.sqlite.prepare(`WITH RECURSIVE tree(id,depth,parent_node_id,parent_node_key,parent_node_title) AS (
    SELECT p.id,0,NULL,NULL,NULL FROM plans p JOIN areas a ON a.id=p.area_id WHERE p.id=? AND a.user_id=?
    UNION ALL
    SELECT cp.id,tree.depth+1,pn.id,pn.node_key,pn.title FROM tree
      JOIN nodes pn ON pn.plan_id=tree.id JOIN plan_links pl ON pl.parent_node_id=pn.id
      JOIN plans cp ON cp.id=pl.child_plan_id
  ) SELECT * FROM tree ORDER BY depth,id`).all(rootPlanId, userId) as TreeRow[];
}

export function descendantPlanIds(app: FastifyInstance, userId: string, rootPlanId: string, includeRoot = false): string[] {
  const rows = descendantRows(app, userId, rootPlanId);
  return rows.filter((row) => includeRoot || row.depth > 0).map((row) => row.id);
}

export function descendantTree(app: FastifyInstance, userId: string, rootPlanId: string): PlanTreeItemDto[] {
  return descendantRows(app, userId, rootPlanId).map((row) => ({ plan: mapPlan(getPlan(app, userId, row.id)), depth: row.depth,
    parentNodeId: row.parent_node_id, parentNodeKey: row.parent_node_key, parentNodeTitle: row.parent_node_title }));
}

export function ancestorTree(app: FastifyInstance, userId: string, planId: string): PlanTreeItemDto[] {
  getPlan(app, userId, planId);
  const rows = app.database.sqlite.prepare(`WITH RECURSIVE ancestors(id,depth,parent_node_id,parent_node_key,parent_node_title) AS (
    SELECT p.id,0,NULL,NULL,NULL FROM plans p JOIN areas a ON a.id=p.area_id WHERE p.id=? AND a.user_id=?
    UNION ALL
    SELECT pp.id,ancestors.depth+1,pn.id,pn.node_key,pn.title FROM ancestors
      JOIN plan_links pl ON pl.child_plan_id=ancestors.id JOIN nodes pn ON pn.id=pl.parent_node_id
      JOIN plans pp ON pp.id=pn.plan_id
  ) SELECT * FROM ancestors ORDER BY depth DESC`).all(planId, userId) as TreeRow[];
  return rows.map((row) => ({ plan: mapPlan(getPlan(app, userId, row.id)), depth: row.depth,
    parentNodeId: row.parent_node_id, parentNodeKey: row.parent_node_key, parentNodeTitle: row.parent_node_title }));
}

export function assertCanLink(app: FastifyInstance, userId: string, parentNodeId: string, childPlanId: string): void {
  const node = getNode(app, userId, parentNodeId); ensureEditable(node);
  const child = getPlan(app, userId, childPlanId);
  if (child.archived_at) throw new AppError(409, 'CHILD_PLAN_ARCHIVED', '已归档计划需要先恢复才能关联');
  if (node.plan_id === childPlanId) throw new AppError(409, 'PLAN_TREE_CYCLE', '计划不能关联到自身节点');
  if (getLinkByParentNode(app, parentNodeId)) throw new AppError(409, 'NODE_ALREADY_HAS_CHILD', '该节点已经关联子计划');
  if (getParentLink(app, childPlanId)) throw new AppError(409, 'PLAN_ALREADY_HAS_PARENT', '该计划已经关联其他父节点');
  if (descendantPlanIds(app, userId, childPlanId, true).includes(node.plan_id)) {
    throw new AppError(409, 'PLAN_TREE_CYCLE', '该关联会形成计划层级循环');
  }
}

export function createLink(app: FastifyInstance, userId: string, parentNodeId: string, childPlanId: string,
  expectedNodeVersion: number): PlanLinkRow {
  const node = getNode(app, userId, parentNodeId); ensureVersion(node.version, expectedNodeVersion);
  assertCanLink(app, userId, parentNodeId, childPlanId);
  const now = new Date().toISOString(); const link: PlanLinkRow = { id: randomUUID(), parent_node_id: parentNodeId,
    child_plan_id: childPlanId, version: 1, created_at: now, updated_at: now };
  app.database.sqlite.prepare(`INSERT INTO plan_links (id,parent_node_id,child_plan_id,version,created_at,updated_at)
    VALUES (@id,@parent_node_id,@child_plan_id,@version,@created_at,@updated_at)`).run(link);
  app.database.sqlite.prepare('UPDATE nodes SET version=version+1,updated_at=? WHERE id=?').run(now, parentNodeId);
  app.database.sqlite.prepare('UPDATE plans SET graph_revision=graph_revision+1,updated_at=? WHERE id=?').run(now, node.plan_id);
  return link;
}

export function archivePlanIds(app: FastifyInstance, ids: string[], now = new Date().toISOString()): number {
  const update = app.database.sqlite.prepare('UPDATE plans SET archived_at=COALESCE(archived_at,?),version=version+1,updated_at=? WHERE id=? AND archived_at IS NULL');
  return ids.reduce((count, id) => count + update.run(now, now, id).changes, 0);
}

export function restorePlanIds(app: FastifyInstance, ids: string[], now = new Date().toISOString()): number {
  const update = app.database.sqlite.prepare('UPDATE plans SET archived_at=NULL,version=version+1,updated_at=? WHERE id=? AND archived_at IS NOT NULL');
  return ids.reduce((count, id) => count + update.run(now, id).changes, 0);
}

export function movePlanIds(app: FastifyInstance, ids: string[], areaId: string, now = new Date().toISOString()): number {
  const update = app.database.sqlite.prepare('UPDATE plans SET area_id=?,version=version+1,updated_at=? WHERE id=?');
  ids.forEach((id) => update.run(areaId, now, id));
  return ids.length;
}
