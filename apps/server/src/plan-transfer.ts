import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  PlanChangeSetSchema, PlanSnapshotPayloadSchema, PlanSnapshotSchema,
  type ImportPreviewDto, type PlanChangeSet, type PlanSnapshot, type PlanSnapshotNode, type PlanSnapshotPayload
} from '@sixplan/shared';
import { AppError } from './errors.js';
import { isDag } from './graph.js';
import { normalizeImportedPlanStatus, promotePlanningPlan } from './plan-status.js';
import { getPlan, mapPlan, type EdgeRow, type NodeRow } from './repository.js';

function validDateOnly(value: string | null): boolean {
  if (!value) return true;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

function isAfter(left?: string, right?: string): boolean {
  return Boolean(left && right && new Date(left).getTime() > new Date(right).getTime());
}

export function validateSnapshotPayload(input: unknown): PlanSnapshotPayload {
  const payload = PlanSnapshotPayloadSchema.parse(input);
  const keys = new Set<string>();
  for (const node of payload.nodes) {
    if (keys.has(node.key)) throw new AppError(400, 'DUPLICATE_NODE_KEY', `节点 key 重复：${node.key}`);
    keys.add(node.key);
    if (!validDateOnly(node.startDate) || !validDateOnly(node.endDate)) {
      throw new AppError(400, 'INVALID_DATE', `节点 ${node.key} 包含不存在的日期`);
    }
    if (node.startDate && node.endDate && node.endDate < node.startDate) {
      throw new AppError(400, 'INVALID_DATE_RANGE', `节点 ${node.key} 的结束日期不得早于开始日期`);
    }
    if (isAfter(node.createdAt, node.updatedAt)) {
      throw new AppError(400, 'INVALID_TIMESTAMP_RANGE', `节点 ${node.key} 的修改时间不得早于创建时间`);
    }
  }
  if (isAfter(payload.plan.createdAt, payload.plan.updatedAt)) {
    throw new AppError(400, 'INVALID_TIMESTAMP_RANGE', '计划修改时间不得早于创建时间');
  }
  const directions = new Set<string>();
  for (const edge of payload.edges) {
    if (!keys.has(edge.source) || !keys.has(edge.target)) {
      throw new AppError(400, 'INVALID_EDGE_REFERENCE', `连接 ${edge.source} → ${edge.target} 引用了不存在的节点`);
    }
    if (edge.source === edge.target) throw new AppError(400, 'SELF_EDGE', `节点 ${edge.source} 不能连接到自身`);
    const direction = `${edge.source}:${edge.target}`;
    if (directions.has(direction)) throw new AppError(400, 'DUPLICATE_EDGE', `连接重复：${edge.source} → ${edge.target}`);
    directions.add(direction);
  }
  if (!isDag([...keys], payload.edges.map((edge) => ({ sourceNodeId: edge.source, targetNodeId: edge.target })))) {
    throw new AppError(400, 'CYCLE_DETECTED', '导入文件中的连接形成了有向环');
  }
  return payload;
}

export function validateSnapshot(input: unknown): PlanSnapshot {
  const snapshot = PlanSnapshotSchema.parse(input);
  validateSnapshotPayload({ plan: snapshot.plan, nodes: snapshot.nodes, edges: snapshot.edges });
  return snapshot;
}

export function layoutSnapshot(payload: PlanSnapshotPayload): PlanSnapshotPayload {
  if (payload.nodes.every((node) => node.position)) return payload;
  const incoming = new Map(payload.nodes.map((node) => [node.key, 0]));
  const outgoing = new Map(payload.nodes.map((node) => [node.key, [] as string[]]));
  for (const edge of payload.edges) {
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }
  const queue = [...incoming].filter(([, count]) => count === 0).map(([key]) => key);
  const rank = new Map(queue.map((key) => [key, 0]));
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index]!;
    for (const target of outgoing.get(key)!) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(key) ?? 0) + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const rows = new Map<number, number>();
  return {
    ...payload,
    nodes: payload.nodes.map((node) => {
      const column = rank.get(node.key) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return { ...node, position: { x: 100 + column * 300, y: 100 + row * 170 } };
    })
  };
}

