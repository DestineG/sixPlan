import { describe, expect, it } from 'vitest';
import { buildChangeSetPrompt, buildRepairPrompt, buildSnapshotPrompt } from './ai-prompts';

describe('AI prompt construction', () => {
  it('builds a deterministic v2 snapshot prompt without internal ids', () => {
    const prompt = buildSnapshotPrompt('准备一次长跑', '锻炼');
    expect(prompt).toContain('sixplan-plan-snapshot');
    expect(prompt).toContain('准备一次长跑');
    expect(prompt).toContain('建议领域：锻炼');
    expect(prompt).not.toContain('sourceNodeId');
  });

  it('pins changesets to the current graph revision', () => {
    const prompt = buildChangeSetPrompt('增加恢复阶段', { plan: { name: '训练', description: '', status: 'active', graphRevision: 18 }, nodes: [], edges: [] });
    expect(prompt).toContain('"baseRevision": 18');
    expect(prompt).toContain('增加恢复阶段');
  });

  it('includes validation errors in repair prompts', () => {
    expect(buildRepairPrompt('{"bad":true}', '未知字段 bad')).toContain('未知字段 bad');
  });
});
