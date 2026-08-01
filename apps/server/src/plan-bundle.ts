import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PlanBundleSchema, type PlanBundle } from '@sixplan/shared';
import { AppError } from './errors.js';
import { isDag } from './graph.js';
import { descendantPlanIds } from './plan-tree.js';
import { createSnapshotPayload, insertSnapshot, validateSnapshotPayload } from './plan-transfer.js';
import { getArea, getPlan, mapPlan } from './repository.js';

export function validatePlanBundle(input: unknown): PlanBundle {
  const bundle = PlanBundleSchema.parse(input);
  const planKeys = bundle.plans.map((plan) => plan.key);
  if (new Set(planKeys).size !== planKeys.length) throw new AppError(400, 'DUPLICATE_PLAN_KEY', '计划包包含重复计划 key');
  if (!planKeys.includes(bundle.rootPlanKey)) throw new AppError(400, 'ROOT_PLAN_NOT_FOUND', '计划包根计划不存在');
  const planByKey = new Map(bundle.plans.map((plan) => [plan.key, plan]));
  bundle.plans.forEach((plan) => validateSnapshotPayload({ plan: plan.plan, nodes: plan.nodes, edges: plan.edges }));
  const parentNodes = new Set<string>(); const children = new Set<string>();
  for (const link of bundle.links) {
    const parent = planByKey.get(link.parentPlanKey);
    if (!parent || !planByKey.has(link.childPlanKey)) throw new AppError(400, 'INVALID_PLAN_LINK', '计划包关联引用了不存在的计划');
    if (!parent.nodes.some((node) => node.key === link.parentNodeKey)) throw new AppError(400, 'INVALID_PLAN_LINK', '计划包关联引用了不存在的父节点');
    const parentToken = `${link.parentPlanKey}:${link.parentNodeKey}`;
    if (parentNodes.has(parentToken) || children.has(link.childPlanKey)) throw new AppError(400, 'DUPLICATE_PLAN_LINK', '一个节点或子计划不能重复关联');
    parentNodes.add(parentToken); children.add(link.childPlanKey);
  }
  if (children.has(bundle.rootPlanKey) || bundle.plans.some((plan) => plan.key !== bundle.rootPlanKey && !children.has(plan.key))) {
    throw new AppError(400, 'INVALID_PLAN_TREE', '计划包必须有且只有一个根计划');
  }
  if (!isDag(planKeys, bundle.links.map((link) => ({ sourceNodeId: link.parentPlanKey, targetNodeId: link.childPlanKey })))) {
    throw new AppError(400, 'PLAN_TREE_CYCLE', '计划包包含计划层级循环');
  }
  return bundle;
}

export function createPlanBundle(app: FastifyInstance, userId: string, rootPlanId: string): PlanBundle {
  const ids = descendantPlanIds(app, userId, rootPlanId, true);
  const plans = ids.map((id) => getPlan(app, userId, id)); const keyById = new Map(plans.map((plan) => [plan.id, plan.plan_key]));
  const placeholders = ids.map(() => '?').join(',');
  const linkRows = app.database.sqlite.prepare(`SELECT pn.plan_id AS parent_plan_id,pn.node_key,l.child_plan_id
    FROM plan_links l JOIN nodes pn ON pn.id=l.parent_node_id
    WHERE pn.plan_id IN (${placeholders}) AND l.child_plan_id IN (${placeholders}) ORDER BY l.created_at`).all(...ids, ...ids) as
    Array<{ parent_plan_id: string; node_key: string; child_plan_id: string }>;
  return {
    format: 'sixplan-plan-bundle', version: 1, exportedAt: new Date().toISOString(), rootPlanKey: getPlan(app, userId, rootPlanId).plan_key,
    plans: plans.map((plan) => ({ key: plan.plan_key, areaName: plan.area_name, ...createSnapshotPayload(app, userId, plan.id) })),
    links: linkRows.map((link) => ({ parentPlanKey: keyById.get(link.parent_plan_id)!, parentNodeKey: link.node_key,
      childPlanKey: keyById.get(link.child_plan_id)! }))
  };
}

export interface BundleAreaDecision { sourceAreaName: string; targetAreaId?: string; createAreaName?: string; }

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

export function importPlanBundle(app: FastifyInstance, userId: string, input: unknown,
  options: { targetAreaId?: string; decisions?: BundleAreaDecision[] }) {
  const bundle = validatePlanBundle(input);
  return app.database.sqlite.transaction(() => {
    const areaBySource = new Map<string, string>();
    if (options.targetAreaId) {
      getArea(app, userId, options.targetAreaId);
      bundle.plans.forEach((plan) => areaBySource.set(plan.areaName, options.targetAreaId!));
    } else {
      const decisions = new Map((options.decisions ?? []).map((decision) => [decision.sourceAreaName, decision]));
      for (const source of new Set(bundle.plans.map((plan) => plan.areaName))) {
        const decision = decisions.get(source);
        if (!decision) throw new AppError(400, 'AREA_DECISION_REQUIRED', `需要处理领域：${source}`);
        const areaId = decision.targetAreaId ?? (decision.createAreaName ? createArea(app, userId, decision.createAreaName) : undefined);
        if (!areaId) throw new AppError(400, 'AREA_DECISION_REQUIRED', `需要处理领域：${source}`);
        getArea(app, userId, areaId); areaBySource.set(source, areaId);
      }
    }
    const importedByKey = new Map<string, { id: string; autoActivated: boolean }>();
    for (const item of bundle.plans) {
      const imported = insertSnapshot(app, userId, areaBySource.get(item.areaName)!, { plan: item.plan, nodes: item.nodes, edges: item.edges });
      importedByKey.set(item.key, { id: imported.plan.id, autoActivated: imported.autoActivated });
    }
    const now = new Date().toISOString();
    for (const link of bundle.links) {
      const parentId = importedByKey.get(link.parentPlanKey)!.id; const childId = importedByKey.get(link.childPlanKey)!.id;
      const node = app.database.sqlite.prepare('SELECT id FROM nodes WHERE plan_id=? AND node_key=?').get(parentId, link.parentNodeKey) as { id: string };
      app.database.sqlite.prepare(`INSERT INTO plan_links (id,parent_node_id,child_plan_id,version,created_at,updated_at) VALUES (?,?,?,1,?,?)`)
        .run(randomUUID(), node.id, childId, now, now);
    }
    const root = getPlan(app, userId, importedByKey.get(bundle.rootPlanKey)!.id);
    return { plan: mapPlan(root), planCount: bundle.plans.length, linkCount: bundle.links.length,
      autoActivatedPlanCount: [...importedByKey.values()].filter((plan) => plan.autoActivated).length };
  })();
}