export function createSnapshotPayload(app: FastifyInstance, userId: string, planId: string): PlanSnapshotPayload {
  const plan = getPlan(app, userId, planId);
  const nodes = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id = ? ORDER BY created_at').all(planId) as NodeRow[];
  const edges = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id = ? ORDER BY created_at').all(planId) as EdgeRow[];
  const keys = new Map(nodes.map((node) => [node.id, node.node_key]));
  return {
    plan: { name: plan.name, description: plan.description, status: plan.status, archivedAt: plan.archived_at,
      createdAt: plan.created_at, updatedAt: plan.updated_at },
    nodes: nodes.map((node) => ({ key: node.node_key, title: node.title, status: node.status, startDate: node.start_date,
      endDate: node.end_date, summary: node.summary, markdown: node.extra_content,
      position: { x: node.position_x, y: node.position_y }, createdAt: node.created_at, updatedAt: node.updated_at })),
    edges: edges.map((edge) => ({ source: keys.get(edge.source_node_id)!, target: keys.get(edge.target_node_id)!,
      createdAt: edge.created_at, updatedAt: edge.updated_at }))
  };
}

export function createSnapshot(app: FastifyInstance, userId: string, planId: string): PlanSnapshot {
  const plan = getPlan(app, userId, planId);
  return { format: 'sixplan-plan-snapshot', version: 2, exportedAt: new Date().toISOString(), areaName: plan.area_name,
    ...createSnapshotPayload(app, userId, planId) };
}

