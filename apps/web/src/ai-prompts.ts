interface PromptContext {
  plan: { name: string; description: string; status: string; graphRevision: number };
  nodes: Array<Record<string, unknown>>;
  edges: Array<{ source: string; target: string }>;
}

const commonRules = `通用规则：
- 只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或注释。
- 所有对象都必须严格使用给定字段，禁止增加未知字段。
- 节点 key 必须以小写字母开头，只含小写字母、数字和连字符，最多 64 字符，并在计划内唯一。
- 日期只用 YYYY-MM-DD 或 null，结束日期不得早于开始日期。
- 连接语义为 target 依赖 source；禁止自环、重复连接和有向环。
- 内容不确定时使用默认值，不要编造技术 ID、UUID 或时间戳。`;

export function buildSnapshotPrompt(idea: string, areaName?: string): string {
  return `你正在为 sixPlan 生成一个全新的 DAG 计划。

用户想法：
${idea.trim()}
${areaName?.trim() ? `\n建议领域：${areaName.trim()}\n` : ''}
${commonRules}

请输出以下 sixPlan v2 快照格式：
{
  "format": "sixplan-plan-snapshot",
  "version": 2,
  "areaName": "可选的建议领域",
  "plan": {
    "name": "计划名称",
    "description": "可选说明",
    "status": "planning | active | completed | paused"
  },
  "nodes": [
    {
      "key": "stable-node-key",
      "title": "节点名称",
      "status": "not_started | in_progress | completed | paused | abandoned",
      "startDate": null,
      "endDate": null,
      "summary": "可选摘要",
      "markdown": "可选 Markdown"
    }
  ],
  "edges": [{ "source": "prerequisite-key", "target": "dependent-key" }]
}

status、日期、description、summary、markdown 和 position 都可以省略。请优先生成清晰、可持续追加的阶段节点；不要输出 position，sixPlan 会从左到右自动布局。`;
}

export function buildChangeSetPrompt(idea: string, context: PromptContext): string {
  return `你正在为 sixPlan 的现有 DAG 计划生成增量变更，不要重建整个计划。

用户想法：
${idea.trim()}

当前计划上下文（只读）：
${JSON.stringify(context, null, 2)}

${commonRules}
- 只能引用上下文中已有的 key，或本次 addNodes 中声明的新 key。
- 不要修改用户未要求修改的节点。
- 不能归档、恢复、移动领域或删除整个计划。

请输出以下 sixPlan v2 增量格式，baseRevision 必须保持为 ${context.plan.graphRevision}：
{
  "format": "sixplan-plan-changeset",
  "version": 2,
  "targetPlanName": ${JSON.stringify(context.plan.name)},
  "baseRevision": ${context.plan.graphRevision},
  "planChanges": {
    "name": "可选的新名称",
    "description": "可选的新说明",
    "status": "planning | active | completed | paused"
  },
  "operations": {
    "addNodes": [],
    "updateNodes": [{ "key": "existing-key", "changes": { "status": "completed" } }],
    "removeNodes": [],
    "addEdges": [{ "source": "source-key", "target": "target-key" }],
    "removeEdges": []
  }
}

planChanges 可整体省略；五个操作数组可以省略空数组。addNodes 的字段与快照节点一致。`;
}

export function buildRepairPrompt(rawJson: string, error: string): string {
  return `下面的 sixPlan v2 JSON 校验失败。请只修复格式或数据错误，保持原始业务意图，不要增加解释或代码围栏。

校验错误：
${error}

原始 JSON：
${rawJson}`;
}
