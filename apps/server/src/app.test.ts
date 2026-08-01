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
    app = await buildApp({ host: '127.0.0.1', port: 0, dataDir: directory, databasePath: join(directory, 'test.db'), backupDir: directory, exportDir: directory, isProduction: false });
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
    expect(file).toMatchObject({ format: 'sixplan-area', version: 1, area: { name: '工作' } });
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
    invalidFile.plans[0]!.edges.push({ id: 'bad-edge', sourceNodeId: invalidFile.plans[0]!.nodes[0]!.id,
      targetNodeId: 'missing-node', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
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
