export interface PromptContextNode {
  key: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  summary: string;
  position: { x: number; y: number };
  markdownBytes: number;
  markdown?: string;
}

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

export interface TreePromptContextPlan extends PromptContext {
  plan: PromptContext['plan'] & { id: string; key: string; areaName: string };
}

export interface TreePromptContext {
  rootPlanKey: string;
  scope: 'current' | 'descendants' | 'custom';
  plans: TreePromptContextPlan[];
  links: Array<{ parentPlanKey: string; parentNodeKey: string; childPlanKey: string }>;
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
- operations 必须存在；五个操作数组都可省略，禁止为了补齐格式而输出无关操作。
- addNodes 中未给 status 时默认为 not_started，日期默认为 null，summary 和 markdown 默认为空字符串。
- createdAt 和 updatedAt 只用于保留已知的原始时间；当前任务中不要编造，应当省略。
- position 通常省略，sixPlan 会为新增节点自动布局。`;

const bundleContract = `sixPlan 计划树包协议：
- 顶层固定为 format、version、rootPlanKey、plans、links。
- format = "sixplan-plan-bundle"，version = 1；rootPlanKey 指向唯一根计划。
- plans 中每项包含 key、areaName、plan、nodes、edges；计划和图字段与单计划快照一致。
- links 中每项为 { parentPlanKey, parentNodeKey, childPlanKey }，表示父计划的节点关联一个子计划。
- 每个父节点最多关联一个子计划，每个子计划最多一个父节点；除根计划外每个计划必须恰好被关联一次，且层级不能成环。
- 计划 key 和节点 key 使用稳定、可读、唯一的短横线格式；不要生成 UUID、数据库 ID 或时间戳。
- 新计划不得设置 archivedAt；没有明确要求时省略 position，由 sixPlan 自动布局。`;

const treeChangeSetContract = `sixPlan 计划树增量协议：
- 顶层固定为 format、version、targetRootPlanKey、baseRevisions、operations。
- format = "sixplan-plan-tree-changeset"，version = 1；targetRootPlanKey 和 baseRevisions 必须逐字复制上下文常量。
- operations.addPlans 新增计划，每项包含 key、plan、nodes、edges；新增计划必须通过 addLinks 接入当前树。
- operations.updatePlans 更新已有计划，每项包含 planKey，可选 planChanges 和 graph；graph 使用单计划 v2 的五类节点/连接操作。
- operations.addLinks 使用 { parentPlanKey, parentNodeKey, childPlanKey }；removeLinks 使用 { childPlanKey }。
- 可以创建、更新计划/节点/连接/关联，也可以解除关联；不能归档、恢复、移动领域或永久删除计划。
- 使用最小必要操作，不要为了展示协议能力而补齐空数组或制造无关变更。`;

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
      "markdown": "可选 Markdown"
    }
  ],
  "edges": [{ "source": "prerequisite-key", "target": "dependent-key" }]
}

status、日期、description、summary、markdown 和 position 都可以省略。请优先生成清晰、可持续追加的阶段节点；不要输出 position，sixPlan 会从左到右自动布局。`;
}

export function buildBundlePrompt(idea: string, areaName?: string): string {
  return `你正在为 sixPlan 生成一个全新的完整计划树。计划树由普通计划组成，父计划节点可以关联子计划。

用户想法：
${idea.trim()}
${areaName?.trim() ? `\n建议领域：${areaName.trim()}\n` : ''}
${commonRules}
${fieldGuide}
${bundleContract}

输出骨架：
{
  "format": "sixplan-plan-bundle",
  "version": 1,
  "rootPlanKey": "root-plan-key",
  "plans": [{ "key": "root-plan-key", "areaName": "领域", "plan": { "name": "计划名称", "status": "planning" }, "nodes": [], "edges": [] }],
  "links": []
}

根据用户的结构意图决定是否需要子计划。简单需求可以只有根计划；需要分层时再创建子计划。每个计划都应是可独立理解和编辑的普通 DAG 计划。只输出最终 JSON。`;
}

