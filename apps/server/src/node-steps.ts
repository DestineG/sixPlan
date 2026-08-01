import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { NODE_STATUSES, type NodeStatus } from '@sixplan/shared';
import { z } from 'zod';
import { AppError } from './errors.js';
import { promotePlanningPlan } from './plan-status.js';
import { ensureEditable, ensureVersion, getNode, getNodeDto, getNodeSteps, getPlan, mapPlan, type NodeRow, type NodeStepRow } from './repository.js';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

export const replaceNodeStepsBody = z.object({
  expectedNodeVersion: z.number().int().positive(),
  steps: z.array(z.object({
    id: z.string().uuid().optional(),
    key: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
    title: z.string().trim().min(1).max(200),
    status: z.enum(NODE_STATUSES),
    startDate: dateOnly,
    endDate: dateOnly,
    summary: z.string().max(2000),
    expectedVersion: z.number().int().positive().optional()
  }).strict()).max(500)
}).strict();

export type ReplaceNodeStepsBody = z.infer<typeof replaceNodeStepsBody>;

export function validateStepDates(startDate: string | null, endDate: string | null, label: string): void {
  if (startDate && endDate && endDate < startDate) {
    throw new AppError(400, 'INVALID_DATE_RANGE', `${label}的结束日期不得早于开始日期`);
  }
}

export function aggregateStepStatus(current: NodeStatus, steps: Array<{ status: NodeStatus }>): NodeStatus {
  if (current === 'paused' || current === 'abandoned' || steps.length === 0) return current;
  if (steps.every((step) => step.status === 'completed')) return 'completed';
  if (steps.some((step) => step.status === 'in_progress' || step.status === 'completed')) return 'in_progress';
  return 'not_started';
}

export function updateNodeAggregate(app: FastifyInstance, node: NodeRow, steps: NodeStepRow[], now: string, bumpVersion = true): void {
  if (steps.length === 0) return;
  const starts = steps.map((step) => step.start_date).filter((value): value is string => Boolean(value));
  const ends = steps.map((step) => step.end_date).filter((value): value is string => Boolean(value));
  const startDate = starts.length ? starts.sort()[0]! : null;
  const endDate = ends.length ? ends.sort().at(-1)! : null;
  const status = aggregateStepStatus(node.status, steps);
  app.database.sqlite.prepare(`UPDATE nodes SET status=?,start_date=?,end_date=?,version=version+?,updated_at=? WHERE id=?`)
    .run(status, startDate, endDate, bumpVersion ? 1 : 0, now, node.id);
}

export function replaceNodeSteps(app: FastifyInstance, userId: string, nodeId: string, body: ReplaceNodeStepsBody) {
  const node = getNode(app, userId, nodeId);
  ensureEditable(node);
  ensureVersion(node.version, body.expectedNodeVersion);
  const existing = getNodeSteps(app, nodeId);
  const existingById = new Map(existing.map((step) => [step.id, step]));
  const keys = new Set<string>();
  for (const step of body.steps) {
    if (keys.has(step.key)) throw new AppError(409, 'STEP_KEY_EXISTS', `子阶段 key 重复：${step.key}`);
    keys.add(step.key);
    validateStepDates(step.startDate, step.endDate, `子阶段“${step.title}”`);
    if (step.id) {
      const current = existingById.get(step.id);
      if (!current) throw new AppError(404, 'STEP_NOT_FOUND', '子阶段不存在');
      if (step.expectedVersion === undefined) throw new AppError(400, 'EXPECTED_VERSION_REQUIRED', '已有子阶段必须携带版本号');
      ensureVersion(current.version, step.expectedVersion);
    } else if (step.expectedVersion !== undefined) {
      throw new AppError(400, 'INVALID_STEP_VERSION', '新增子阶段不能携带版本号');
    }
  }
  const now = new Date().toISOString();
  const result = app.database.sqlite.transaction(() => {
    const retained = new Set(body.steps.flatMap((step) => step.id ? [step.id] : []));
    const remove = app.database.sqlite.prepare('DELETE FROM node_steps WHERE id = ?');
    for (const step of existing) if (!retained.has(step.id)) remove.run(step.id);
    const update = app.database.sqlite.prepare(`UPDATE node_steps SET step_key=?,title=?,status=?,start_date=?,end_date=?,summary=?,sort_order=?,version=version+1,updated_at=? WHERE id=?`);
    const insert = app.database.sqlite.prepare(`INSERT INTO node_steps
      (id,node_id,step_key,title,status,start_date,end_date,summary,sort_order,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`);
    body.steps.forEach((step, index) => {
      if (step.id) update.run(step.key, step.title, step.status, step.startDate, step.endDate, step.summary, index, now, step.id);
      else insert.run(randomUUID(), nodeId, step.key, step.title, step.status, step.startDate, step.endDate, step.summary, index, now, now);
    });
    const nextSteps = getNodeSteps(app, nodeId);
    if (nextSteps.length) updateNodeAggregate(app, node, nextSteps, now);
    else app.database.sqlite.prepare('UPDATE nodes SET version=version+1,updated_at=? WHERE id=?').run(now, nodeId);
    app.database.sqlite.prepare('UPDATE plans SET graph_revision=graph_revision+1 WHERE id=?').run(node.plan_id);
    const autoActivated = promotePlanningPlan(app, node.plan_id, now);
    return { node: getNodeDto(app, userId, nodeId), plan: mapPlan(getPlan(app, userId, node.plan_id)), autoActivated };
  })();
  return result;
}
