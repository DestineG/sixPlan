import { describe, expect, it } from 'vitest';
import { buildBundlePrompt, buildChangeSetPrompt, buildRepairPrompt, buildSnapshotPrompt, buildTreeChangeSetPrompt } from './ai-prompts';

describe('AI prompt construction', () => {
  it('builds a deterministic v2 snapshot prompt without internal ids', () => {
    const prompt = buildSnapshotPrompt('准备一次长跑', '锻炼');
    expect(prompt).toContain('sixplan-plan-snapshot');
    expect(prompt).toContain('准备一次长跑');
    expect(prompt).toContain('建议领域：锻炼');
    expect(prompt).not.toContain('sourceNodeId');
  });

  it('pins changesets to the current graph revision', () => {
    const prompt = buildChangeSetPrompt('增加恢复阶段', { plan: { name: '训练', description: '', status: 'active', graphRevision: 18 },
      scope: 'leaves', targetKeys: ['last-stage'], leafKeys: ['last-stage'], totalNodeCount: 4, leafNodeCount: 1,
      markdownIncluded: false, markdownBytes: 0, nodes: [], edges: [] });
    expect(prompt).toContain('"baseRevision": 18');
    expect(prompt).toContain('叶节点（1/4');
    expect(prompt).toContain('targetPlanName = "训练"');
    expect(prompt).toContain('增加恢复阶段');
  });

  it('documents markdown semantics without narrowing the full changeset protocol', () => {
    const prompt = buildChangeSetPrompt('在附加信息中给每个节点添加详细计划', { plan: { name: '英语学习', description: '', status: 'planning', graphRevision: 2 },
      scope: 'all', targetKeys: ['cet-4', 'cet-6'], leafKeys: ['cet-4', 'cet-6'], totalNodeCount: 2, leafNodeCount: 2,
      markdownIncluded: false, markdownBytes: 0, nodes: [], edges: [] });
    expect(prompt).toContain('操作范围：所有节点（2/2）');
    expect(prompt).toContain('完整覆盖原附加信息');
    expect(prompt).toContain('详细计划不得写入 summary');
    expect(prompt).toContain('每一个目标节点');
    expect(prompt).toContain('operations.addNodes');
    expect(prompt).toContain('operations.updateNodes');
    expect(prompt).toContain('operations.removeNodes');
    expect(prompt).toContain('operations.addEdges 和 removeEdges');
    expect(prompt).toContain('planChanges 可修改');
    expect(prompt).toContain('不得因为用户提到某个字段，就忽略其同时提出的其他操作');
    expect(prompt).not.toContain('changes 只允许包含');
  });

  it('includes existing target markdown without exposing picker metadata', () => {
    const prompt = buildChangeSetPrompt('完善所选阶段', { plan: { name: '训练', description: '', status: 'active', graphRevision: 4 },
      scope: 'custom', targetKeys: ['build'], leafKeys: ['finish'], totalNodeCount: 3, leafNodeCount: 1,
      markdownIncluded: true, markdownBytes: 12, nodes: [{ key: 'build', title: '建设', status: 'in_progress', startDate: null,
        endDate: null, summary: '', position: { x: 100, y: 100 }, markdownBytes: 12, markdown: '# 原内容' }], edges: [] });
    expect(prompt).toContain('操作范围：自定义节点（1/3）');
    expect(prompt).toContain('"markdown": "# 原内容"');
    expect(prompt).toContain('现有 markdown（共 12 字节）');
    expect(prompt).not.toContain('markdownBytes');
    expect(prompt).not.toContain('"position"');
  });

  it('includes validation errors in repair prompts', () => {
    expect(buildRepairPrompt('{"bad":true}', '未知字段 bad')).toContain('未知字段 bad');
  });

  it('describes a complete plan bundle without forcing unnecessary child plans', () => {
    const prompt = buildBundlePrompt('整理一个长期学习方向', '学习');
    expect(prompt).toContain('sixplan-plan-bundle'); expect(prompt).toContain('parentPlanKey');
    expect(prompt).toContain('简单需求可以只有根计划'); expect(prompt).toContain('需要分层时再创建子计划');
    expect(prompt).not.toContain('锻炼');
  });

  it('keeps all tree mutation capabilities available while requiring minimal changes', () => {
    const prompt = buildTreeChangeSetPrompt('完善下一阶段', { rootPlanKey: 'long-term', scope: 'descendants', links: [], plans: [{
      plan: { id: 'plan-id', key: 'long-term', areaName: '学习', name: '长期学习', description: '', status: 'active', graphRevision: 9 },
      scope: 'all', targetKeys: ['next'], leafKeys: ['next'], totalNodeCount: 1, leafNodeCount: 1, markdownIncluded: false,
      markdownBytes: 0, nodes: [{ key: 'next', title: '下一阶段', status: 'not_started', startDate: null, endDate: null,
        summary: '', position: { x: 0, y: 0 }, markdownBytes: 0 }], edges: []
    }] });
    expect(prompt).toContain('operations.addPlans'); expect(prompt).toContain('operations.updatePlans');
    expect(prompt).toContain('operations.addLinks'); expect(prompt).toContain('removeLinks');
    expect(prompt).toContain('"graphRevision":9'); expect(prompt).toContain('最小必要操作');
  });
});
