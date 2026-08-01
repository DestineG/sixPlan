import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { PlanTreeChangeSetSchema, type ImportPreviewDto, type PlanTreeChangeSet } from '@sixplan/shared';
import { AppError } from './errors.js';
import { isDag } from './graph.js';
import { applyChangeSet, insertSnapshot, prepareChangeSet, validateSnapshotPayload } from './plan-transfer.js';
import { createLink, descendantPlanIds, getParentLink } from './plan-tree.js';
import { getPlan, mapPlan, type NodeRow } from './repository.js';

function currentPlans(app: FastifyInstance, userId: string, rootPlanId: string) {
  return descendantPlanIds(app, userId, rootPlanId, true).map((id) => getPlan(app, userId, id));
}

function fingerprint(plans: Array<{ plan_key: string; graph_revision: number }>): string {
  return createHash('sha256').update(plans.map((plan) => `${plan.plan_key}:${plan.graph_revision}`).sort().join('|')).digest('base64url');
}

function validateTreeChange(app: FastifyInstance, userId: string, rootPlanId: string, raw: unknown) {
  const change = PlanTreeChangeSetSchema.parse(raw); const plans = currentPlans(app, userId, rootPlanId);
  const planByKey = new Map(plans.map((plan) => [plan.plan_key, plan])); const root = getPlan(app, userId, rootPlanId);
  if (change.targetRootPlanKey !== root.plan_key) throw new AppError(409, 'TARGET_PLAN_MISMATCH', '计划树根计划 key 不匹配');
  const addedKeys = new Set<string>();
  for (const item of change.operations.addPlans) {
    if (planByKey.has(item.key) || addedKeys.has(item.key)) throw new AppError(409, 'PLAN_KEY_EXISTS', `计划 key 已存在：${item.key}`);
    if (item.plan.archivedAt) throw new AppError(400, 'AI_ARCHIVE_NOT_ALLOWED', 'AI 不能创建已归档计划');
    validateSnapshotPayload({ plan: item.plan, nodes: item.nodes, edges: item.edges }); addedKeys.add(item.key);
  }
  for (const item of change.operations.updatePlans) if (!planByKey.has(item.planKey)) {
    throw new AppError(409, 'PLAN_KEY_NOT_FOUND', `要更新的计划不存在：${item.planKey}`);
  }
  const baseByKey = new Map(change.baseRevisions.map((item) => [item.planKey, item.graphRevision]));
  const changedRevision = plans.some((plan) => baseByKey.get(plan.plan_key) !== plan.graph_revision);
  const knownKeys = new Set([...planByKey.keys(), ...addedKeys]);
  const links = app.database.sqlite.prepare(`SELECT pp.plan_key AS parent_plan_key,pn.node_key AS parent_node_key,cp.plan_key AS child_plan_key
    FROM plan_links l JOIN nodes pn ON pn.id=l.parent_node_id JOIN plans pp ON pp.id=pn.plan_id JOIN plans cp ON cp.id=l.child_plan_id
    WHERE pp.id IN (${plans.map(() => '?').join(',')})`).all(...plans.map((plan) => plan.id)) as Array<{ parent_plan_key: string; parent_node_key: string; child_plan_key: string }>;
  const removedLinkChildren = new Set(change.operations.removeLinks.map((link) => link.childPlanKey));
  for (const removed of removedLinkChildren) if (!links.some((link) => link.child_plan_key === removed)) {
    throw new AppError(409, 'PLAN_LINK_NOT_FOUND', `要解除的计划关联不存在：${removed}`);
  }
  for (const update of change.operations.updatePlans) for (const nodeKey of update.graph?.removeNodes ?? []) {
    const linked = links.find((link) => link.parent_plan_key === update.planKey && link.parent_node_key === nodeKey);
    if (linked && !removedLinkChildren.has(linked.child_plan_key)) throw new AppError(400, 'CHILD_PLAN_DECISION_REQUIRED', `删除父节点前必须显式解除子计划关联：${nodeKey}`);
  }
  const relationByChild = new Map(links.map((link) => [link.child_plan_key, link.parent_plan_key]));
  change.operations.removeLinks.forEach((item) => relationByChild.delete(item.childPlanKey));
  const occupiedParentNodes = new Set(links.filter((link) => !removedLinkChildren.has(link.child_plan_key))
    .map((link) => `${link.parent_plan_key}:${link.parent_node_key}`));
  for (const link of change.operations.addLinks) {
    if (![link.parentPlanKey, link.childPlanKey].every((key) => knownKeys.has(key))) throw new AppError(400, 'INVALID_PLAN_LINK', '计划关联引用了未知计划 key');
    if (relationByChild.has(link.childPlanKey)) throw new AppError(409, 'PLAN_ALREADY_HAS_PARENT', `计划已经有父节点：${link.childPlanKey}`);
    const parentToken = `${link.parentPlanKey}:${link.parentNodeKey}`;
    if (occupiedParentNodes.has(parentToken)) throw new AppError(409, 'NODE_ALREADY_HAS_CHILD', `父节点已经有关联子计划：${link.parentNodeKey}`);
    occupiedParentNodes.add(parentToken);
    relationByChild.set(link.childPlanKey, link.parentPlanKey);
  }
  for (const key of addedKeys) if (!relationByChild.has(key)) throw new AppError(400, 'NEW_PLAN_NOT_LINKED', `新增计划必须关联到计划树：${key}`);
  const relationEdges = [...relationByChild].map(([child, parent]) => ({ sourceNodeId: parent, targetNodeId: child }));
  if (!isDag([...knownKeys], relationEdges)) throw new AppError(409, 'PLAN_TREE_CYCLE', '计划关联会形成层级循环');
  return { change, plans, planByKey, baseByKey, changedRevision, fingerprint: fingerprint(plans) };
}

