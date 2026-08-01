import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowUp, Download, FileInput, FileUp, Folder, FolderInput, FolderPlus, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { planStatusLabels, type AreaDto, type ImportResult, type PlanDto, type PlanStatus } from '@sixplan/shared';
import { api, ApiClientError, downloadFile } from '../api';
import { ConfirmDialog, Modal } from '../components/Dialogs';

type Selection = 'all' | 'archived' | string;

export function OverviewPage() {
  const queryClient = useQueryClient(); const navigate = useNavigate(); const [searchParams] = useSearchParams();
  const [selection, setSelection] = useState<Selection>(() => searchParams.get('view') === 'archived' ? 'archived' : 'all');
  const [areaModal, setAreaModal] = useState<{ open: boolean; area?: AreaDto }>({ open: false });
  const [planModal, setPlanModal] = useState<{ open: boolean; plan?: PlanDto }>({ open: false });
  const [movePlan, setMovePlan] = useState<PlanDto | null>(null); const [confirm, setConfirm] = useState<{ plan: PlanDto; kind: 'archive' | 'delete' } | null>(null);
  const [importMode, setImportMode] = useState<'plan' | 'area' | null>(null);
  const areasQuery = useQuery({ queryKey: ['areas'], queryFn: () => api<{ areas: AreaDto[] }>('/api/areas') });
  const plansQuery = useQuery({ queryKey: ['plans', selection], queryFn: () => selection === 'archived'
    ? api<{ plans: PlanDto[] }>('/api/plans/archived')
    : api<{ plans: PlanDto[] }>(`/api/plans${selection === 'all' ? '' : `?areaId=${selection}`}`) });
  const areas = useMemo(() => areasQuery.data?.areas ?? [], [areasQuery.data]);
  const plans = useMemo(() => plansQuery.data?.plans ?? [], [plansQuery.data]);

  async function refresh() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['areas'] }), queryClient.invalidateQueries({ queryKey: ['plans'] })]); }
  async function mutatePlan(path: string, body: unknown, success: string, method = 'POST') {
    try { await api(path, { method, body: JSON.stringify(body) }); toast.success(success); await refresh(); }
    catch (error) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }
  }
  async function reorder(area: AreaDto, direction: -1 | 1) {
    const index = areas.findIndex((item) => item.id === area.id); const other = areas[index + direction]; if (!other) return;
    await api('/api/areas/order', { method: 'PUT', body: JSON.stringify({ items: [
      { id: area.id, sortOrder: other.sortOrder, expectedVersion: area.version },
      { id: other.id, sortOrder: area.sortOrder, expectedVersion: other.version }
    ] }) }); await refresh();
  }
  async function deleteArea(area: AreaDto) {
    if (!window.confirm(`确定删除领域“${area.name}”？`)) return;
    try { await api(`/api/areas/${area.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: area.version }) });
      if (selection === area.id) setSelection('all'); await refresh(); toast.success('领域已删除');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '删除失败'); }
  }
  const grouped = useMemo(() => areas.map((area) => ({ area, plans: plans.filter((plan) => plan.areaId === area.id) })).filter((group) => group.plans.length > 0), [areas, plans]);
  return <div className="overview-layout">
    <aside className="area-sidebar">
      <div className="sidebar-heading"><span>领域</span><button className="icon-button" title="新建领域" onClick={() => setAreaModal({ open: true })}><FolderPlus size={17} /></button></div>
      <button className={`area-nav ${selection === 'all' ? 'active' : ''}`} onClick={() => setSelection('all')}><Folder size={17} /><span>全部计划</span></button>
      <div className="area-list">{areas.map((area, index) => <div className={`area-row ${selection === area.id ? 'active' : ''}`} key={area.id}>
        <button className="area-main" onClick={() => setSelection(area.id)}><span>{area.name}</span><small>{area.planCount}</small></button>
        <div className="area-actions">
          <button className="mini-icon" title="上移" disabled={index === 0} onClick={() => reorder(area, -1)}><ArrowUp size={13} /></button>
          <button className="mini-icon" title="下移" disabled={index === areas.length - 1} onClick={() => reorder(area, 1)}><ArrowDown size={13} /></button>
          <DropdownMenu.Root><DropdownMenu.Trigger className="mini-icon" aria-label={`${area.name}领域操作`}><MoreHorizontal size={13} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="start">
            <DropdownMenu.Item onSelect={() => setAreaModal({ open: true, area })}><Pencil size={15} />重命名</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => downloadFile(`/api/areas/${area.id}/export`).catch(showError)}><Download size={15} />导出领域</DropdownMenu.Item>
            <DropdownMenu.Item className="menu-danger" onSelect={() => deleteArea(area)}><Trash2 size={15} />删除</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </div></div>)}</div>
      <button className={`area-nav archive-nav ${selection === 'archived' ? 'active' : ''}`} onClick={() => setSelection('archived')}><Archive size={17} /><span>已归档</span><small>{areas.reduce((sum, area) => sum + area.archivedPlanCount, 0)}</small></button>
    </aside>
    <section className="overview-content">
      <div className="page-heading"><div><p className="eyebrow">计划空间</p><h1>{selection === 'all' ? '全部计划' : selection === 'archived' ? '已归档' : areas.find((area) => area.id === selection)?.name ?? '计划'}</h1>
        <p>{selection === 'archived' ? '归档计划保持只读，可随时恢复或导出。' : `${plans.length} 个计划`}</p></div>
        <div className="heading-actions"><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="secondary-button"><FileUp size={17} />导入</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item onSelect={() => setImportMode('plan')}><FileInput size={15} />导入计划</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setImportMode('area')}><FolderInput size={15} />导入领域</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          {selection !== 'archived' && <button className="primary-button" disabled={areas.length === 0} onClick={() => setPlanModal({ open: true })}><Plus size={17} />新建计划</button>}</div></div>
      {areas.length === 0 ? <EmptyState icon={<FolderPlus size={28} />} title="先创建一个领域" body="领域用于组织工作、学习和生活中的不同计划。" action={() => setAreaModal({ open: true })} actionLabel="新建领域" />
      : plansQuery.isLoading ? <div className="page-loader"><span className="spinner" />加载计划</div>
      : plans.length === 0 ? <EmptyState icon={selection === 'archived' ? <Archive size={28} /> : <Plus size={28} />} title={selection === 'archived' ? '还没有归档计划' : '这个视图还没有计划'} body={selection === 'archived' ? '归档后的计划会集中显示在这里。' : '创建计划后即可开始搭建 DAG。'} action={selection === 'archived' ? undefined : () => setPlanModal({ open: true })} actionLabel="新建计划" />
      : selection === 'archived' ? <div className="archive-groups">{grouped.map(({ area, plans: areaPlans }) => <section className="archive-group" key={area.id}><h2>{area.name}<span>{areaPlans.length}</span></h2><div className="plan-grid">{areaPlans.map((plan) => <PlanCard key={plan.id} plan={plan} onOpen={() => navigate(`/plans/${plan.id}`)} onExport={() => downloadFile(`/api/plans/${plan.id}/export`).catch(showError)} onRestore={() => mutatePlan(`/api/plans/${plan.id}/restore`, { expectedVersion: plan.version }, '计划已恢复')} onDelete={() => setConfirm({ plan, kind: 'delete' })} />)}</div></section>)}</div>
      : <div className="plan-grid">{plans.map((plan) => <PlanCard key={plan.id} plan={plan} onOpen={() => navigate(`/plans/${plan.id}`)} onEdit={() => setPlanModal({ open: true, plan })} onMove={() => setMovePlan(plan)} onExport={() => downloadFile(`/api/plans/${plan.id}/export`).catch(showError)} onArchive={() => setConfirm({ plan, kind: 'archive' })} />)}</div>}
    </section>
    <AreaEditor state={areaModal} onClose={() => setAreaModal({ open: false })} onSaved={refresh} />
    <PlanEditor state={planModal} areas={areas} preferredAreaId={selection !== 'all' && selection !== 'archived' ? selection : undefined} onClose={() => setPlanModal({ open: false })} onSaved={refresh} />
    <MovePlanModal plan={movePlan} areas={areas} onClose={() => setMovePlan(null)} onSaved={refresh} />
    <ImportPlansModal open={importMode === 'plan'} areas={areas} existingPlans={plans} onClose={() => setImportMode(null)} onImported={refresh} />
    <ImportAreaModal open={importMode === 'area'} areas={areas} onClose={() => setImportMode(null)} onImported={refresh} />
    <ConfirmDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)} title={confirm?.kind === 'archive' ? '归档计划' : '永久删除计划'}
      description={confirm?.kind === 'archive' ? `“${confirm?.plan.name}”归档后将变为只读并移入已归档视图。` : `“${confirm?.plan.name}”及其全部节点和连接将永久删除，此操作无法撤销。`}
      confirmLabel={confirm?.kind === 'archive' ? '确认归档' : '永久删除'} danger={confirm?.kind === 'delete'} onConfirm={async () => { if (!confirm) return;
        await mutatePlan(`/api/plans/${confirm.plan.id}${confirm.kind === 'archive' ? '/archive' : ''}`, { expectedVersion: confirm.plan.version }, confirm.kind === 'archive' ? '计划已归档' : '计划已永久删除', confirm.kind === 'delete' ? 'DELETE' : 'POST'); setConfirm(null); }} />
  </div>;
}

function showError(error: unknown) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }

function EmptyState({ icon, title, body, action, actionLabel }: { icon: React.ReactNode; title: string; body: string; action?: () => void; actionLabel: string }) {
  return <div className="empty-state"><span>{icon}</span><h2>{title}</h2><p>{body}</p>{action && <button className="primary-button" onClick={action}><Plus size={17} />{actionLabel}</button>}</div>;
}

function PlanCard({ plan, onOpen, onEdit, onMove, onExport, onArchive, onRestore, onDelete }: { plan: PlanDto; onOpen: () => void; onEdit?: () => void; onMove?: () => void; onExport: () => void; onArchive?: () => void; onRestore?: () => void; onDelete?: () => void }) {
  return <article className="plan-card" onDoubleClick={onOpen}><div className="plan-card-top"><span className={`status-pill status-${plan.status}`}>{planStatusLabels[plan.status]}</span>
    <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label="计划操作"><MoreHorizontal size={18} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
      {onEdit && <DropdownMenu.Item onSelect={onEdit}><Pencil size={15} />编辑信息</DropdownMenu.Item>}{onMove && <DropdownMenu.Item onSelect={onMove}><Folder size={15} />移动领域</DropdownMenu.Item>}
      <DropdownMenu.Item onSelect={onExport}><Download size={15} />导出计划</DropdownMenu.Item>{onArchive && <DropdownMenu.Item onSelect={onArchive}><Archive size={15} />归档</DropdownMenu.Item>}
      {onRestore && <DropdownMenu.Item onSelect={onRestore}><RotateCcw size={15} />恢复</DropdownMenu.Item>}{onDelete && <DropdownMenu.Item className="menu-danger" onSelect={onDelete}><Trash2 size={15} />永久删除</DropdownMenu.Item>}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
    <button className="plan-card-body" onClick={onOpen}><h2>{plan.name}</h2><p>{plan.description || '暂无说明'}</p></button>
    <div className="plan-card-meta"><span>{plan.areaName}</span><span>{plan.nodeCount} 个节点</span><time>{new Date(plan.archivedAt ?? plan.updatedAt).toLocaleDateString('zh-CN')}</time></div></article>;
}

function AreaEditor({ state, onClose, onSaved }: { state: { open: boolean; area?: AreaDto }; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('');
  useEffect(() => { if (state.open) setName(state.area?.name ?? ''); }, [state.area, state.open]);
  function openChanged(open: boolean) { if (!open) onClose(); }
  async function submit(event: FormEvent) { event.preventDefault(); try { await api(state.area ? `/api/areas/${state.area.id}` : '/api/areas', { method: state.area ? 'PATCH' : 'POST', body: JSON.stringify(state.area ? { name, expectedVersion: state.area.version } : { name }) }); await onSaved(); onClose(); toast.success(state.area ? '领域已更新' : '领域已创建'); } catch (error) { showError(error); } }
  return <Modal open={state.open} onOpenChange={openChanged} title={state.area ? '重命名领域' : '新建领域'}><form className="stack-form" onSubmit={submit}><label>领域名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存</button></div></form></Modal>;
}

function PlanEditor({ state, areas, preferredAreaId, onClose, onSaved }: { state: { open: boolean; plan?: PlanDto }; areas: AreaDto[]; preferredAreaId?: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [status, setStatus] = useState<PlanStatus>('planning'); const [areaId, setAreaId] = useState('');
  useEffect(() => { if (state.open) { setName(state.plan?.name ?? ''); setDescription(state.plan?.description ?? ''); setStatus(state.plan?.status ?? 'planning'); setAreaId(state.plan?.areaId ?? preferredAreaId ?? areas[0]?.id ?? ''); } }, [areas, preferredAreaId, state.open, state.plan]);
  function openChanged(open: boolean) { if (!open) onClose(); }
  async function submit(event: FormEvent) { event.preventDefault(); try { await api(state.plan ? `/api/plans/${state.plan.id}` : '/api/plans', { method: state.plan ? 'PATCH' : 'POST', body: JSON.stringify(state.plan ? { name, description, status, expectedVersion: state.plan.version } : { areaId, name, description, status }) }); await onSaved(); onClose(); toast.success(state.plan ? '计划已更新' : '计划已创建'); } catch (error) { showError(error); } }
  return <Modal open={state.open} onOpenChange={openChanged} title={state.plan ? '编辑计划' : '新建计划'}><form className="stack-form" onSubmit={submit}>{!state.plan && <label>所属领域<select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label>}<label>计划名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required /></label><label>状态<select value={status} onChange={(e) => setStatus(e.target.value as PlanStatus)}>{Object.entries(planStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>说明<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存</button></div></form></Modal>;
}

function MovePlanModal({ plan, areas, onClose, onSaved }: { plan: PlanDto | null; areas: AreaDto[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [areaId, setAreaId] = useState('');
  useEffect(() => { if (plan) setAreaId(areas.find((area) => area.id !== plan.areaId)?.id ?? plan.areaId); }, [areas, plan]);
  return <Modal open={Boolean(plan)} onOpenChange={(open) => { if (!open) onClose(); }} title="移动计划"><form className="stack-form" onSubmit={async (e) => { e.preventDefault(); if (!plan) return; try { await api(`/api/plans/${plan.id}/move`, { method: 'POST', body: JSON.stringify({ areaId, expectedVersion: plan.version }) }); await onSaved(); onClose(); toast.success('计划已移动'); } catch (error) { showError(error); } }}><label>目标领域<select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!areaId || areaId === plan?.areaId}>移动</button></div></form></Modal>;
}

interface ImportItem { fileName: string; content: unknown; areaName: string; planName: string; targetAreaId: string; createAreaName: string; }
function ImportPlansModal({ open, areas, existingPlans, onClose, onImported }: { open: boolean; areas: AreaDto[]; existingPlans: PlanDto[]; onClose: () => void; onImported: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null); const [items, setItems] = useState<ImportItem[]>([]); const [busy, setBusy] = useState(false); const [defaultArea, setDefaultArea] = useState('');
  async function choose(files: FileList | null) { if (!files) return; const parsed: ImportItem[] = [];
    for (const file of Array.from(files)) { try { const content = JSON.parse(await file.text()) as { areaName?: string; plan?: { name?: string } }; const match = areas.find((area) => area.name.toLocaleLowerCase() === (content.areaName ?? '').toLocaleLowerCase()); parsed.push({ fileName: file.name, content, areaName: content.areaName ?? '', planName: content.plan?.name ?? file.name, targetAreaId: match?.id ?? '', createAreaName: match ? '' : (content.areaName ?? '') }); } catch { toast.error(`${file.name} 不是有效 JSON`); } }
    setItems(parsed);
  }
  function applyDefault() { if (!defaultArea) return; setItems((current) => current.map((item) => ({ ...item, targetAreaId: defaultArea, createAreaName: '' }))); }
  async function submit() { if (items.some((item) => !item.targetAreaId && !item.createAreaName)) return toast.error('请为每个文件选择或创建目标领域');
    const duplicates = items.filter((item) => existingPlans.some((plan) => plan.areaId === item.targetAreaId && plan.name === item.planName));
    if (duplicates.length > 0 && !window.confirm(`有 ${duplicates.length} 个同名计划，将作为独立副本导入。是否继续？`)) return;
    setBusy(true); try { const { results } = await api<{ results: ImportResult[] }>('/api/plan-imports', { method: 'POST', body: JSON.stringify({ files: items }) });
      const failed = results.filter((result) => !result.success); toast[failed.length ? 'warning' : 'success'](`导入完成：${results.length - failed.length} 成功，${failed.length} 失败`);
      if (failed.length) failed.forEach((result) => toast.error(`${result.fileName}：${result.message}`)); await onImported(); if (!failed.length) onClose();
    } catch (error) { showError(error); } finally { setBusy(false); }
  }
  return <Modal open={open} onOpenChange={(value) => { if (!value) { setItems([]); setDefaultArea(''); onClose(); } }} title="导入计划" description="支持一次选择多个 .plan.json 文件，每个文件独立处理。" wide>
    <div className="import-toolbar"><input ref={input} type="file" accept=".json,.plan.json" multiple hidden onChange={(e) => choose(e.target.files)} /><button className="secondary-button" onClick={() => input.current?.click()}><FileUp size={17} />选择文件</button>{items.length > 1 && <><select value={defaultArea} onChange={(e) => setDefaultArea(e.target.value)}><option value="">本批默认领域</option>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select><button className="secondary-button" onClick={applyDefault}>应用到全部</button></>}</div>
    <div className="import-list">{items.length === 0 ? <div className="empty-inline">尚未选择文件</div> : items.map((item, index) => <div className="import-row" key={`${item.fileName}-${index}`}><div><strong>{item.planName}</strong><small>{item.fileName}{item.areaName ? ` · 文件领域：${item.areaName}` : ''}</small></div><select value={item.targetAreaId} onChange={(e) => setItems((current) => current.map((entry, i) => i === index ? { ...entry, targetAreaId: e.target.value, createAreaName: '' } : entry))}><option value="">创建文件中的领域</option>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select>{!item.targetAreaId && <input aria-label="新领域名称" placeholder="新领域名称" value={item.createAreaName} onChange={(e) => setItems((current) => current.map((entry, i) => i === index ? { ...entry, createAreaName: e.target.value } : entry))} />}</div>)}</div>
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || items.length === 0} onClick={submit}>{busy ? '正在导入' : `导入 ${items.length || ''} 个计划`}</button></div>
  </Modal>;
}

interface AreaImportItem { fileName: string; content: unknown; areaName: string; planCount: number; matchingArea?: AreaDto; }
type AreaImportMode = '' | 'merge' | 'create';

function ImportAreaModal({ open, areas, onClose, onImported }: { open: boolean; areas: AreaDto[]; onClose: () => void; onImported: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null); const [item, setItem] = useState<AreaImportItem | null>(null);
  const [mode, setMode] = useState<AreaImportMode>(''); const [createAreaName, setCreateAreaName] = useState(''); const [busy, setBusy] = useState(false);
  function reset() { setItem(null); setMode(''); setCreateAreaName(''); if (input.current) input.current.value = ''; }
  async function choose(files: FileList | null) {
    const file = files?.[0]; if (!file) return;
    try {
      const content = JSON.parse(await file.text()) as { format?: string; area?: { name?: string }; plans?: unknown[] };
      if (content.format !== 'sixplan-area' || !content.area?.name || !Array.isArray(content.plans)) throw new Error('文件格式不正确');
      const matchingArea = areas.find((area) => area.name.toLocaleLowerCase() === content.area!.name!.toLocaleLowerCase());
      setItem({ fileName: file.name, content, areaName: content.area.name, planCount: content.plans.length, ...(matchingArea ? { matchingArea } : {}) });
      setMode(matchingArea ? '' : 'create');
      setCreateAreaName(matchingArea ? `${content.area.name}（导入）` : content.area.name);
    } catch { reset(); toast.error(`${file.name} 不是有效的领域文件`); }
  }
  async function submit() {
    if (!item || !mode) return;
    if (mode === 'create' && !createAreaName.trim()) return toast.error('请输入新领域名称');
    setBusy(true);
    try {
      const body = mode === 'merge'
        ? { mode, content: item.content, targetAreaId: item.matchingArea?.id }
        : { mode, content: item.content, createAreaName };
      const result = await api<{ areaName: string; importedPlanCount: number }>('/api/area-imports', { method: 'POST', body: JSON.stringify(body) });
      toast.success(`领域“${result.areaName}”已导入，共 ${result.importedPlanCount} 个计划`);
      await onImported(); reset(); onClose();
    } catch (error) { showError(error); } finally { setBusy(false); }
  }
  return <Modal open={open} onOpenChange={(value) => { if (!value) { reset(); onClose(); } }} title="导入领域" description="领域文件会作为一个整体校验和导入，失败时不会写入部分数据。">
    <div className="import-toolbar"><input ref={input} type="file" accept=".json,.area.json" hidden onChange={(e) => choose(e.target.files)} /><button className="secondary-button" onClick={() => input.current?.click()}><FolderInput size={17} />选择领域文件</button></div>
    {!item ? <div className="empty-inline area-import-empty">尚未选择文件</div> : <div className="stack-form">
      <div className="area-import-summary"><Folder size={19} /><div><strong>{item.areaName}</strong><small>{item.fileName} · {item.planCount} 个计划</small></div></div>
      <label>导入方式<select value={mode} onChange={(e) => setMode(e.target.value as AreaImportMode)}>
        {item.matchingArea && <option value="">请选择导入方式</option>}
        {item.matchingArea && <option value="merge">合并到已有领域“{item.matchingArea.name}”</option>}
        <option value="create">创建新领域</option>
      </select></label>
      {mode === 'create' && <label>新领域名称<input value={createAreaName} maxLength={100} onChange={(e) => setCreateAreaName(e.target.value)} /></label>}
      {item.matchingArea && mode === '' && <div className="notice warning">检测到同名领域。请选择合并，或创建一个名称不同的新领域。</div>}
      {mode === 'merge' && <div className="notice warning">文件中的计划将作为独立副本加入已有领域，不会覆盖同名计划。</div>}
    </div>}
    <div className="dialog-actions"><button className="secondary-button" onClick={() => { reset(); onClose(); }}>取消</button><button className="primary-button" disabled={busy || !item || !mode || (mode === 'create' && !createAreaName.trim())} onClick={submit}>{busy ? '正在导入' : '导入领域'}</button></div>
  </Modal>;
}
