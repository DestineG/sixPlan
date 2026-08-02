export interface PromptContextNode {
  key: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  steps?: Array<{ key: string; title: string; status: string; startDate: string | null; endDate: string | null; summary: string }>;
  position: { x: number; y: number };
  markdownBytes: number;
  markdown?: string;
}

export const PROJECT_INTRODUCTION = `以下是后续讨论所使用的应用背景，本段仅用于理解 sixPlan，不要求你立即输出 JSON；具体任务和输出格式以后续提示词为准。

sixPlan 是一个个人 DAG 计划管理工具。用户通过“领域”组织多个计划，每个计划由节点和有向边组成。节点表示可以独立管理的阶段，边表示前后依赖关系，计划必须保持为无环有向图。

节点包含名称、状态、开始日期、结束日期、简短说明、Markdown 附加信息和画布坐标。节点内部还可以包含一层有序子阶段，用于表示该节点内部按顺序执行的多个步骤。子阶段不参与 DAG 连线、不能继续嵌套，也不包含 Markdown；并行、分支、跨节点依赖或多层结构应继续使用普通节点和边表达。

sixPlan 支持创建全新计划，以及通过增量变更扩展现有计划。应用本身不连接大模型，而是生成包含当前上下文、业务规则和 JSON 协议的提示词，再校验模型返回的 JSON。最终输出要求、允许操作范围和字段格式始终以后续具体提示词为准。`;

export interface PromptContext {
  plan: { name: string; description: string; status: string; graphRevision: number };
  scope: 'all' | 'leaves' | 'custom';
  targetKeys: string[];
  leafKeys: string[];
  totalNodeCount: number;
  leafNodeCount: number;
  markdownIncluded: boolean;
  markdownBytes: number;
  nodes: PromptContextNode[];
  edges: Array<{ source: string; target: string }>;
}

const commonRules = `通用规则：
- 只输出一个 JSON 对象，不要 Markdown 代码围栏、解释或注释。
- 所有对象都必须严格使用给定字段，禁止增加未知字段。
- 节点 key 必须以小写字母开头，只含小写字母、数字和连字符，最多 64 字符，并在计划内唯一。
- 日期只用 YYYY-MM-DD 或 null，结束日期不得早于开始日期。
- 连接语义为 target 依赖 source；禁止自环、重复连接和有向环。
- 内容不确定时使用默认值，不要编造技术 ID、UUID 或时间戳。`;

const fieldGuide = `sixPlan 界面字段与 JSON 字段严格对应：
- “计划名称”对应 plan.name 或 planChanges.name。
- “计划说明”对应 plan.description 或 planChanges.description。
- “计划状态”对应 plan.status 或 planChanges.status，可选值为 planning、active、completed、paused。
- “节点名称”对应 title。
- “节点状态”对应 status，可选值为 not_started、in_progress、completed、paused、abandoned。
- “开始日期”和“结束日期”对应 startDate 和 endDate。
- “简短说明”或“摘要”对应 summary，只保存简短概述。
- “附加信息”“详细内容”“详细计划”或“Markdown”对应 markdown，用于完整的 Markdown 长文本。
- “子阶段”对应节点的 steps 数组，只用于该节点内部的一层有序步骤；每项包含 key、title、status、startDate、endDate、summary。
- 子阶段不包含 Markdown、不参与连接，也不能继续嵌套。并行、分支、依赖或多层结构应建成普通节点和边。
- 不要默认给每个节点添加子阶段；只有用户想法确实包含某阶段内部的顺序拆解时才使用 steps。
- 子阶段操作应实现用户要求的实际结构语义：从无到有建立子阶段结构时，应形成多个有序部分；向已有子阶段结构追加、修改、删除或重排时，可以只操作一项。
- “画布坐标”对应 position: { x, y }，没有明确要求时不要输出，由 sixPlan 自动布局。
- summary 和 markdown 是两个独立字段；详细计划不得写入 summary。
- updateNodes 中出现 markdown 就会完整覆盖原附加信息；不修改附加信息时必须省略 markdown。`;

const changeSetContract = `sixPlan v2 增量协议（以下能力始终可用，按用户要求选择必要操作）：
- 顶层只允许 format、version、targetPlanName、baseRevision、planChanges、operations。
- planChanges 可修改 name、description、status；用户没有要求修改计划本身时省略整个 planChanges。
- operations.addNodes：新增节点对象。必填 key、title；可选 status、startDate、endDate、summary、markdown、position、createdAt、updatedAt。
- operations.updateNodes：使用 { "key": "现有节点 key", "changes": { ... } } 更新节点；changes 可包含 title、status、startDate、endDate、summary、markdown、position，且至少包含一个字段。
- operations.removeNodes：要删除的现有节点 key 字符串数组。
- operations.addEdges 和 removeEdges：使用 { "source": "前置节点 key", "target": "后继节点 key" } 表示连接。
- operations.addSteps：使用 { "nodeKey": "所属节点 key", "index": 0, "step": { ... } } 新增子阶段；index 可省略，省略时追加到末尾。
- operations.updateSteps：使用 { "nodeKey": "所属节点 key", "key": "现有子阶段 key", "changes": { ... } } 修改子阶段。
- operations.removeSteps：使用 { "nodeKey": "所属节点 key", "key": "现有子阶段 key" } 删除子阶段。
- operations.reorderSteps：使用 { "nodeKey": "所属节点 key", "keys": ["完整的子阶段 key 顺序"] } 重排；keys 必须完整且不能重复。
- operations 必须存在；所有操作数组都可省略，禁止为了补齐格式而输出无关操作。
- addNodes 中未给 status 时默认为 not_started，日期默认为 null，summary 和 markdown 默认为空字符串。
- createdAt 和 updatedAt 只用于保留已知的原始时间；当前任务中不要编造，应当省略。
- position 通常省略，sixPlan 会为新增节点自动布局。`;

