import type { FastifyInstance } from 'fastify';
import type { NodeStatus, PlanStatus } from '@sixplan/shared';
import { AppError } from './errors.js';

export function hasInProgressNode(app: FastifyInstance, planId: string): boolean {
  const row = app.database.sqlite.prepare("SELECT 1 AS value FROM nodes WHERE plan_id = ? AND status = 'in_progress' LIMIT 1")
    .get(planId) as { value: number } | undefined;
  return Boolean(row);
}

export function assertPlanningStatusAllowed(app: FastifyInstance, planId: string): void {
  if (hasInProgressNode(app, planId)) {
    throw new AppError(409, 'PLAN_HAS_ACTIVE_NODES', '该计划存在进行中的节点，请先调整节点状态');
  }
}

export function promotePlanningPlan(app: FastifyInstance, planId: string, now = new Date().toISOString()): boolean {
  const result = app.database.sqlite.prepare(`UPDATE plans SET status = 'active', version = version + 1, updated_at = ?
    WHERE id = ? AND archived_at IS NULL AND status = 'planning'
    AND EXISTS (SELECT 1 FROM nodes WHERE plan_id = plans.id AND status = 'in_progress')`).run(now, planId);
  return result.changes > 0;
}

export function normalizeImportedPlanStatus(status: PlanStatus, archivedAt: string | null,
  nodes: Array<{ status: NodeStatus }>): { status: PlanStatus; autoActivated: boolean } {
  const autoActivated = !archivedAt && status === 'planning' && nodes.some((node) => node.status === 'in_progress');
  return { status: autoActivated ? 'active' : status, autoActivated };
}