export function prepareTreeChangeSet(app: FastifyInstance, userId: string, rootPlanId: string, raw: unknown,
  sessionId: string, expiresAt: string): { change: PlanTreeChangeSet; preview: ImportPreviewDto } {
  const validated = validateTreeChange(app, userId, rootPlanId, raw);
  let addNodeCount = 0; let updateNodeCount = 0; let removeNodeCount = 0; let addEdgeCount = 0; let removeEdgeCount = 0;
  const previewNodes: ImportPreviewDto['previewNodes'] = [];
  for (const item of validated.change.operations.addPlans) {
    addNodeCount += item.nodes.length; addEdgeCount += item.edges.length;
    previewNodes.push(...item.nodes.slice(0, Math.max(0, 200 - previewNodes.length)).map((node) => ({ key: node.key, title: node.title, status: node.status, change: 'add' as const })));
  }
  for (const item of validated.change.operations.updatePlans) {
    const plan = validated.planByKey.get(item.planKey)!; const graph = item.graph;
    if (!graph) continue;
    const prepared = prepareChangeSet(app, userId, plan.id, { format: 'sixplan-plan-changeset', version: 2,
      targetPlanName: plan.name, baseRevision: validated.baseByKey.get(item.planKey) ?? plan.graph_revision,
      ...(item.planChanges ? { planChanges: item.planChanges } : {}), operations: graph });
    addNodeCount += prepared.preview.addNodeCount; updateNodeCount += prepared.preview.updateNodeCount;
    removeNodeCount += prepared.preview.removeNodeCount; addEdgeCount += prepared.preview.addEdgeCount; removeEdgeCount += prepared.preview.removeEdgeCount;
    previewNodes.push(...prepared.preview.previewNodes.slice(0, Math.max(0, 200 - previewNodes.length)));
  }
  const totalNodes = validated.plans.reduce((count, plan) => count + plan.node_count!, 0) + addNodeCount - removeNodeCount;
  const planIds = validated.plans.map((plan) => plan.id); const placeholders = planIds.map(() => '?').join(',');
  const currentEdgeCount = (app.database.sqlite.prepare(`SELECT COUNT(*) value FROM edges WHERE plan_id IN (${placeholders})`).get(...planIds) as { value: number }).value;
  return { change: validated.change, preview: { sessionId, kind: 'tree-changeset', planName: getPlan(app, userId, rootPlanId).name,
    revisionChanged: validated.changedRevision, treeFingerprint: validated.fingerprint,
    nodeCount: totalNodes, edgeCount: currentEdgeCount + addEdgeCount - removeEdgeCount, addNodeCount, updateNodeCount, removeNodeCount, addEdgeCount, removeEdgeCount,
    addPlanCount: validated.change.operations.addPlans.length, updatePlanCount: validated.change.operations.updatePlans.length,
    addLinkCount: validated.change.operations.addLinks.length, removeLinkCount: validated.change.operations.removeLinks.length,
    planCount: validated.plans.length + validated.change.operations.addPlans.length,
    linkCount: validated.plans.length - 1 + validated.change.operations.addLinks.length - validated.change.operations.removeLinks.length,
    needsLayout: validated.change.operations.addPlans.some((plan) => plan.nodes.some((node) => !node.position)), expiresAt,
    previewNodes, previewEdges: [] } };
}

