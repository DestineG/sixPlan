import { describe, expect, it } from 'vitest';
import { buildChangeSetPrompt, buildRepairPrompt, buildSnapshotPrompt, PROJECT_INTRODUCTION } from './ai-prompts';

describe('AI prompt construction', () => {
  it('provides a stable project introduction without plan data or an immediate JSON request', () => {
    expect(PROJECT_INTRODUCTION).toContain('本段仅用于理解 sixPlan，不要求你立即输出 JSON');
    expect(PROJECT_INTRODUCTION).toContain('个人 DAG 计划管理工具');
    expect(PROJECT_INTRODUCTION).toContain('一层有序子阶段');
    expect(PROJECT_INTRODUCTION).toContain('最终输出要求、允许操作范围和字段格式始终以后续具体提示词为准');
    expect(PROJECT_INTRODUCTION).not.toContain('targetPlanName');
  });

  it('documents ordered steps without forcing them into every node', () => {
    const prompt = buildSnapshotPrompt('制定一个长期学习计划');
    expect(prompt).toContain('"steps"');
    expect(prompt).toContain('只有用户想法确实包含某阶段内部的顺序拆解时才使用 steps');
    expect(prompt).toContain('并行、分支、依赖或多层结构应建成普通节点和边');
    expect(prompt).toContain('从无到有建立子阶段结构时，应形成多个有序部分');
    expect(prompt).toContain('已有子阶段结构追加、修改、删除或重排时，可以只操作一项');
  });

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
    expect(prompt).toContain('operations.addSteps');
    expect(prompt).toContain('operations.updateSteps');
    expect(prompt).toContain('operations.removeSteps');
    expect(prompt).toContain('operations.reorderSteps');
    expect(prompt).toContain('planChanges 可修改');
    expect(prompt).toContain('不得因为用户提到某个字段，就忽略其同时提出的其他操作');
    expect(prompt).not.toContain('changes 只允许包含');
  });

  it('includes existing ordered steps in incremental context', () => {
    const prompt = buildChangeSetPrompt('调整子阶段顺序', { plan: { name: '学习', description: '', status: 'active', graphRevision: 3 },
      scope: 'all', targetKeys: ['stage'], leafKeys: ['stage'], totalNodeCount: 1, leafNodeCount: 1,
      markdownIncluded: false, markdownBytes: 0, nodes: [{ key: 'stage', title: '阶段', status: 'in_progress', startDate: null,
        endDate: null, summary: '', position: { x: 0, y: 0 }, markdownBytes: 0,
        steps: [{ key: 'step-one', title: '第一步', status: 'completed', startDate: null, endDate: null, summary: '' }] }], edges: [] });
    expect(prompt).toContain('"key": "step-one"');
    expect(prompt).toContain('子阶段 key 必须来自该节点上下文或本次 addSteps');
  });

  it('requires complete scope evaluation without forcing every scoped node', () => {
    const prompt = buildChangeSetPrompt('根据现有内容判断哪些阶段值得细化', { plan: { name: '学习', description: '', status: 'active', graphRevision: 6 },
      scope: 'all', targetKeys: ['first', 'second'], leafKeys: ['second'], totalNodeCount: 2, leafNodeCount: 1,
      markdownIncluded: false, markdownBytes: 0, nodes: [], edges: [] });
    expect(prompt).toContain('操作范围表示哪些现有节点可以被修改，不代表必须修改范围内每一个节点');
    expect(prompt).toContain('依据上下文从操作范围中判断或筛选目标时，必须逐一评估范围内的全部现有节点');
    expect(prompt).toContain('不得只选择少数代表性目标');
    expect(prompt).toContain('最小变更只用于避免无关字段和无关操作，不得用于遗漏满足用户条件的目标');
    expect(prompt).toContain('已完整评估用户要求判断或筛选的操作范围');
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
});