export function insertSnapshot(app: FastifyInstance, userId: string, areaId: string, rawPayload: PlanSnapshotPayload) {
  const payload = layoutSnapshot(validateSnapshotPayload(rawPayload));
  const normalized = normalizeImportedPlanStatus(payload.plan.status, payload.plan.archivedAt, payload.nodes);
  const planId = randomUUID();
  const now = new Date().toISOString();
  const createdAt = payload.plan.createdAt ?? now;
  const updatedAt = payload.plan.updatedAt ?? createdAt;
  app.database.sqlite.prepare(`INSERT INTO plans
    (id,area_id,name,description,status,archived_at,version,graph_revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,1,1,?,?)`).run(planId, areaId, payload.plan.name, payload.plan.description, normalized.status,
      payload.plan.archivedAt, createdAt, updatedAt);
  const idByKey = new Map<string, string>();
  const insertNode = app.database.sqlite.prepare(`INSERT INTO nodes
    (id,plan_id,node_key,title,status,start_date,end_date,summary,extra_content,position_x,position_y,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  for (const node of payload.nodes) {
    const id = randomUUID();
    idByKey.set(node.key, id);
    const nodeCreated = node.createdAt ?? now;
    insertNode.run(id, planId, node.key, node.title, node.status, node.startDate, node.endDate, node.summary, node.markdown,
      node.position!.x, node.position!.y, nodeCreated, node.updatedAt ?? nodeCreated);
  }
  const insertEdge = app.database.sqlite.prepare(`INSERT INTO edges
    (id,plan_id,source_node_id,target_node_id,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`);
  for (const edge of payload.edges) {
    const edgeCreated = edge.createdAt ?? now;
    insertEdge.run(randomUUID(), planId, idByKey.get(edge.source), idByKey.get(edge.target), edgeCreated, edge.updatedAt ?? edgeCreated);
  }
  return { plan: mapPlan(getPlan(app, userId, planId)), autoActivated: normalized.autoActivated };
}

interface PreparedChangeSet {
  changeSet: PlanChangeSet;
  preview: ImportPreviewDto;
  currentRevision: number;
  nodes: Map<string, PlanSnapshotNode>;
  edges: Set<string>;
}

function edgeToken(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

function splitEdgeToken(value: string): { source: string; target: string } {
  const [source, target] = value.split('\u0000');
  return { source: source!, target: target! };
}

function assertUnique(values: string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) throw new AppError(400, code, message);
}

export function prepareChangeSet(
  app: FastifyInstance,
  userId: string,
  planId: string,
  input: unknown,
  sessionId = '',
  expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
): PreparedChangeSet {
  const changeSet = PlanChangeSetSchema.parse(input);
  const plan = getPlan(app, userId, planId);
  if (plan.archived_at) throw new AppError(409, 'PLAN_ARCHIVED', '归档计划只读，无法应用增量变更');
  if (changeSet.targetPlanName && changeSet.targetPlanName !== plan.name) {
    throw new AppError(409, 'TARGET_PLAN_MISMATCH', `增量文件指定的计划“${changeSet.targetPlanName}”与所选计划不一致`);
  }
  const currentNodes = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id = ? ORDER BY created_at').all(planId) as NodeRow[];
  const currentEdges = app.database.sqlite.prepare('SELECT * FROM edges WHERE plan_id = ? ORDER BY created_at').all(planId) as EdgeRow[];
  const keyById = new Map(currentNodes.map((node) => [node.id, node.node_key]));
  const nodes = new Map<string, PlanSnapshotNode>(currentNodes.map((node) => [node.node_key, {
    key: node.node_key, title: node.title, status: node.status, startDate: node.start_date, endDate: node.end_date,
    summary: node.summary, markdown: node.extra_content, position: { x: node.position_x, y: node.position_y },
    createdAt: node.created_at, updatedAt: node.updated_at
  }]));
  const edges = new Set(currentEdges.map((edge) => edgeToken(keyById.get(edge.source_node_id)!, keyById.get(edge.target_node_id)!)));
  const originalEdges = new Set(edges);
  const operations = changeSet.operations;
  assertUnique(operations.addNodes.map((node) => node.key), 'DUPLICATE_OPERATION', '新增节点列表包含重复 key');
  assertUnique(operations.updateNodes.map((node) => node.key), 'DUPLICATE_OPERATION', '更新节点列表包含重复 key');
  assertUnique(operations.removeNodes, 'DUPLICATE_OPERATION', '删除节点列表包含重复 key');
  assertUnique(operations.addEdges.map((edge) => edgeToken(edge.source, edge.target)), 'DUPLICATE_OPERATION', '新增连接列表包含重复项');
  assertUnique(operations.removeEdges.map((edge) => edgeToken(edge.source, edge.target)), 'DUPLICATE_OPERATION', '删除连接列表包含重复项');

  const touched = new Set<string>();
  for (const key of operations.removeNodes) {
    if (!nodes.has(key)) throw new AppError(409, 'NODE_KEY_NOT_FOUND', `要删除的节点不存在：${key}`);
    if (touched.has(key)) throw new AppError(400, 'CONFLICTING_OPERATION', `节点 ${key} 同时出现在多个操作中`);
    touched.add(key);
  }
  for (const update of operations.updateNodes) {
    const node = nodes.get(update.key);
    if (!node) throw new AppError(409, 'NODE_KEY_NOT_FOUND', `要更新的节点不存在：${update.key}`);
    if (touched.has(update.key)) throw new AppError(400, 'CONFLICTING_OPERATION', `节点 ${update.key} 同时出现在多个操作中`);
    touched.add(update.key);
    nodes.set(update.key, { ...node, ...update.changes });
  }
  for (const node of operations.addNodes) {
    if (nodes.has(node.key)) throw new AppError(409, 'NODE_KEY_EXISTS', `节点 key 已存在：${node.key}`);
    if (touched.has(node.key)) throw new AppError(400, 'CONFLICTING_OPERATION', `节点 ${node.key} 同时出现在多个操作中`);
    touched.add(node.key);
    nodes.set(node.key, node);
  }
  for (const edge of operations.removeEdges) {
    const token = edgeToken(edge.source, edge.target);
    if (!edges.has(token)) throw new AppError(409, 'EDGE_NOT_FOUND', `要删除的连接不存在：${edge.source} -> ${edge.target}`);
    edges.delete(token);
  }
  for (const key of operations.removeNodes) {
    nodes.delete(key);
    for (const token of [...edges]) {
      const edge = splitEdgeToken(token);
      if (edge.source === key || edge.target === key) edges.delete(token);
    }
  }
  for (const edge of operations.addEdges) {
    const token = edgeToken(edge.source, edge.target);
    if (edges.has(token)) throw new AppError(409, 'DUPLICATE_EDGE', `连接已存在：${edge.source} -> ${edge.target}`);
    edges.add(token);
  }

  const finalPayload: PlanSnapshotPayload = {
    plan: {
      name: changeSet.planChanges?.name ?? plan.name,
      description: changeSet.planChanges?.description ?? plan.description,
      status: changeSet.planChanges?.status ?? plan.status,
      archivedAt: null
    },
    nodes: [...nodes.values()],
    edges: [...edges].map(splitEdgeToken)
  };
  validateSnapshotPayload(finalPayload);
  const changedKeys = new Set(operations.updateNodes.map((node) => node.key));
  const removedKeys = new Set(operations.removeNodes);
  const addedKeys = new Set(operations.addNodes.map((node) => node.key));
  const previewNodes = [
    ...currentNodes.filter((node) => removedKeys.has(node.node_key)).map((node) => ({ key: node.node_key, title: node.title, status: node.status, change: 'remove' as const })),
    ...[...nodes.values()].filter((node) => addedKeys.has(node.key) || changedKeys.has(node.key)).map((node) => ({
      key: node.key, title: node.title, status: node.status, change: addedKeys.has(node.key) ? 'add' as const : 'update' as const
    }))
  ].slice(0, 200);
  const removedEdges = [...originalEdges].filter((token) => !edges.has(token)).map(splitEdgeToken);
  const previewEdges = [
    ...removedEdges.map((edge) => ({ ...edge, change: 'remove' as const })),
    ...operations.addEdges.map((edge) => ({ ...edge, change: 'add' as const }))
  ].slice(0, 300);
  return {
    changeSet,
    currentRevision: plan.graph_revision,
    nodes,
    edges,
    preview: {
      sessionId, kind: 'changeset', planName: changeSet.planChanges?.name ?? plan.name,
      baseRevision: changeSet.baseRevision, currentRevision: plan.graph_revision, revisionChanged: changeSet.baseRevision !== plan.graph_revision,
      nodeCount: nodes.size, edgeCount: edges.size, addNodeCount: operations.addNodes.length,
      updateNodeCount: operations.updateNodes.length, removeNodeCount: operations.removeNodes.length,
      addEdgeCount: operations.addEdges.length, removeEdgeCount: removedEdges.length,
      needsLayout: operations.addNodes.some((node) => !node.position), expiresAt, previewNodes, previewEdges
    }
  };
}

function placeNewNodes(prepared: PreparedChangeSet, currentNodes: NodeRow[]): Map<string, { x: number; y: number }> {
  const positions = new Map(currentNodes.map((node) => [node.node_key, { x: node.position_x, y: node.position_y }]));
  const incoming = new Map<string, string[]>();
  for (const token of prepared.edges) {
    const edge = splitEdgeToken(token);
    const list = incoming.get(edge.target) ?? [];
    list.push(edge.source);
    incoming.set(edge.target, list);
  }
  let fallbackRow = 0;
  for (const node of prepared.changeSet.operations.addNodes) {
    if (node.position) { positions.set(node.key, node.position); continue; }
    const predecessors = (incoming.get(node.key) ?? []).map((key) => positions.get(key)).filter(Boolean) as Array<{ x: number; y: number }>;
    const x = predecessors.length ? Math.max(...predecessors.map((position) => position.x)) + 300 : 100;
    const y = predecessors.length ? predecessors.reduce((sum, position) => sum + position.y, 0) / predecessors.length : 100 + fallbackRow++ * 170;
    let candidate = { x, y };
    while ([...positions.values()].some((position) => Math.abs(position.x - candidate.x) < 80 && Math.abs(position.y - candidate.y) < 80)) {
      candidate = { x, y: candidate.y + 170 };
    }
    positions.set(node.key, candidate);
  }
  return positions;
}

export function applyChangeSet(app: FastifyInstance, userId: string, planId: string, input: unknown, confirmedRevision?: number) {
  return app.database.sqlite.transaction(() => {
    const prepared = prepareChangeSet(app, userId, planId, input);
    if (prepared.changeSet.baseRevision !== prepared.currentRevision && confirmedRevision !== prepared.currentRevision) {
      throw new AppError(409, 'REVISION_RECONFIRM_REQUIRED', '计划图已发生变化，已按最新数据重新验证，请检查预览后再次确认', prepared.preview);
    }
    const plan = getPlan(app, userId, planId);
    const currentNodes = app.database.sqlite.prepare('SELECT * FROM nodes WHERE plan_id = ?').all(planId) as NodeRow[];
    const nodeByKey = new Map(currentNodes.map((node) => [node.node_key, node]));
    const positions = placeNewNodes(prepared, currentNodes);
    const now = new Date().toISOString();
    const operations = prepared.changeSet.operations;

    for (const edge of operations.removeEdges) {
      const source = nodeByKey.get(edge.source)!; const target = nodeByKey.get(edge.target)!;
      app.database.sqlite.prepare('DELETE FROM edges WHERE plan_id = ? AND source_node_id = ? AND target_node_id = ?').run(planId, source.id, target.id);
    }
    for (const key of operations.removeNodes) app.database.sqlite.prepare('DELETE FROM nodes WHERE id = ?').run(nodeByKey.get(key)!.id);
    for (const update of operations.updateNodes) {
      const row = nodeByKey.get(update.key)!; const changes = update.changes;
      app.database.sqlite.prepare(`UPDATE nodes SET title=?,status=?,start_date=?,end_date=?,summary=?,extra_content=?,position_x=?,position_y=?,version=version+1,updated_at=? WHERE id=?`)
        .run(changes.title ?? row.title, changes.status ?? row.status, changes.startDate === undefined ? row.start_date : changes.startDate,
          changes.endDate === undefined ? row.end_date : changes.endDate, changes.summary ?? row.summary, changes.markdown ?? row.extra_content,
          changes.position?.x ?? row.position_x, changes.position?.y ?? row.position_y, now, row.id);
    }
    const insertNode = app.database.sqlite.prepare(`INSERT INTO nodes
      (id,plan_id,node_key,title,status,start_date,end_date,summary,extra_content,position_x,position_y,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
    for (const node of operations.addNodes) {
      const id = randomUUID(); const createdAt = node.createdAt ?? now; const position = positions.get(node.key)!;
      insertNode.run(id, planId, node.key, node.title, node.status, node.startDate, node.endDate, node.summary, node.markdown,
        position.x, position.y, createdAt, node.updatedAt ?? createdAt);
      nodeByKey.set(node.key, { id, plan_id: planId, node_key: node.key, title: node.title, status: node.status,
        start_date: node.startDate, end_date: node.endDate, summary: node.summary, extra_content: node.markdown,
        position_x: position.x, position_y: position.y, version: 1, created_at: createdAt, updated_at: node.updatedAt ?? createdAt });
    }
    const insertEdge = app.database.sqlite.prepare(`INSERT INTO edges
      (id,plan_id,source_node_id,target_node_id,version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)`);
    for (const edge of operations.addEdges) insertEdge.run(randomUUID(), planId, nodeByKey.get(edge.source)!.id, nodeByKey.get(edge.target)!.id, now, now);

    const structural = operations.addNodes.length + operations.removeNodes.length + operations.addEdges.length + operations.removeEdges.length > 0;
    const metadata = prepared.changeSet.planChanges;
    if (metadata || structural) {
      app.database.sqlite.prepare(`UPDATE plans SET name=?,description=?,status=?,version=version+?,graph_revision=graph_revision+?,updated_at=? WHERE id=?`)
        .run(metadata?.name ?? plan.name, metadata?.description ?? plan.description, metadata?.status ?? plan.status,
          metadata ? 1 : 0, structural ? 1 : 0, now, planId);
    }
    const autoActivated = promotePlanningPlan(app, planId, now);
    return { plan: mapPlan(getPlan(app, userId, planId)), autoActivated };
  })();
}