export function applyTreeChangeSet(app: FastifyInstance, userId: string, rootPlanId: string, raw: unknown, confirmedFingerprint?: string) {
  const validated = validateTreeChange(app, userId, rootPlanId, raw);
  if (validated.changedRevision && confirmedFingerprint !== validated.fingerprint) {
    throw new AppError(409, 'TREE_REVISION_RECONFIRM_REQUIRED', '计划树已发生变化，请检查刷新后的预览并再次确认',
      { currentTreeFingerprint: validated.fingerprint });
  }
  return app.database.sqlite.transaction(() => {
    let autoActivatedPlanCount = 0;
    const idByKey = new Map(validated.plans.map((plan) => [plan.plan_key, plan.id]));
    for (const item of validated.change.operations.removeLinks) {
      const childId = idByKey.get(item.childPlanKey)!; const link = getParentLink(app, childId);
      if (!link) continue;
      const parentNode = app.database.sqlite.prepare('SELECT * FROM nodes WHERE id=?').get(link.parent_node_id) as NodeRow;
      const now = new Date().toISOString(); app.database.sqlite.prepare('DELETE FROM plan_links WHERE id=?').run(link.id);
      app.database.sqlite.prepare('UPDATE nodes SET version=version+1,updated_at=? WHERE id=?').run(now, parentNode.id);
      app.database.sqlite.prepare('UPDATE plans SET graph_revision=graph_revision+1,updated_at=? WHERE id=?').run(now, parentNode.plan_id);
    }
    for (const item of validated.change.operations.updatePlans) {
      const plan = validated.planByKey.get(item.planKey)!;
      const result = applyChangeSet(app, userId, plan.id, { format: 'sixplan-plan-changeset', version: 2,
        targetPlanName: plan.name, baseRevision: validated.baseByKey.get(item.planKey) ?? plan.graph_revision,
        ...(item.planChanges ? { planChanges: item.planChanges } : {}), operations: item.graph ?? {} },
        getPlan(app, userId, plan.id).graph_revision);
      if (result.autoActivated) autoActivatedPlanCount += 1;
    }
    const pending = new Map(validated.change.operations.addPlans.map((plan) => [plan.key, plan]));
    while (pending.size) {
      let progressed = false;
      for (const [key, item] of [...pending]) {
        const relation = validated.change.operations.addLinks.find((link) => link.childPlanKey === key);
        const parentId = relation ? idByKey.get(relation.parentPlanKey) : undefined;
        if (!relation || !parentId) continue;
        const parent = getPlan(app, userId, parentId);
        const imported = insertSnapshot(app, userId, parent.area_id, { plan: item.plan, nodes: item.nodes, edges: item.edges });
        idByKey.set(key, imported.plan.id); pending.delete(key); progressed = true;
        if (imported.autoActivated) autoActivatedPlanCount += 1;
      }
      if (!progressed) throw new AppError(400, 'INVALID_PLAN_TREE', '无法确定新增子计划的父级顺序');
    }
    for (const item of validated.change.operations.addLinks) {
      const parentId = idByKey.get(item.parentPlanKey)!; const childId = idByKey.get(item.childPlanKey)!;
      const node = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id=? AND node_key=?').get(parentId, item.parentNodeKey) as NodeRow | undefined;
      if (!node) throw new AppError(409, 'NODE_KEY_NOT_FOUND', `父节点不存在：${item.parentNodeKey}`);
      createLink(app, userId, node.id, childId, node.version);
    }
    return { plan: mapPlan(getPlan(app, userId, rootPlanId)), autoActivated: autoActivatedPlanCount > 0,
      autoActivatedPlanCount, planCount: idByKey.size };
  })();
}
