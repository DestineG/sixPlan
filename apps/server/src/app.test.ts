import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { InjectOptions, Response as InjectResponse } from 'light-my-request';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { AreaDto, AreaFile, EdgeDto, GraphDto, ImportResult, NodeDto, PlanDto } from '@sixplan/shared';
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
      nodes: [{ key: 'base-training', title: '基础训练' }, { key: 'race-week', title: '比赛周' }],
      edges: [{ source: 'base-training', target: 'race-week' }]
    };
    const createdSession = await request(cookie, 'POST', '/api/import-sessions/json', { content: snapshot });
    expect(createdSession.statusCode).toBe(200);
    const preview = createdSession.json<{ preview: { sessionId: string; needsLayout: boolean } }>().preview;
    expect(preview.needsLayout).toBe(true);
    const applied = await request(cookie, 'POST', `/api/import-sessions/${preview.sessionId}/apply`, { targetAreaId: area.id });
    expect(applied.statusCode).toBe(201); const imported = applied.json<{ plan: PlanDto }>().plan;
    const graph = (await request(cookie, 'GET', `/api/plans/${imported.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes.map((node) => node.key)).toEqual(['base-training', 'race-week']);
    expect(graph.nodes[1]!.positionX).toBeGreaterThan(graph.nodes[0]!.positionX);
  });

  it('previews and transactionally applies changesets with revision reconfirmation', async () => {
    const cookie = await register('changeset-user');
    const area = (await request(cookie, 'POST', '/api/areas', { name: '长期计划' })).json<{ area: AreaDto }>().area;
    const plan = (await request(cookie, 'POST', '/api/plans', { areaId: area.id, name: '锻炼', status: 'active' })).json<{ plan: PlanDto }>().plan;
    const first = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '第一阶段', positionX: 100, positionY: 100 })).json<{ node: NodeDto }>().node;
    const second = (await request(cookie, 'POST', `/api/plans/${plan.id}/nodes`, { title: '第二阶段', positionX: 400, positionY: 100 })).json<{ node: NodeDto }>().node;
    await request(cookie, 'POST', `/api/plans/${plan.id}/edges`, { sourceNodeId: first.id, targetNodeId: second.id });
    const current = (await request(cookie, 'GET', `/api/plans/${plan.id}`)).json<{ plan: PlanDto }>().plan;
    const changeset = { format: 'sixplan-plan-changeset', version: 2, targetPlanName: '锻炼', baseRevision: current.graphRevision,
      operations: { addNodes: [{ key: 'recovery-stage', title: '恢复阶段' }], updateNodes: [{ key: first.key, changes: { status: 'completed' } }],
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
    expect(applied.statusCode).toBe(200);
    const graph = (await request(cookie, 'GET', `/api/plans/${plan.id}/graph`)).json<{ graph: GraphDto }>().graph;
    expect(graph.nodes.find((node) => node.key === first.key)?.status).toBe('completed');
    expect(graph.nodes.find((node) => node.key === 'recovery-stage')?.positionX).toBeGreaterThan(second.positionX);

    const cycle = { format: 'sixplan-plan-changeset', version: 2, baseRevision: graph.plan.graphRevision,
      operations: { addEdges: [{ source: 'recovery-stage', target: first.key }] } };
    const rejected = await request(cookie, 'POST', '/api/import-sessions/json', { content: cycle, targetPlanId: plan.id });
    expect(rejected.statusCode).toBe(400); expect(rejected.json()).toMatchObject({ code: 'CYCLE_DETECTED' });
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