export function buildSnapshotPrompt(idea: string, areaName?: string): string {
  return `你正在为 sixPlan 生成一个全新的 DAG 计划。

用户想法：
${idea.trim()}
${areaName?.trim() ? `\n建议领域：${areaName.trim()}\n` : ''}
${commonRules}
${fieldGuide}

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
      "markdown": "可选 Markdown",
      "steps": [
        { "key": "ordered-step-key", "title": "有序子阶段", "status": "not_started", "startDate": null, "endDate": null, "summary": "可选简短说明" }
      ]
    }
  ],
  "edges": [{ "source": "prerequisite-key", "target": "dependent-key" }]
}

status、日期、description、summary、markdown、steps 和 position 都可以省略。请优先生成清晰、可持续追加的阶段节点；仅在节点内部确有顺序步骤时使用 steps。不要输出 position，sixPlan 会从左到右自动布局。`;
}

export function buildChangeSetPrompt(idea: string, context: PromptContext): string {
  const scopeLabel = context.scope === 'all' ? `所有节点（${context.targetKeys.length}/${context.totalNodeCount}）`
    : context.scope === 'leaves' ? `叶节点（${context.targetKeys.length}/${context.totalNodeCount}，叶节点指没有后继节点的节点，与状态无关）`
      : `自定义节点（${context.targetKeys.length}/${context.totalNodeCount}）`;
  const readableContext = { plan: context.plan,
    nodes: context.nodes.map((node) => ({ key: node.key, title: node.title, status: node.status, startDate: node.startDate,
      endDate: node.endDate, summary: node.summary, steps: node.steps ?? [],
      ...(node.markdown === undefined ? {} : { markdown: node.markdown }) })), edges: context.edges };
  const markdownRule = context.markdownIncluded
    ? `- 已提供目标节点现有 markdown（共 ${context.markdownBytes} 字节），可用于理解和改写；若更新 markdown，仍须输出完整替换内容。`
    : '- 当前上下文故意不包含旧 markdown；任何 markdown 更新都是完整覆盖。';
  return `你正在为 sixPlan 的现有 DAG 计划生成增量变更，不要重建整个计划。

用户想法：
${idea.trim()}

操作范围：${scopeLabel}
允许操作的现有节点 key：
${JSON.stringify(context.targetKeys, null, 2)}

当前计划上下文（只读；其中可能包含不在操作范围内的参考节点）：
${JSON.stringify(readableContext, null, 2)}

${commonRules}
${fieldGuide}
${changeSetContract}
- updateNodes 和 removeNodes 只能引用“允许操作的现有节点 key”。范围外节点仅供理解，不得修改或删除。
- addSteps、updateSteps、removeSteps 和 reorderSteps 的 nodeKey 只能是“允许操作的现有节点 key”；子阶段 key 必须来自该节点上下文或本次 addSteps。
- addNodes 可以声明全新 key；涉及现有节点的新增或删除连接只能使用允许操作的 key。
- 操作范围表示哪些现有节点可以被修改，不代表必须修改范围内每一个节点；是否需要覆盖全部目标以用户想法为准。
- 当用户要求模型依据上下文从操作范围中判断或筛选目标时，必须逐一评估范围内的全部现有节点，并处理所有满足用户条件的目标，不得只选择少数代表性目标。
- 如果用户明确说“每个”“全部”或“所有”，应对操作范围内的每一个目标节点完成要求。
- 只能引用上下文中已有的 key，或本次 addNodes 中声明的新 key。
- 采用最小变更原则，只输出实现用户想法所必需的字段和操作。最小变更只用于避免无关字段和无关操作，不得用于遗漏满足用户条件的目标；也不得因为用户提到某个字段，就忽略其同时提出的其他操作。
- 除非用户明确要求修改计划本身，否则不要输出 planChanges。
- 不能归档、恢复、移动领域或删除整个计划。
${markdownRule}

以下两个值是只读常量，必须逐字复制，禁止翻译、简称、改写或猜测：
- targetPlanName = ${JSON.stringify(context.plan.name)}
- baseRevision = ${context.plan.graphRevision}

输出必须以这个骨架为基础，并按用户要求填入必要操作。不要复制占位文本，也不要为了展示协议而制造无关变更：
{
  "format": "sixplan-plan-changeset",
  "version": 2,
  "targetPlanName": ${JSON.stringify(context.plan.name)},
  "baseRevision": ${context.plan.graphRevision},
  "operations": {}
}

输出前逐项自检：目标计划名和版本未变化、完整理解了用户的组合要求、已完整评估用户要求判断或筛选的操作范围、所有满足用户条件的目标均已处理、没有用最小变更原则遗漏必要目标、结构变化实现了用户表达的实际语义、操作范围和字段映射正确、没有无关修改。`;
}

export function buildRepairPrompt(rawJson: string, error: string): string {
  return `下面的 sixPlan v2 JSON 校验失败。请只修复格式或数据错误，保持原始业务意图，不要增加解释或代码围栏。

校验错误：
${error}

${fieldGuide}
${changeSetContract}
- 保留原始 targetPlanName 和 baseRevision，不要翻译、简称、改写或猜测。
- 只修复错误，不要把完整协议中的示例能力都变成实际操作。

原始 JSON：
${rawJson}`;
}
