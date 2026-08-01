import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { ActivePlanDto, AreaDto, AreaFile, EdgeDto, GraphDto, ImportResult, NodeDto, PlanDto } from '@sixplan/shared';
import { collectBackup, decodeBackup, encodeBackup, restoreSiteBackup, restoreUserBackup } from './backup.js';
import { createUser } from './auth.js';

describe('sixPlan API', () => {
  let app: FastifyInstance; let directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'sixplan-test-'));
    app = await buildApp({ host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.db'), backupDir: directory, exportDir: directory,
      isProduction: false, cookieSecure: 'auto', trustedProxy: '127.0.0.1', allowOpenDataDir: false });
    await app.ready();
  });
  afterEach(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });

  async function register(username: string) {
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password123' } });
    expect(response.statusCode).toBe(201);
    const setCookie = response.headers['set-cookie']!;
    return (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(';')[0]!;
  }
  async function request(cookie: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: Record<string, unknown>): Promise<InjectResponse> {
    const options: InjectOptions = { method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) };
    return app.inject(options);
  }

  it('supports the core plan lifecycle and enforces DAG constraints', async () => {
    const cookie = await register('alice');
    const areaResponse = await request(cookie, 'POST', '/api/areas', { name: '工作' });
    expect(areaResponse.statusCode).toBe(201); const area = areaResponse.json<{ area: AreaDto }>().area;
    const planResponse = await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '实习准备', description: '', status: 'planning' });
    const plan = planResponse.json<{ plan: PlanDto }>().plan;
    const nodeA = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: 'A', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    const nodeB = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: 'B', positionX: 200, positionY: 0 })).json<{ node: NodeDto }>().node;
    const edgeResponse = await request(cookie, 'POST', `/api/plans/${plan.id}/edges`, { sourceNodeId: nodeA.id, targetNodeId: nodeB.id });
    expect(edgeResponse.statusCode).toBe(201); expect(edgeResponse.json<{ edge: EdgeDto }>().edge.sourceNodeId).toBe(nodeA.id);
    expect((await request(cookie, 'POST', `/api/plans/${plan.id}/edges`, { sourceNodeId: nodeB.id, targetNodeId: nodeA.id })).json()).toMatchObject({ code: 'CYCLE_DETECTED' });
    const archive = await request(cookie, 'POST', `/api/plans/${plan.id}/archive`, { expectedVersion: plan.version });
    expect(archive.statusCode).toBe(200); const archived = archive.json<{ plan: PlanDto }>().plan;
    expect((await request(cookie, 'PATCH', `/api/nodes/${nodeA.id}`, { title: 'changed', expectedVersion: nodeA.version })).json()).toMatchObject({ code: 'PLAN_ARCHIVED' });
    const restored = await request(cookie, 'POST', `/api/plans/${plan.id}/restore`, { expectedVersion: archived.version });
    expect(restored.json<{ plan: PlanDto }>().plan.status).toBe('planning');
  });

  it('isolates resources between users and detects stale versions', async () => {
    const alice = await register('alice'); const bob = await register('bob');
    const area = (await request(alice, 'POST', '/api/areas', { name: '私有' })).json<{ area: AreaDto }>().area;
    const plan = (await request(alice, 'POST', '/api/plans', { areaId: area.id, name: '私有计划' })).json<{ plan: PlanDto }>().plan;
    expect((await request(bob, 'GET', `/api/plans/${plan.id}`)).statusCode).toBe(404);
    const updated = await request(alice, 'PATCH', `/api/plans/${plan.id}`, { name: '新名称', expectedVersion: plan.version });
    expect(updated.statusCode).toBe(200);
    const stale = await request(alice, 'PATCH', `/api/plans/${plan.id}`, { name: '旧覆盖', expectedVersion: plan.version });
    expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('filters active plans across areas and reports active counts', async () => {
    const cookie = await register('active-user');
    const work = (await request(cookie, 'POST', '/api/areas', { name: '工作' })).json<{ area: AreaDto }>().area;
    const life = (await request(cookie, 'POST', '/api/areas', { name: '生活' })).json<{ area: AreaDto }>().area;
    const active = (await request(cookie, 'POST', '/api/plans', { areaId: work.id, name: '当前项目', status: 'active' })).json<{ plan: PlanDto }>().plan;
    await request(cookie, 'POST', '/api/plans', { areaId: work.id, name: '后续规划', status: 'planning' });
    const archived = (await request(cookie, 'POST', '/api/plans', { areaId: life.id, name: '旧项目', status: 'active' })).json<{ plan: PlanDto }>().plan;
    await request(cookie, 'POST', `/api/plans/${archived.id}/archive`, { expectedVersion: archived.version });

    const plans = (await request(cookie, 'GET', '/api/plans?status=active')).json<{ plans: PlanDto[] }>().plans;
    expect(plans).toHaveLength(1); expect(plans[0]).toMatchObject({ id: active.id, status: 'active', archivedAt: null });
    const areas = (await request(cookie, 'GET', '/api/areas')).json<{ areas: AreaDto[] }>().areas;
    expect(areas.find((area) => area.id === work.id)).toMatchObject({ planCount: 2, activePlanCount: 1 });
    expect(areas.find((area) => area.id === life.id)).toMatchObject({ planCount: 0, activePlanCount: 0, archivedPlanCount: 1 });

    const all = (await request(cookie, 'GET', '/api/plans?archive=all&sort=name')).json<{ plans: PlanDto[] }>().plans;
    expect(all).toHaveLength(3); expect(all.map((plan) => plan.name)).toEqual(['后续规划', '当前项目', '旧项目']);
    const searched = (await request(cookie, 'GET', '/api/plans?archive=archived&q=旧')).json<{ plans: PlanDto[] }>().plans;
    expect(searched).toHaveLength(1); expect(searched[0]?.id).toBe(archived.id);
  });

  it('reconciles date-managed node statuses without overwriting manual statuses', async () => {
    const cookie = await register('date-status-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '日程' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '按日期推进' })).json<{ plan: PlanDto }>().plan;
    const future = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '未来节点', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    const past = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '已开始节点', positionX: 200, positionY: 0 })).json<{ node: NodeDto }>().node;
    const noStart = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '未定节点', positionX: 400, positionY: 0 })).json<{ node: NodeDto }>().node;
    const manual = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '人工完成', positionX: 600, positionY: 0 })).json<{ node: NodeDto }>().node;
    await request(cookie, 'PATCH', `/api/nodes/${future.id}`, { startDate: '2026-08-02', expectedVersion: future.version });
    await request(cookie, 'PATCH', `/api/nodes/${past.id}`, { startDate: '2026-07-31', endDate: '2026-07-31', expectedVersion: past.version });
    await request(cookie, 'PATCH', `/api/nodes/${manual.id}`, { status: 'completed', startDate: '2026-07-01', expectedVersion: manual.version });
    app.database.sqlite.prepare("UPDATE nodes SET status = 'in_progress' WHERE id IN (?, ?)").run(future.id, noStart.id);

    const reconciled = await request(cookie, 'POST', `/api/plans/${plan.id}/nodes/reconcile-statuses`, { today: '2026-08-01' });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json<{ nodes: NodeDto[]; autoActivated: boolean }>().nodes).toHaveLength(3);
    expect(reconciled.json<{ autoActivated: boolean }>().autoActivated).toBe(true);
    const graph = (await request(cookie, 'GET', `/api/plans/${plan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes.find((node) => node.id === future.id)?.status).toBe('not_started');
    expect(graph.nodes.find((node) => node.id === past.id)?.status).toBe('in_progress');
    expect(graph.nodes.find((node) => node.id === noStart.id)?.status).toBe('not_started');
    expect(graph.nodes.find((node) => node.id === manual.id)?.status).toBe('completed');
    expect(graph.plan.status).toBe('active');

    const rejected = await request(cookie, 'PATCH', `/api/plans/${plan.id}`, { status: 'planning', expectedVersion: graph.plan.version });
    expect(rejected.statusCode).toBe(409); expect(rejected.json()).toMatchObject({ code: 'PLAN_HAS_ACTIVE_NODES' });
    const paused = (await request(cookie, 'PATCH', `/api/plans/${plan.id}`, { status: 'paused', expectedVersion: graph.plan.version })).json<{ plan: PlanDto }>().plan;
    expect(paused.status).toBe('paused');

    await request(cookie, 'POST', `/api/plans/${plan.id}/archive`, { expectedVersion: paused.version });
    const archived = await request(cookie, 'POST', `/api/plans/${plan.id}/nodes/reconcile-statuses`, { today: '2026-08-02' });
    expect(archived.statusCode).toBe(409); expect(archived.json()).toMatchObject({ code: 'PLAN_ARCHIVED' });
  });

  it('auto-activates a planning plan when a node starts and keeps manual plan statuses', async () => {
    const cookie = await register('node-plan-status');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '执行' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '执行计划' })).json<{ plan: PlanDto }>().plan;
    const node = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '开始执行', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    const started = await request(cookie, 'PATCH', `/api/nodes/${node.id}`, { status: 'in_progress', expectedVersion: node.version });
    expect(started.statusCode).toBe(200);
    expect(started.json<{ plan: PlanDto; autoActivated: boolean }>().autoActivated).toBe(true);
    expect(started.json<{ plan: PlanDto }>().plan.status).toBe('active');

    const activePlan = started.json<{ plan: PlanDto }>().plan;
    const completed = (await request(cookie, 'PATCH', `/api/plans/${plan.id}`, { status: 'completed', expectedVersion: activePlan.version })).json<{ plan: PlanDto }>().plan;
    const nodeAfterStart = started.json<{ node: NodeDto }>().node;
    await request(cookie, 'PATCH', `/api/nodes/${node.id}`, { summary: '继续进行', expectedVersion: nodeAfterStart.version });
    const unchanged = (await request(cookie, 'GET', `/api/plans/${plan.id}`)).json<{ plan: PlanDto }>().plan;
    expect(unchanged.status).toBe('completed'); expect(unchanged.version).toBe(completed.version);
  });

  it('manages ordered node steps, aggregates the parent and exposes active work', async () => {
    const cookie = await register('step-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '学习' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '英语', status: 'active' })).json<{ plan: PlanDto }>().plan;
    const created = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '四级阶段', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    const parent = (await request(cookie, 'PATCH', `/api/nodes/${created.id}`, { status: 'in_progress', startDate: '2026-08-05',
      endDate: '2026-08-20', expectedVersion: created.version })).json<{ node: NodeDto }>().node;
    const saved = await request(cookie, 'PUT', `/api/nodes/${parent.id}/steps`, { expectedNodeVersion: parent.version, steps: [
      { key: 'vocabulary', title: '词汇', status: 'completed', startDate: '2026-08-01', endDate: '2026-08-03', summary: '' },
      { key: 'mock-exam', title: '真题模拟', status: 'in_progress', startDate: '2026-08-04', endDate: '2026-08-18', summary: '完成两套真题' }
    ] });
    expect(saved.statusCode).toBe(200);
    const node = saved.json<{ node: NodeDto }>().node;
    expect(node).toMatchObject({ status: 'in_progress', startDate: '2026-08-01', endDate: '2026-08-18' });
    expect(node.steps.map((step) => step.key)).toEqual(['vocabulary', 'mock-exam']);

    const stale = await request(cookie, 'PUT', `/api/nodes/${parent.id}/steps`, { expectedNodeVersion: parent.version, steps: [] });
    expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    const derivedDate = await request(cookie, 'PATCH', `/api/nodes/${parent.id}`, { startDate: '2026-08-02', expectedVersion: node.version });
    expect(derivedDate.statusCode).toBe(409); expect(derivedDate.json()).toMatchObject({ code: 'NODE_DATES_DERIVED' });

    const activePlans = (await request(cookie, 'GET', '/api/plans/active')).json<{ plans: ActivePlanDto[] }>().plans;
    expect(activePlans).toHaveLength(1);
    expect(activePlans[0]!.activeNodes[0]).toMatchObject({ id: node.id, stepCount: 2, completedStepCount: 1 });
    expect(activePlans[0]!.activeNodes[0]!.activeSteps[0]).toMatchObject({ key: 'mock-exam', title: '真题模拟' });

    const exported = (await request(cookie, 'GET', `/api/plans/${plan.id}/export`)).json<{ nodes: Array<{ steps: Array<{ key: string }> }> }>();
    expect(exported.nodes[0]!.steps.map((step) => step.key)).toEqual(['vocabulary', 'mock-exam']);
    const imported = await request(cookie, 'POST', '/api/plan-imports', { files: [{ fileName: 'english.plan.json', content: exported, targetAreaId: area.id }] });
    const importedPlan = imported.json<{ results: ImportResult[] }>().results[0]!.plan!;
    const importedGraph = (await request(cookie, 'GET', `/api/plans/${importedPlan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(importedGraph.nodes[0]!.steps.map((step) => step.key)).toEqual(['vocabulary', 'mock-exam']);
  });

  it('applies scoped incremental step changes and preserves their order', async () => {
    const cookie = await register('step-ai-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '训练' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '训练计划' })).json<{ plan: PlanDto }>().plan;
    const node = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '基础阶段', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    const other = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '恢复阶段', positionX: 300, positionY: 0 })).json<{ node: NodeDto }>().node;
    await request(cookie, 'PUT', `/api/nodes/${node.id}/steps`, { expectedNodeVersion: node.version,
      steps: [{ key: 'warm-up', title: '热身', status: 'not_started', startDate: null, endDate: null, summary: '' }] });
    const current = (await request(cookie, 'GET', `/api/plans/${plan.id}`)).json<{ plan: PlanDto }>().plan;
    const changeset = { format: 'sixplan-plan-changeset', version: 2, targetPlanName: plan.name, baseRevision: current.graphRevision,
      operations: { addSteps: [{ nodeKey: node.key, step: { key: 'main-set', title: '主训练', status: 'in_progress' } }],
      updateSteps: [{ nodeKey: node.key, key: 'warm-up', changes: { summary: '按计划完成热身' } }],
      reorderSteps: [{ nodeKey: node.key, keys: ['main-set', 'warm-up'] }] } };
    const rejected = await request(cookie, 'POST', '/api/import-sessions/json', { content: changeset, targetPlanId: plan.id, promptTargetKeys: [other.key] });
    expect(rejected.statusCode).toBe(400); expect(rejected.json()).toMatchObject({ code: 'PROMPT_SCOPE_VIOLATION' });
    const session = await request(cookie, 'POST', '/api/import-sessions/json', { content: changeset, targetPlanId: plan.id, promptTargetKeys: [node.key] });
    expect(session.statusCode).toBe(200); const preview = session.json<{ preview: { sessionId: string; addStepCount: number; reorderStepCount: number } }>().preview;
    expect(preview).toMatchObject({ addStepCount: 1, reorderStepCount: 1 });
    const applied = await request(cookie, 'POST', `/api/import-sessions/${preview.sessionId}/apply`, {});
    expect(applied.statusCode).toBe(200);
    const graph = (await request(cookie, 'GET', `/api/plans/${plan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes[0]!.steps.map((step) => step.key)).toEqual(['main-set', 'warm-up']);
    expect(graph.nodes[0]!.steps[1]!.summary).toBe('按计划完成热身');
  });

  it('atomically batch-deletes archived plans', async () => {
    const cookie = await register('batch-delete-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '归档区' })).json<{ area: AreaDto }>().area;
    const first = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '归档一' })).json<{ plan: PlanDto }>().plan;
    const second = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '归档二' })).json<{ plan: PlanDto }>().plan;
    const archivedFirst = (await request(cookie, 'POST', `/api/plans/${first.id}/archive`, { expectedVersion: first.version })).json<{ plan: PlanDto }>().plan;
    const archivedSecond = (await request(cookie, 'POST', `/api/plans/${second.id}/archive`, { expectedVersion: second.version })).json<{ plan: PlanDto }>().plan;

    const stale = await request(cookie, 'DELETE', '/api/plans/archived/batch', { items: [
      { id: archivedFirst.id, expectedVersion: archivedFirst.version }, { id: archivedSecond.id, expectedVersion: second.version }
    ] });
    expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await request(cookie, 'GET', '/api/plans/archived')).json<{ plans: PlanDto[] }>().plans).toHaveLength(2);

    const removed = await request(cookie, 'DELETE', '/api/plans/archived/batch', { items: [
      { id: archivedFirst.id, expectedVersion: archivedFirst.version }, { id: archivedSecond.id, expectedVersion: archivedSecond.version }
    ] });
    expect(removed.statusCode).toBe(200); expect(removed.json()).toMatchObject({ success: true, deletedCount: 2 });
    expect((await request(cookie, 'GET', '/api/plans/archived')).json<{ plans: PlanDto[] }>().plans).toHaveLength(0);
  });

  it('sets secure cookies only for trusted HTTPS requests and disables storage opening by configuration', async () => {
    const http = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'http-user', password: 'password123' } });
    expect(String(http.headers['set-cookie'])).not.toMatch(/;\s*Secure/i);
    const https = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-forwarded-proto': 'https' },
      payload: { username: 'https-user', password: 'password123' } });
    expect(String(https.headers['set-cookie'])).toMatch(/;\s*Secure/i);
    const spoofed = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '198.51.100.2',
      headers: { 'x-forwarded-proto': 'https' }, payload: { username: 'spoofed-user', password: 'password123' } });
    expect(String(spoofed.headers['set-cookie'])).not.toMatch(/;\s*Secure/i);

    await createUser(app, 'storage-admin', 'password123', 'admin');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'storage-admin', password: 'password123' } });
    const setCookie = login.headers['set-cookie']!; const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(';')[0]!;
    const openStorage = await request(cookie, 'POST', '/api/admin/storage/open');
    expect(openStorage.statusCode).toBe(403); expect(openStorage.json()).toMatchObject({ code: 'STORAGE_OPEN_DISABLED' });
  });

  it('imports valid files independently and preserves archived metadata', async () => {
    const cookie = await register('importer');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '学习' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '阅读计划' })).json<{ plan: PlanDto }>().plan;
    await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '第一章', positionX: 0, positionY: 0 });
    const archived = (await request(cookie, 'POST', `/api/plans/${plan.id}/archive`, { expectedVersion: plan.version })).json<{ plan: PlanDto }>().plan;
    const exported = await request(cookie, 'GET', `/api/plans/${plan.id}/export`);
    const file = JSON.parse(exported.body) as Record<string, unknown>;
    const response = await request(cookie, 'POST', '/api/plan-imports', { files: [
      { fileName: 'reading.plan.json', content: file, targetAreaId: area.id },
      { fileName: 'broken.plan.json', content: { format: 'wrong' }, targetAreaId: area.id }
    ] });
    const results = response.json<{ results: ImportResult[] }>().results;
    expect(results).toHaveLength(2); expect(results[0]).toMatchObject({ success: true }); expect(results[1]).toMatchObject({ success: false });
    expect(results[0]!.plan!.id).not.toBe(plan.id); expect(results[0]!.plan!.archivedAt).toBe(archived.archivedAt);
    expect(results[0]!.plan!.createdAt).toBe(plan.createdAt);
  });

  it('uses strict v2 snapshots, stable node keys and automatic layout', async () => {
    const cookie = await register('snapshot-v2');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '训练' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '原计划' })).json<{ plan: PlanDto }>().plan;
    const manual = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '手工节点', positionX: 0, positionY: 0 })).json<{ node: NodeDto }>().node;
    expect(manual.key).toMatch(/^node-[a-z0-9-]+$/);
    const exported = (await request(cookie, 'GET', `/api/plans/${plan.id}/export`)).json<Record<string, unknown>>();
    expect(exported).toMatchObject({ format: 'sixplan-plan-snapshot', version: 2 });

    const oldVersion = await request(cookie, 'POST', '/api/import-sessions/json', { content: { ...exported, version: 1 } });
    expect(oldVersion.statusCode).toBe(400); expect(oldVersion.json()).toMatchObject({ code: 'UNSUPPORTED_FILE_VERSION' });
    const unknownField = await request(cookie, 'POST', '/api/import-sessions/json', { content: { ...exported, typoField: true } });
    expect(unknownField.statusCode).toBe(400); expect(unknownField.json()).toMatchObject({ code: 'UNKNOWN_FIELD' });

    const snapshot = {
      format: 'sixplan-plan-snapshot', version: 2, areaName: '训练', plan: { name: 'AI 长跑计划' },
      nodes: [{ key: 'base-training', title: '基础训练', status: 'in_progress' }, { key: 'race-week', title: '比赛周' }],
      edges: [{ source: 'base-training', target: 'race-week' }]
    };
    const createdSession = await request(cookie, 'POST', '/api/import-sessions/json', { content: snapshot });
    expect(createdSession.statusCode).toBe(200);
    const preview = createdSession.json<{ preview: { sessionId: string; needsLayout: boolean } }>().preview;
    expect(preview.needsLayout).toBe(true);
    const applied = await request(cookie, 'POST', `/api/import-sessions/${preview.sessionId}/apply`, { targetAreaId: area.id });
    expect(applied.statusCode).toBe(201); const appliedResult = applied.json<{ plan: PlanDto; autoActivated: boolean }>(); const imported = appliedResult.plan;
    expect(appliedResult.autoActivated).toBe(true); expect(imported.status).toBe('active');
    const graph = (await request(cookie, 'GET', `/api/plans/${imported.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes.map((node) => node.key)).toEqual(['base-training', 'race-week']);
    expect(graph.nodes[1]!.positionX).toBeGreaterThan(graph.nodes[0]!.positionX);
  });

  it('previews and transactionally applies changesets with revision reconfirmation', async () => {
    const cookie = await register('changeset-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '长期计划' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '锻炼', status: 'planning' })).json<{ plan: PlanDto }>().plan;
    const first = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '第一阶段', positionX: 100, positionY: 100 })).json<{ node: NodeDto }>().node;
    const second = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '第二阶段', positionX: 400, positionY: 100 })).json<{ node: NodeDto }>().node;
    await request(cookie, 'POST', `/api/plans/${plan.id}/edges`, { sourceNodeId: first.id, targetNodeId: second.id });
    const current = (await request(cookie, 'GET', `/api/plans/${plan.id}`)).json<{ plan: PlanDto }>().plan;
    const changeset = { format: 'sixplan-plan-changeset', version: 2, targetPlanName: '锻炼', baseRevision: current.graphRevision,
      operations: { addNodes: [{ key: 'recovery-stage', title: '恢复阶段' }], updateNodes: [{ key: first.key, changes: { status: 'in_progress' } }],
        addEdges: [{ source: second.key, target: 'recovery-stage' }] } };
    const sessionResponse = await request(cookie, 'POST', '/api/import-sessions/json', { content: changeset, targetPlanId: plan.id });
    expect(sessionResponse.statusCode).toBe(200);
    const preview = sessionResponse.json<{ preview: { sessionId: string; addNodeCount: number } }>().preview;
    expect(preview.addNodeCount).toBe(1);

    await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '并发添加', positionX: 100, positionY: 300 });
    const staleApply = await request(cookie, 'POST', `/api/import-sessions/${preview.sessionId}/apply`, {});
    expect(staleApply.statusCode).toBe(409); const staleError = staleApply.json<{ code: string; details: { currentRevision: number } }>();
    expect(staleError.code).toBe('REVISION_RECONFIRM_REQUIRED');
    const applied = await request(cookie, 'POST', `/api/import-sessions/${preview.sessionId}/apply`, { confirmedRevision: staleError.details.currentRevision });
    expect(applied.statusCode).toBe(200); expect(applied.json()).toMatchObject({ autoActivated: true, plan: { status: 'active' } });
    const graph = (await request(cookie, 'GET', `/api/plans/${plan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes.find((node) => node.key === first.key)?.status).toBe('in_progress');
    expect(graph.nodes.find((node) => node.key === 'recovery-stage')?.positionX).toBeGreaterThan(second.positionX);

    const cycle = { format: 'sixplan-plan-changeset', version: 2, baseRevision: graph.plan.graphRevision,
      operations: { addEdges: [{ source: 'recovery-stage', target: first.key }] } };
    const rejected = await request(cookie, 'POST', '/api/import-sessions/json', { content: cycle, targetPlanId: plan.id });
    expect(rejected.statusCode).toBe(400); expect(rejected.json()).toMatchObject({ code: 'CYCLE_DETECTED' });
  });

  it('uses all nodes by default, calculates leaves and only enforces the selected prompt scope', async () => {
    const cookie = await register('prompt-scope');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '学习' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '英语学习' })).json<{ plan: PlanDto }>().plan;
    const cet4 = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '四级', positionX: 100, positionY: 100 })).json<{ node: NodeDto }>().node;
    const cet6 = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '六级', positionX: 400, positionY: 100 })).json<{ node: NodeDto }>().node;
    const vocabulary = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '词汇积累', positionX: 100, positionY: 300 })).json<{ node: NodeDto }>().node;
    await request(cookie, 'POST', `/api/plans/${plan.id}/edges`, { sourceNodeId: cet4.id, targetNodeId: cet6.id });
    const updatedCet6 = (await request(cookie, 'PATCH', `/api/nodes/${cet6.id}`, { extraContent: '旧内容', expectedVersion: cet6.version })).json<{ node: NodeDto }>().node;
    const allContext = (await request(cookie, 'GET', `/api/plans/${plan.id}/prompt-context`)).json<{ context: { scope: string; targetKeys: string[];
      leafKeys: string[]; totalNodeCount: number; leafNodeCount: number; nodes: Array<{ key: string; markdown?: string; markdownBytes: number }> } }>().context;
    expect(allContext).toMatchObject({ scope: 'all', totalNodeCount: 3, leafNodeCount: 2 });
    expect(allContext.targetKeys).toEqual([cet4.key, cet6.key, vocabulary.key]); expect(allContext.leafKeys).toEqual([cet6.key, vocabulary.key]);
    expect(allContext.nodes.every((node) => !('markdown' in node))).toBe(true);
    const customContext = (await request(cookie, 'POST', `/api/plans/${plan.id}/prompt-context`, {
      targetKeys: [cet6.key], includeMarkdown: true
    })).json<{ context: { scope: string; targetKeys: string[]; markdownBytes: number; nodes: Array<{ key: string; markdown?: string }> } }>().context;
    expect(customContext).toMatchObject({ scope: 'custom', targetKeys: [cet6.key], markdownBytes: Buffer.byteLength('旧内容') });
    expect(customContext.nodes.map((node) => node.key)).toEqual([cet4.key, cet6.key]);
    expect(customContext.nodes.find((node) => node.key === cet6.key)?.markdown).toBe('旧内容');
    expect(customContext.nodes.find((node) => node.key === cet4.key)).not.toHaveProperty('markdown');

    const current = (await request(cookie, 'GET', `/api/plans/${plan.id}`)).json<{ plan: PlanDto }>().plan;
    const outsideScope = await request(cookie, 'POST', '/api/import-sessions/json', { targetPlanId: plan.id, promptTargetKeys: [cet6.key],
      content: { format: 'sixplan-plan-changeset', version: 2, targetPlanName: plan.name, baseRevision: current.graphRevision,
        operations: { updateNodes: [{ key: cet4.key, changes: { markdown: '# 四级新计划' } }] } } });
    expect(outsideScope.statusCode).toBe(400); expect(outsideScope.json()).toMatchObject({ code: 'PROMPT_SCOPE_VIOLATION' });

    const boundary = 'sixplan-prompt-targets';
    const uploadJson = JSON.stringify({ format: 'sixplan-plan-changeset', version: 2, targetPlanName: plan.name, baseRevision: current.graphRevision,
      operations: { updateNodes: [{ key: cet4.key, changes: { summary: '范围外修改' } }] } });
    const multipartBody = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="promptTargetKeys"\r\n\r\n${JSON.stringify([cet6.key])}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="custom.changeset.json"\r\nContent-Type: application/json\r\n\r\n${uploadJson}\r\n--${boundary}--\r\n`);
    const uploadedOutsideScope = await app.inject({ method: 'POST', url: `/api/import-sessions/upload?targetPlanId=${plan.id}`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartBody });
    expect(uploadedOutsideScope.statusCode).toBe(400); expect(uploadedOutsideScope.json()).toMatchObject({ code: 'PROMPT_SCOPE_VIOLATION' });

    const combined = await request(cookie, 'POST', '/api/import-sessions/json', { targetPlanId: plan.id, promptTargetKeys: [cet6.key],
      content: { format: 'sixplan-plan-changeset', version: 2, targetPlanName: plan.name, baseRevision: current.graphRevision,
        planChanges: { description: '长期英语学习计划' }, operations: {
          addNodes: [{ key: 'review-stage', title: '复盘阶段' }],
          updateNodes: [{ key: cet6.key, changes: { summary: '六级备考', markdown: '# 六级新计划' } }],
          addEdges: [{ source: cet6.key, target: 'review-stage' }]
        } } });
    expect(combined.statusCode).toBe(200); const sessionId = combined.json<{ preview: { sessionId: string } }>().preview.sessionId;
    expect((await request(cookie, 'POST', `/api/import-sessions/${sessionId}/apply`, {})).statusCode).toBe(200);
    const graph = (await request(cookie, 'GET', `/api/plans/${plan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.plan.description).toBe('长期英语学习计划');
    expect(graph.nodes.find((node) => node.id === updatedCet6.id)).toMatchObject({ summary: '六级备考', extraContent: '# 六级新计划' });
    expect(graph.nodes.some((node) => node.key === 'review-stage')).toBe(true);
  });

  it('enforces per-user import limits and isolates temporary sessions', async () => {
    const alice = await register('limit-alice'); const bob = await register('limit-bob');
    const area = (await request(alice, 'POST', '/api/areas', { name: '导入区' })).json<{ area: AreaDto }>().area;
    const settingsResponse = await request(alice, 'GET', '/api/import-settings');
    const settings = settingsResponse.json<{ settings: { version: number } }>().settings;
    const saved = await request(alice, 'PUT', '/api/import-settings', { maxNodes: 1, maxEdges: 0, maxMarkdownBytes: 0, maxFileBytes: 0, sessionHours: 24, expectedVersion: settings.version });
    expect(saved.statusCode).toBe(200);
    const tooLarge = await request(alice, 'POST', '/api/import-sessions/json', { content: { format: 'sixplan-plan-snapshot', version: 2,
      plan: { name: '过大' }, nodes: [{ key: 'first', title: '一' }, { key: 'second', title: '二' }], edges: [] } });
    expect(tooLarge.statusCode).toBe(413); expect(tooLarge.json()).toMatchObject({ code: 'IMPORT_NODE_LIMIT' });

    const currentSettings = saved.json<{ settings: { version: number } }>().settings;
    await request(alice, 'PUT', '/api/import-settings', { maxNodes: 0, maxEdges: 0, maxMarkdownBytes: 0, maxFileBytes: 0, sessionHours: 24, expectedVersion: currentSettings.version });
    const valid = await request(alice, 'POST', '/api/import-sessions/json', { content: { format: 'sixplan-plan-snapshot', version: 2,
      plan: { name: '隔离测试' }, nodes: [{ key: 'only-node', title: '唯一节点' }], edges: [] } });
    const sessionId = valid.json<{ preview: { sessionId: string } }>().preview.sessionId;
    expect((await request(bob, 'GET', `/api/import-sessions/${sessionId}`)).statusCode).toBe(404);
    expect((await request(alice, 'POST', `/api/import-sessions/${sessionId}/apply`, { targetAreaId: area.id })).statusCode).toBe(201);

    const boundary = 'sixplan-test-boundary';
    const uploadJson = JSON.stringify({ format: 'sixplan-plan-snapshot', version: 2, plan: { name: '流式上传' }, nodes: [], edges: [] });
    const multipartBody = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stream.plan.json"\r\nContent-Type: application/json\r\n\r\n${uploadJson}\r\n--${boundary}--\r\n`);
    const uploaded = await app.inject({ method: 'POST', url: '/api/import-sessions/upload', headers: { cookie: alice,
      'content-type': `multipart/form-data; boundary=${boundary}` }, payload: multipartBody });
    expect(uploaded.statusCode).toBe(200); const uploadSession = uploaded.json<{ preview: { sessionId: string; planName: string } }>().preview;
    expect(uploadSession.planName).toBe('流式上传');
    expect((await request(alice, 'DELETE', `/api/import-sessions/${uploadSession.sessionId}`)).statusCode).toBe(200);
  });

  it('exports and atomically imports complete areas by creating or merging', async () => {
    const cookie = await register('area-importer');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '工作' })).json<{ area: AreaDto }>().area;
    const archivedPlan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '季度规划', description: '保留完整图数据' })).json<{ plan: PlanDto }>().plan;
    const activePlan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '日常事项', status: 'active' })).json<{ plan: PlanDto }>().plan;
    const node = (await request(cookie, 'POST', `/api/plans/${archivedPlan.id}/nodes`, { title: '里程碑', positionX: 123, positionY: 456 })).json<{ node: NodeDto }>().node;
    const updatedNode = (await request(cookie, 'PATCH', `/api/nodes/${node.id}`, {
      startDate: '2026-08-01', endDate: '2026-09-01', summary: '关键节点', extraContent: '# 记录', expectedVersion: node.version
    })).json<{ node: NodeDto }>().node;
    await request(cookie, 'POST', `/api/plans/${archivedPlan.id}/archive`, { expectedVersion: archivedPlan.version });

    const exported = await request(cookie, 'GET', `/api/areas/${area.id}/export`);
    expect(exported.statusCode).toBe(200);
    const file = exported.json<AreaFile>();
    expect(file).toMatchObject({ format: 'sixplan-area', version: 2, area: { name: '工作' } });
    expect(file.plans.map((entry) => entry.plan.name)).toHaveLength(2);
    expect(file.plans.map((entry) => entry.plan.name)).toEqual(expect.arrayContaining(['季度规划', '日常事项']));
    expect(file.plans.find((entry) => entry.plan.name === '季度规划')?.plan.archivedAt).not.toBeNull();

    const created = await request(cookie, 'POST', '/api/area-imports', { mode: 'create', createAreaName: '工作（导入）', content: file });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ areaName: '工作（导入）', importedPlanCount: 2 });
    const importedArea = (await request(cookie, 'GET', '/api/areas')).json<{ areas: AreaDto[] }>().areas.find((entry) => entry.name === '工作（导入）')!;
    expect(importedArea).toBeDefined();
    const importedArchived = (await request(cookie, 'GET', '/api/plans/archived')).json<{ plans: PlanDto[] }>().plans.find((entry) => entry.areaId === importedArea.id)!;
    expect(importedArchived.id).not.toBe(archivedPlan.id);
    const importedActive = (await request(cookie, 'GET', `/api/plans?areaId=${importedArea.id}`)).json<{ plans: PlanDto[] }>().plans;
    expect(importedActive).toHaveLength(1); expect(importedActive[0]).toMatchObject({ name: activePlan.name, status: 'active' });
    const graph = (await request(cookie, 'GET', `/api/plans/${importedArchived.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes[0]).toMatchObject({ startDate: '2026-08-01', endDate: '2026-09-01', summary: '关键节点', extraContent: '# 记录', positionX: 123, positionY: 456 });
    expect(graph.nodes[0]!.id).not.toBe(updatedNode.id);

    const merged = await request(cookie, 'POST', '/api/area-imports', { mode: 'merge', targetAreaId: area.id, content: file });
    expect(merged.statusCode).toBe(201); expect(merged.json()).toMatchObject({ areaId: area.id, importedPlanCount: 2 });
    const originalActivePlans = (await request(cookie, 'GET', `/api/plans?areaId=${area.id}`)).json<{ plans: PlanDto[] }>().plans;
    const originalArchivedPlans = (await request(cookie, 'GET', '/api/plans/archived')).json<{ plans: PlanDto[] }>().plans.filter((entry) => entry.areaId === area.id);
    expect(originalActivePlans).toHaveLength(2); expect(originalArchivedPlans).toHaveLength(2);

    const invalidFile = structuredClone(file);
    invalidFile.plans[0]!.edges.push({ source: invalidFile.plans[0]!.nodes[0]!.key,
      target: 'missing-node', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const invalid = await request(cookie, 'POST', '/api/area-imports', { mode: 'create', createAreaName: '不完整领域', content: invalidFile });
    expect(invalid.statusCode).toBe(400); expect(invalid.json()).toMatchObject({ code: 'INVALID_EDGE_REFERENCE' });
    const names = (await request(cookie, 'GET', '/api/areas')).json<{ areas: AreaDto[] }>().areas.map((entry) => entry.name);
    expect(names).not.toContain('不完整领域');

    const conflict = await request(cookie, 'POST', '/api/area-imports', { mode: 'create', createAreaName: '工作', content: file });
    expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ code: 'AREA_NAME_EXISTS' });
  });

  it('restores user data without affecting sessions and site data with all sessions revoked', async () => {
    const aliceCookie = await register('alice');
    await request(aliceCookie, 'POST', '/api/areas', { name: '保留领域' });
    const aliceId = (app.database.sqlite.prepare("SELECT id FROM users WHERE username='alice'").get() as { id: string }).id;
    const userPayload = collectBackup(app, 'user', aliceId);
    await request(aliceCookie, 'POST', '/api/areas', { name: '临时领域' });
    restoreUserBackup(app, aliceId, await decodeBackup(await encodeBackup(userPayload, 'backup-pass'), 'backup-pass'));
    expect((await request(aliceCookie, 'GET', '/api/areas')).json<{ areas: AreaDto[] }>().areas.map((area) => area.name)).toEqual(['保留领域']);

    await createUser(app, 'admin', 'password123', 'admin');
    const sitePayload = collectBackup(app, 'site');
    await register('temporary');
    restoreSiteBackup(app, await decodeBackup(await encodeBackup(sitePayload)));
    expect((await request(aliceCookie, 'GET', '/api/auth/me')).statusCode).toBe(401);
    expect(app.database.sqlite.prepare("SELECT COUNT(*) value FROM users WHERE username='temporary'").get()).toMatchObject({ value: 0 });
  });
});
