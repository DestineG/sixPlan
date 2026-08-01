import type { AreaDto, EdgeDto, NodeDto, NodeStepDto, PlanDto } from '@sixplan/shared';
import type { FastifyInstance } from 'fastify';
import { AppError, assertFound } from './errors.js';

export interface AreaRow {
  id: string; user_id: string; name: string; name_normalized: string; sort_order: number;
  version: number; created_at: string; updated_at: string; plan_count?: number; active_plan_count?: number; archived_plan_count?: number;
}
export interface PlanRow {
  id: string; area_id: string; area_name: string; user_id: string; name: string; description: string;
  status: PlanDto['status']; archived_at: string | null; version: number; graph_revision: number; created_at: string; updated_at: string; node_count?: number;
}
export interface NodeRow {
  id: string; plan_id: string; node_key: string; title: string; status: NodeDto['status']; start_date: string | null; end_date: string | null;
  summary: string; extra_content: string; position_x: number; position_y: number; version: number; created_at: string; updated_at: string;
}
export interface EdgeRow {
  id: string; plan_id: string; source_node_id: string; target_node_id: string; version: number; created_at: string; updated_at: string;
}

export interface PlanInsertRecord {
  id: string; areaId: string; name: string; description: string; status: PlanDto['status']; archivedAt: string | null;
  version: number; graphRevision: number; createdAt: string; updatedAt: string;
}
export interface NodeStepRow {
  id: string; node_id: string; step_key: string; title: string; status: NodeStepDto['status'];
  start_date: string | null; end_date: string | null; summary: string; sort_order: number;
  version: number; created_at: string; updated_at: string;
}

export function mapArea(row: AreaRow): AreaDto {
  return { id: row.id, name: row.name, sortOrder: row.sort_order, version: row.version,
    planCount: row.plan_count ?? 0, activePlanCount: row.active_plan_count ?? 0, archivedPlanCount: row.archived_plan_count ?? 0,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapPlan(row: PlanRow): PlanDto {
  return { id: row.id, areaId: row.area_id, areaName: row.area_name, name: row.name, description: row.description,
    status: row.status, archivedAt: row.archived_at, version: row.version, graphRevision: row.graph_revision, nodeCount: row.node_count ?? 0,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapNodeStep(row: NodeStepRow): NodeStepDto {
  return { id: row.id, nodeId: row.node_id, key: row.step_key, title: row.title, status: row.status,
    startDate: row.start_date, endDate: row.end_date, summary: row.summary, sortOrder: row.sort_order,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function mapNode(row: NodeRow, steps: NodeStepRow[] = []): NodeDto {
  return { id: row.id, planId: row.plan_id, key: row.node_key, title: row.title, status: row.status, startDate: row.start_date,
    endDate: row.end_date, summary: row.summary, extraContent: row.extra_content, positionX: row.position_x,
    positionY: row.position_y, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    steps: steps.map(mapNodeStep) };
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
    (SELECT COUNT(*) FROM nodes n WHERE n.plan_id = p.id) AS node_count
    FROM plans p JOIN areas a ON a.id = p.area_id WHERE p.id = ? AND a.user_id = ?`).get(planId, userId) as PlanRow | undefined, '计划不存在');
}

export function getNode(app: FastifyInstance, userId: string, nodeId: string): NodeRow & { archived_at: string | null } {
  return assertFound(app.database.sqlite.prepare(`SELECT n.*, p.archived_at FROM nodes n JOIN plans p ON p.id = n.plan_id
    JOIN areas a ON a.id = p.area_id WHERE n.id = ? AND a.user_id = ?`).get(nodeId, userId) as (NodeRow & { archived_at: string | null }) | undefined, '节点不存在');
}

export function getNodeSteps(app: FastifyInstance, nodeId: string): NodeStepRow[] {
  return app.database.sqlite.prepare('SELECT * FROM node_steps WHERE node_id = ? ORDER BY sort_order, created_at')
    .all(nodeId) as NodeStepRow[];
}

export function getNodeDto(app: FastifyInstance, userId: string, nodeId: string): NodeDto {
  const node = getNode(app, userId, nodeId);
  return mapNode(node, getNodeSteps(app, nodeId));
}

export function insertPlanRecord(app: FastifyInstance, record: PlanInsertRecord): void {
  const hasPlanKey = (app.database.sqlite.prepare('PRAGMA table_info(plans)').all() as Array<{ name: string }>).some((column) => column.name === 'plan_key');
  if (hasPlanKey) {
    const planKey = `plan-${record.id.replaceAll('-', '').slice(0, 12).toLowerCase()}`;
    app.database.sqlite.prepare(`INSERT INTO plans
      (id,area_id,plan_key,name,description,status,archived_at,version,graph_revision,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.areaId, planKey, record.name, record.description, record.status,
        record.archivedAt, record.version, record.graphRevision, record.createdAt, record.updatedAt);
    return;
  }
  app.database.sqlite.prepare(`INSERT INTO plans
    (id,area_id,name,description,status,archived_at,version,graph_revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(record.id, record.areaId, record.name, record.description, record.status,
      record.archivedAt, record.version, record.graphRevision, record.createdAt, record.updatedAt);
}

export function ensureEditable(plan: PlanRow | { archived_at: string | null }): void {
  if (plan.archived_at) throw new AppError(409, 'PLAN_ARCHIVED', '归档计划为只读状态');
}

export function ensureVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new AppError(409, 'VERSION_CONFLICT', '数据已在其他页面更新，请刷新后重试', { currentVersion: actual });
}