export function buildChangeSetPrompt(idea: string, context: PromptContext): string {
  const scopeLabel = context.scope === 'all' ? `所有节点（${context.targetKeys.length}/${context.totalNodeCount}）`
    : context.scope === 'leaves' ? `叶节点（${context.targetKeys.length}/${context.totalNodeCount}，叶节点指没有后继节点的节点，与状态无关）`
      : `自定义节点（${context.targetKeys.length}/${context.totalNodeCount}）`;
  const readableContext = { plan: context.plan,
    nodes: context.nodes.map((node) => ({ key: node.key, title: node.title, status: node.status, startDate: node.startDate,
      endDate: node.endDate, summary: node.summary, ...(node.markdown === undefined ? {} : { markdown: node.markdown }) })), edges: context.edges };
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
- addNodes 可以声明全新 key；涉及现有节点的新增或删除连接只能使用允许操作的 key。
- 操作范围表示哪些现有节点可以被修改，不代表必须修改范围内每一个节点；是否需要覆盖全部目标以用户想法为准。
- 如果用户明确说“每个”“全部”或“所有”，应对操作范围内的每一个目标节点完成要求。
- 只能引用上下文中已有的 key，或本次 addNodes 中声明的新 key。
- 采用最小变更原则，只输出实现用户想法所必需的字段和操作；但不得因为用户提到某个字段，就忽略其同时提出的其他操作。
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

输出前逐项自检：目标计划名和版本未变化、完整理解了用户的组合要求、操作范围正确、字段映射正确、没有无关修改、用户明确要求的所有目标均已处理。`;
}

export function buildTreeChangeSetPrompt(idea: string, context: TreePromptContext): string {
  const readable = { rootPlanKey: context.rootPlanKey, scope: context.scope,
    plans: context.plans.map((item) => ({ plan: item.plan, targetKeys: item.targetKeys,
      nodes: item.nodes.map((node) => ({ key: node.key, title: node.title, status: node.status, startDate: node.startDate,
        endDate: node.endDate, summary: node.summary, ...(node.markdown === undefined ? {} : { markdown: node.markdown }) })), edges: item.edges })),
    links: context.links };
  const baseRevisions = context.plans.map((item) => ({ planKey: item.plan.key, graphRevision: item.plan.graphRevision }));
  return `你正在为 sixPlan 的现有计划树生成增量变更。不要重建未要求改变的内容。

用户想法：
${idea.trim()}

当前只读上下文：
${JSON.stringify(readable, null, 2)}

${commonRules}
${fieldGuide}
${changeSetContract}
${treeChangeSetContract}
- updatePlans 只能引用上下文中的计划 key；其中 updateNodes/removeNodes 只能引用该计划 targetKeys 中的现有节点。
- 新关联若引用现有父节点，该节点必须位于对应计划的 targetKeys；范围外内容仅供理解。
- 用户没有要求改变某个计划、节点、连接或关联时保持不变。完整理解组合要求后选择最小必要操作。

以下常量必须逐字复制：
- targetRootPlanKey = ${JSON.stringify(context.rootPlanKey)}
- baseRevisions = ${JSON.stringify(baseRevisions)}

输出骨架：
{
  "format": "sixplan-plan-tree-changeset",
  "version": 1,
  "targetRootPlanKey": ${JSON.stringify(context.rootPlanKey)},
  "baseRevisions": ${JSON.stringify(baseRevisions)},
  "operations": {}
}

只输出实现用户要求所需的最终 JSON，不要输出解释。`;
}

export function buildRepairPrompt(rawJson: string, error: string, protocol: 'single' | 'bundle' | 'tree' = 'single'): string {
  return `下面的 sixPlan v2 JSON 校验失败。请只修复格式或数据错误，保持原始业务意图，不要增加解释或代码围栏。

校验错误：
${error}

${fieldGuide}
${protocol === 'bundle' ? bundleContract : protocol === 'tree' ? `${changeSetContract}\n${treeChangeSetContract}` : changeSetContract}
- 保留原始协议中的目标计划 key、名称和基础版本，不要翻译、简称、改写或猜测。
- 只修复错误，不要把完整协议中的示例能力都变成实际操作。

原始 JSON：
${rawJson}`;
}
