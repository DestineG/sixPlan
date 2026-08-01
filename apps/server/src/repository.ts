import type { AreaDto, ChildPlanSummaryDto, EdgeDto, NodeDto, PlanDto } from '@sixplan/shared';
import type { FastifyInstance } from 'fastify';
import { AppError, assertFound } from './errors.js';

export interface AreaRow {
  id: string; user_id: string; name: string; name_normalized: string; sort_order: number;
  version: number; created_at: string; updated_at: string; plan_count?: number; active_plan_count?: number; archived_plan_count?: number;
}
export interface PlanRow {
  id: string; plan_key: string; area_id: string; area_name: string; user_id: string; name: string; description: string;
  status: PlanDto['status']; archived_at: string | null; version: number; graph_revision: number; created_at: string; updated_at: string; node_count?: number;
  parent_plan_id?: string | null; parent_plan_name?: string | null; parent_node_id?: string | null;
  parent_node_key?: string | null; parent_node_title?: string | null; parent_link_version?: number | null;
}
export interface NodeRow {
  id: string; plan_id: string; node_key: string; title: string; status: NodeDto['status']; start_date: string | null; end_date: string | null;
  summary: string; extra_content: string; position_x: number; position_y: number; version: number; created_at: string; updated_at: string;
}
export interface EdgeRow {
  id: string; plan_id: string; source_node_id: string; target_node_id: string; version: number; created_at: string; updated_at: string;
}
export interface PlanLinkRow { id: string; parent_node_id: string; child_plan_id: string; version: number; created_at: string; updated_at: string; }
export interface ChildPlanRow {
  parent_node_id: string; id: string; plan_key: string; name: string; area_id: string; area_name: string;
  status: PlanDto['status']; archived_at: string | null; version: number; link_version: number;
  node_count: number; completed_node_count: number;
}

export function mapArea(row: AreaRow): AreaDto {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, version: row.version,
    planCount: row.plan_count ?? 0, activePlanCount: row.active_plan_count ?? 0, archivedPlanCount: row.archived_plan_count ?? 0,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapPlan(row: PlanRow): PlanDto {
  return { id: row.id, key: row.plan_key, areaId: row.area_id, areaName: row.area_name, name: row.name, description: row.description,
    status: row.status, archivedAt: row.archived_at, version: row.version, graphRevision: row.graph_revision, nodeCount: row.node_count ?? 0,
    createdAt: row.created_at, updatedAt: row.updated_at,
    parent: row.parent_plan_id && row.parent_node_id && row.parent_node_key && row.parent_node_title && row.parent_link_version
      ? { planId: row.parent_plan_id, planName: row.parent_plan_name ?? '', nodeId: row.parent_node_id,
          nodeKey: row.parent_node_key, nodeTitle: row.parent_node_title, linkVersion: row.parent_link_version }
      : null };
}
export function mapChildPlan(row: ChildPlanRow): ChildPlanSummaryDto {
  return { id: row.id, key: row.plan_key, name: row.name, areaId: row.area_id, areaName: row.area_name, status: row.status,
    archivedAt: row.archived_at, version: row.version, linkVersion: row.link_version,
    nodeCount: row.node_count, completedNodeCount: row.completed_node_count };
}
export function mapNode(row: NodeRow, childPlan: ChildPlanSummaryDto | null = null): NodeDto {
  return { id: row.id, planId: row.plan_id, key: row.node_key, title: row.title, status: row.status, startDate: row.start_date,
    endDate: row.end_date, summary: row.summary, extraContent: row.extra_content, positionX: row.position_x,
    positionY: row.position_y, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, childPlan };
}
export function mapEdge(row: EdgeRow): EdgeDto {
  return { id: row.id, planId: row.plan_id, sourceNodeId: row.source_node_id, targetNodeId: row.target_node_id,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function getArea(app: FastifyInstance, userId: string, areaId: string): AreaRow {
  return assertFound(app.database.sqlite.prepare('SELECT * FROM areas WHERE id = ? AND user_id = ?').get(areaId, userId) as AreaRow | undefined, '领域不存在');
}

export function getPlan(app: FastifyInstance, userId: string, planId: string): PlanRow {
  return assertFound(app.database.sqlite.prepare(`SELECT p.*, a.name AS area_name, a.user_id,
    (SELECT COUNT(*) FROM nodes n WHERE n.plan_id = p.id) AS node_count,
    pp.id AS parent_plan_id, pp.name AS parent_plan_name, pn.id AS parent_node_id, pn.node_key AS parent_node_key,
    pn.title AS parent_node_title, pl.version AS parent_link_version
    FROM plans p JOIN areas a ON a.id = p.area_id
    LEFT JOIN plan_links pl ON pl.child_plan_id = p.id LEFT JOIN nodes pn ON pn.id = pl.parent_node_id
    LEFT JOIN plans pp ON pp.id = pn.plan_id WHERE p.id = ? AND a.user_id = ?`).get(planId, userId) as PlanRow | undefined, '计划不存在');
}

export function getChildPlanForNode(app: FastifyInstance, userId: string, nodeId: string): ChildPlanSummaryDto | null {
  const row = app.database.sqlite.prepare(`SELECT l.parent_node_id, cp.id, cp.plan_key, cp.name, cp.area_id, ca.name AS area_name,
    cp.status, cp.archived_at, cp.version, l.version AS link_version,
    (SELECT COUNT(*) FROM nodes cn WHERE cn.plan_id = cp.id) AS node_count,
    (SELECT COUNT(*) FROM nodes cn WHERE cn.plan_id = cp.id AND cn.status = 'completed') AS completed_node_count
    FROM plan_links l JOIN nodes pn ON pn.id = l.parent_node_id JOIN plans pp ON pp.id = pn.plan_id
    JOIN areas pa ON pa.id = pp.area_id JOIN plans cp ON cp.id = l.child_plan_id JOIN areas ca ON ca.id = cp.area_id
    WHERE l.parent_node_id = ? AND pa.user_id = ? AND ca.user_id = ?`).get(nodeId, userId, userId) as ChildPlanRow | undefined;
  return row ? mapChildPlan(row) : null;
}

export function mapNodeWithChild(app: FastifyInstance, userId: string, row: NodeRow): NodeDto {
  return mapNode(row, getChildPlanForNode(app, userId, row.id));
}

export function getNode(app: FastifyInstance, userId: string, nodeId: string): NodeRow & { archived_at: string | null } {
  return assertFound(app.database.sqlite.prepare(`SELECT n.*, p.archived_at FROM nodes n JOIN plans p ON p.id = n.plan_id
    JOIN areas a ON a.id = p.area_id WHERE n.id = ? AND a.user_id = ?`).get(nodeId, userId) as (NodeRow & { archived_at: string | null }) | undefined, '节点不存在');
}

export function ensureEditable(plan: PlanRow | { archived_at: string | null }): void {
  if (plan.archived_at) throw new AppError(409, 'PLAN_ARCHIVED', '归档计划为只读状态');
}

export function ensureVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new AppError(409, 'VERSION_CONFLICT', '数据已在其他页面更新，请刷新后重试', { currentVersion: actual });
}
