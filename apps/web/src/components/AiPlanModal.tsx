import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Check, Clipboard, Download, FileJson, Leaf, ListChecks, RefreshCw, Sparkles, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { AreaDto, ImportPreviewDto, PlanDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';
import { buildChangeSetPrompt, buildRepairPrompt, buildSnapshotPrompt, type PromptContext } from '../ai-prompts';
import { copyText } from '../clipboard';
import { Modal } from './Dialogs';

type Mode = 'snapshot' | 'changeset';
const PromptScopeGraph = lazy(() => import('./PromptScopeGraph').then((module) => ({ default: module.PromptScopeGraph })));

function extractJson(text: string): string {
  const matches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (matches.length === 1) {
    if (!window.confirm('检测到一个 JSON 代码块。是否提取代码块内容后校验？')) throw new Error('cancelled');
    return matches[0]![1]!.trim();
  }
  return text.trim();
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AiPlanModal({ mode, areas, onClose, onApplied }: {
  mode: Mode | null; areas: AreaDto[]; onClose: () => void; onApplied: (plan: PlanDto) => Promise<void>;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const promptOutput = useRef<HTMLTextAreaElement>(null); const repairOutput = useRef<HTMLTextAreaElement>(null);
  const [idea, setIdea] = useState(''); const [areaHint, setAreaHint] = useState(''); const [planId, setPlanId] = useState('');
  const [overview, setOverview] = useState<PromptContext | null>(null); const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [generatedTargetKeys, setGeneratedTargetKeys] = useState<string[]>([]); const [includeMarkdown, setIncludeMarkdown] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false); const [contextBusy, setContextBusy] = useState(false);
  const [plans, setPlans] = useState<PlanDto[]>([]); const [prompt, setPrompt] = useState(''); const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<ImportPreviewDto | null>(null); const [repairPrompt, setRepairPrompt] = useState('');
  const [areaMode, setAreaMode] = useState<'existing' | 'create'>('existing'); const [targetAreaId, setTargetAreaId] = useState('');
  const [createAreaName, setCreateAreaName] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    api<{ plans: PlanDto[] }>('/api/plans').then(({ plans: values }) => { setPlans(values); setPlanId((current) => current || values[0]?.id || ''); }).catch(() => undefined);
  }, [mode]);
  useEffect(() => {
    if (!mode) return;
    setIdea(''); setAreaHint(''); setPrompt(''); setRaw(''); setPreview(null); setRepairPrompt(''); setOverview(null);
    setSelectedKeys([]); setGeneratedTargetKeys([]); setIncludeMarkdown(false); setAdvancedOpen(false);
    setAreaMode('existing'); setTargetAreaId(areas[0]?.id ?? ''); setCreateAreaName('');
  }, [areas, mode]);
  useEffect(() => {
    if (mode !== 'changeset' || !planId) { setOverview(null); setSelectedKeys([]); return; }
    let active = true; setOverview(null); setSelectedKeys([]);
    api<{ context: PromptContext }>(`/api/plans/${planId}/prompt-context`).then(({ context }) => {
      if (active) { setOverview(context); setSelectedKeys(context.targetKeys); }
    }).catch(() => { if (active) setOverview(null); });
    return () => { active = false; };
  }, [mode, planId]);

  const selectedPlan = plans.find((plan) => plan.id === planId);
  const selectedSet = new Set(selectedKeys);
  const selectedMarkdownBytes = overview?.nodes.filter((node) => selectedSet.has(node.key)).reduce((total, node) => total + node.markdownBytes, 0) ?? 0;

  function discardPreviewSession() {
    if (preview) void api(`/api/import-sessions/${preview.sessionId}`, { method: 'DELETE' }).catch(() => undefined);
  }

  function changeSelection(keys: string[]) {
    discardPreviewSession();
    setSelectedKeys(keys); setGeneratedTargetKeys([]); setPrompt(''); setRaw(''); setRepairPrompt(''); setPreview(null);
  }

  function changeMarkdownContext(checked: boolean) {
    discardPreviewSession();
    setIncludeMarkdown(checked); setGeneratedTargetKeys([]); setPrompt(''); setRaw(''); setRepairPrompt(''); setPreview(null);
  }

  function changePlan(nextPlanId: string) {
    discardPreviewSession(); setPlanId(nextPlanId); setOverview(null); setSelectedKeys([]); setGeneratedTargetKeys([]);
    setPrompt(''); setRaw(''); setRepairPrompt(''); setPreview(null);
  }

  function changeIdea(nextIdea: string) {
    if (nextIdea !== idea && (prompt || preview)) {
      discardPreviewSession(); setGeneratedTargetKeys([]); setPrompt(''); setRaw(''); setRepairPrompt(''); setPreview(null);
    }
    setIdea(nextIdea);
  }

  async function makePrompt() {
    if (!idea.trim()) return toast.error('请先描述你想要的计划或变更');
    if (mode === 'snapshot') setPrompt(buildSnapshotPrompt(idea, areaHint));
    else {
      if (!overview) return toast.error('正在加载计划上下文');
      if (!selectedKeys.length) return toast.error('请至少选择一个操作节点');
      setContextBusy(true);
      try {
        const { context } = await api<{ context: PromptContext }>(`/api/plans/${planId}/prompt-context`, { method: 'POST',
          body: JSON.stringify({ targetKeys: selectedKeys, includeMarkdown }) });
        setPrompt(buildChangeSetPrompt(idea, context)); setGeneratedTargetKeys(context.targetKeys);
      } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '计划上下文加载失败'); }
      finally { setContextBusy(false); }
    }
    setRepairPrompt('');
  }
  async function copy(value: string, output?: HTMLTextAreaElement | null) {
    try { await copyText(value); toast.success('已复制到剪贴板'); }
    catch { output?.focus(); output?.select(); toast.error('浏览器阻止了自动复制，内容已选中'); }
  }

  async function validate(content: string, sourceName = 'pasted.json') {
    let json: string;
    try { json = extractJson(content); if (!json) return toast.error('请粘贴模型返回的 JSON'); JSON.parse(json); }
    catch (error) { if (error instanceof Error && error.message === 'cancelled') return; setRepairPrompt(buildRepairPrompt(content, '不是有效的 JSON 文本')); return toast.error('不是有效的 JSON 文本'); }
    setBusy(true); setRepairPrompt('');
    try {
      const result = await api<{ preview: ImportPreviewDto }>('/api/import-sessions/json', { method: 'POST', body: JSON.stringify({ content: json, sourceName,
        ...(mode === 'changeset' ? { targetPlanId: planId, promptTargetKeys: generatedTargetKeys.length ? generatedTargetKeys : selectedKeys } : {}) }) });
      setRaw(json); setPreview(result.preview);
      if (result.preview.kind === 'snapshot') {
        const matching = areas.find((area) => area.name.toLocaleLowerCase() === (result.preview.suggestedAreaName ?? '').toLocaleLowerCase());
        if (matching) { setAreaMode('existing'); setTargetAreaId(matching.id); }
        else if (result.preview.suggestedAreaName) { setAreaMode('create'); setCreateAreaName(result.preview.suggestedAreaName); }
      }
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : '校验失败'; setRepairPrompt(buildRepairPrompt(json, message)); toast.error(message);
    } finally { setBusy(false); }
  }

  async function upload(file: File | undefined) {
    if (!file) return; setBusy(true); setRepairPrompt('');
    try {
      const form = new FormData();
      let query = '';
      if (mode === 'changeset') {
        form.append('promptTargetKeys', JSON.stringify(generatedTargetKeys.length ? generatedTargetKeys : selectedKeys));
        query = `?${new URLSearchParams({ targetPlanId: planId })}`;
      }
      form.append('file', file);
      const result = await api<{ preview: ImportPreviewDto }>(`/api/import-sessions/upload${query}`, { method: 'POST', body: form });
      setRaw(''); setPreview(result.preview);
      if (result.preview.kind === 'snapshot') {
        const matching = areas.find((area) => area.name.toLocaleLowerCase() === (result.preview.suggestedAreaName ?? '').toLocaleLowerCase());
        if (matching) { setAreaMode('existing'); setTargetAreaId(matching.id); }
        else if (result.preview.suggestedAreaName) { setAreaMode('create'); setCreateAreaName(result.preview.suggestedAreaName); }
      }
    } catch (error) { const message = error instanceof ApiClientError ? error.message : '上传校验失败'; toast.error(message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function apply(confirmedRevision?: number) {
    if (!preview) return;
    if (preview.kind === 'snapshot' && areaMode === 'existing' && !targetAreaId) return toast.error('请选择目标领域');
    if (preview.kind === 'snapshot' && areaMode === 'create' && !createAreaName.trim()) return toast.error('请输入新领域名称');
    if (preview.removeNodeCount + preview.removeEdgeCount > 0 && !window.confirm(`本次会删除 ${preview.removeNodeCount} 个节点和 ${preview.removeEdgeCount} 条连接。是否继续？`)) return;
    setBusy(true);
    try {
      const body = preview.kind === 'snapshot'
        ? areaMode === 'existing' ? { targetAreaId } : { createAreaName }
        : { ...(confirmedRevision ? { confirmedRevision } : {}) };
      const { plan } = await api<{ plan: PlanDto }>(`/api/import-sessions/${preview.sessionId}/apply`, { method: 'POST', body: JSON.stringify(body) });
      toast.success(preview.kind === 'snapshot' ? '新计划已导入' : '计划增量已应用'); await onApplied(plan); onClose();
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'REVISION_RECONFIRM_REQUIRED' && error.details) {
        const refreshed = error.details as ImportPreviewDto; setPreview({ ...refreshed, sessionId: preview.sessionId });
        if (window.confirm('计划图在提示词生成后发生了变化。变更已在最新图上重新校验，是否查看刷新后的预览并再次确认？')) toast.warning('预览已刷新，请再次点击应用');
      } else toast.error(error instanceof ApiClientError ? error.message : '应用失败');
    } finally { setBusy(false); }
  }

  async function close() {
    if (preview) await api(`/api/import-sessions/${preview.sessionId}`, { method: 'DELETE' }).catch(() => undefined);
    onClose();
  }

  return <Modal open={Boolean(mode)} onOpenChange={(open) => { if (!open) void close(); }}
    title={mode === 'snapshot' ? 'AI 生成新计划' : 'AI 扩展现有计划'} description="sixPlan 只构造提示词和校验 JSON，不会连接或调用任何大模型。" wide>
    <div className="ai-workflow">
      <section className="ai-step"><div className="ai-step-title"><span>1</span><strong>描述需求</strong></div>
        {mode === 'changeset' && <label>目标计划<select value={planId} onChange={(event) => changePlan(event.target.value)}>{plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {plan.areaName}</option>)}</select></label>}
        <label>你的想法<textarea rows={4} value={idea} onChange={(event) => changeIdea(event.target.value)} placeholder={mode === 'snapshot' ? '例如：为半程马拉松准备一个分阶段训练计划' : '例如：在当前阶段后追加四周恢复训练'} /></label>
        <details className="ai-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}><summary>{mode === 'changeset' ? '上下文设置' : '高级选项'}</summary>
          {mode === 'snapshot' ? <label>建议领域<input value={areaHint} onChange={(event) => setAreaHint(event.target.value)} placeholder="可选，导入时仍由你确认" /></label>
          : <><div className="scope-control"><span>操作范围</span>
              {advancedOpen && overview ? <Suspense fallback={<div className="prompt-scope-loading"><span className="spinner" />加载节点图</div>}><PromptScopeGraph nodes={overview.nodes} edges={overview.edges} selectedKeys={selectedKeys} onSelectedKeysChange={changeSelection} /></Suspense> : <div className="prompt-scope-loading"><span className="spinner" />加载节点图</div>}
              <div className="scope-shortcuts"><div><button className="secondary-button" onClick={() => overview && changeSelection(overview.nodes.map((node) => node.key))}><ListChecks size={15} />选择全部</button><button className="secondary-button" onClick={() => overview && changeSelection(overview.leafKeys)}><Leaf size={15} />仅选择叶节点</button></div><span>已选择 {selectedKeys.length} / {overview?.totalNodeCount ?? selectedPlan?.nodeCount ?? 0}</span></div>
            </div>
            <div className="markdown-context"><div><strong>附加信息上下文</strong><span>预计 {formatBytes(selectedMarkdownBytes)}</span></div><label className="toggle-control"><input type="checkbox" checked={includeMarkdown} onChange={(event) => changeMarkdownContext(event.target.checked)} /><span />包含目标节点 Markdown</label></div>
            {selectedKeys.length > 200 && <div className="notice warning">当前选择包含 {selectedKeys.length} 个节点，生成的上下文可能超过部分模型的输入限制。</div>}
            {includeMarkdown && selectedMarkdownBytes > 200 * 1024 && <div className="notice warning">目标节点 Markdown 约 {formatBytes(selectedMarkdownBytes)}，请确认外部模型的上下文容量足够。</div>}</>}
        </details>
        <button className="primary-button" disabled={busy || contextBusy || (mode === 'changeset' && (!selectedPlan || !selectedKeys.length))} onClick={makePrompt}><Sparkles size={17} />{contextBusy ? '正在构造' : '构造提示词'}</button>
      </section>

      {prompt && <section className="ai-step"><div className="ai-step-title"><span>2</span><strong>交给外部大模型</strong></div>
        <textarea ref={promptOutput} className="prompt-output" aria-label="生成的提示词" rows={12} value={prompt} readOnly />
        <div className="inline-actions"><button className="secondary-button" onClick={() => copy(prompt, promptOutput.current)}><Clipboard size={16} />复制提示词</button><button className="secondary-button" onClick={() => downloadText(prompt, mode === 'snapshot' ? 'sixplan-new-plan-prompt.txt' : 'sixplan-extend-plan-prompt.txt')}><Download size={16} />下载 TXT</button></div>
      </section>}

      <section className="ai-step"><div className="ai-step-title"><span>{prompt ? '3' : '2'}</span><strong>校验模型返回</strong></div>
        <label>粘贴 JSON<textarea rows={7} value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="粘贴模型返回的 JSON；也可以直接上传 .json 文件" /></label>
        <div className="inline-actions"><button className="secondary-button" disabled={busy || !raw.trim() || (mode === 'changeset' && !selectedKeys.length)} onClick={() => validate(raw)}><FileJson size={16} />校验并预览</button><input ref={fileInput} type="file" accept=".json,.plan.json" hidden onChange={(event) => upload(event.target.files?.[0])} /><button className="secondary-button" disabled={busy || (mode === 'changeset' && (!planId || !selectedKeys.length))} onClick={() => fileInput.current?.click()}><Upload size={16} />上传 JSON</button></div>
        {repairPrompt && <div className="repair-box"><strong>可生成修复提示词</strong><textarea ref={repairOutput} rows={8} value={repairPrompt} readOnly /><button className="secondary-button" onClick={() => copy(repairPrompt, repairOutput.current)}><RefreshCw size={16} />复制修复提示词</button></div>}
      </section>

      {preview && <section className="ai-step preview-step"><div className="ai-step-title"><span><Check size={14} /></span><strong>确认预览</strong></div>
        <div className="preview-stats"><div><strong>{preview.nodeCount}</strong><span>最终节点</span></div><div><strong>{preview.edgeCount}</strong><span>最终连接</span></div><div><strong>+{preview.addNodeCount}</strong><span>新增节点</span></div><div className={preview.removeNodeCount ? 'danger-stat' : ''}><strong>-{preview.removeNodeCount}</strong><span>删除节点</span></div></div>
        {preview.revisionChanged && <div className="notice warning">JSON 的基础版本为 {preview.baseRevision}，当前图版本已变化。系统已在最新图上重新校验，应用前会再次确认。</div>}
        <div className="preview-list">{preview.previewNodes.map((node) => <div className={`preview-row change-${node.change}`} key={`${node.change}-${node.key}`}><span>{node.change === 'add' ? '+' : node.change === 'remove' ? '-' : '~'}</span><strong>{node.title}</strong><code>{node.key}</code></div>)}</div>
        {preview.kind === 'snapshot' && <div className="area-decision"><label>目标方式<select value={areaMode} onChange={(event) => setAreaMode(event.target.value as 'existing' | 'create')}><option value="existing">选择已有领域</option><option value="create">创建新领域</option></select></label>{areaMode === 'existing' ? <label>目标领域<select value={targetAreaId} onChange={(event) => setTargetAreaId(event.target.value)}>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label> : <label>新领域名称<input value={createAreaName} onChange={(event) => setCreateAreaName(event.target.value)} /></label>}</div>}
        <button className={preview.removeNodeCount + preview.removeEdgeCount > 0 ? 'danger-button' : 'primary-button'} disabled={busy} onClick={() => apply(preview.revisionChanged ? preview.currentRevision : undefined)}>{busy ? '正在应用' : preview.kind === 'snapshot' ? '创建新计划' : '应用增量变更'}</button>
      </section>}
    </div>
  </Modal>;
}
