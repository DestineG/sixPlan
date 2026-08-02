import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Archive, ArrowDown, ArrowUp, Bot, CheckSquare, ChevronDown, ChevronUp, Download, FileInput, FileUp, FilterX, Folder, FolderInput, FolderPlus, ListChecks, ListPlus, MoreHorizontal, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { PLAN_STATUSES, nodeStatusLabels, planStatusLabels, type ActivePlanDto, type AreaDto, type ImportPreviewDto, type PlanDto, type PlanStatus } from '@sixplan/shared';
import { api, ApiClientError, downloadFile } from '../api';
import { ConfirmDialog, Modal } from '../components/Dialogs';
import { AiPlanModal } from '../components/AiPlanModal';

type Selection = 'active' | 'all' | 'archived' | string;
type ArchiveFilter = 'all' | 'unarchived' | 'archived';
type PlanSort = 'updated' | 'created' | 'name';
type PlanWithActivity = PlanDto & Partial<Pick<ActivePlanDto, 'activeNodes'>>;

export function OverviewPage() {
  const queryClient = useQueryClient(); const navigate = useNavigate(); const [searchParams, setSearchParams] = useSearchParams();
  const selection: Selection = (() => {
    const view = searchParams.get('view');
    if (view === 'active' || view === 'all' || view === 'archived') return view;
    return searchParams.get('area') ?? 'active';
  })();
  const [areaModal, setAreaModal] = useState<{ open: boolean; area?: AreaDto }>({ open: false });
  const [planModal, setPlanModal] = useState<{ open: boolean; plan?: PlanDto }>({ open: false });
  const [movePlan, setMovePlan] = useState<PlanDto | null>(null); const [confirm, setConfirm] = useState<{ plan: PlanDto; kind: 'archive' | 'delete' } | null>(null);
  const [importMode, setImportMode] = useState<'plan' | 'area' | 'ai-new' | 'ai-extend' | null>(null);
  const queryText = selection === 'all' ? searchParams.get('q') ?? '' : '';
  const filterArea = selection === 'all' ? searchParams.get('filterArea') ?? '' : '';
  const filterStatus = selection === 'all' && PLAN_STATUSES.includes(searchParams.get('status') as PlanStatus) ? searchParams.get('status') as PlanStatus : '';
  const archiveFilter = selection === 'all' && ['unarchived', 'archived'].includes(searchParams.get('archive') ?? '') ? searchParams.get('archive') as ArchiveFilter : 'all';
  const planSort = selection === 'all' && ['created', 'name'].includes(searchParams.get('sort') ?? '') ? searchParams.get('sort') as PlanSort : 'updated';
  const [searchText, setSearchText] = useState(queryText);
  const [batchMode, setBatchMode] = useState(false); const [selectedArchivedIds, setSelectedArchivedIds] = useState<Set<string>>(new Set());
  const [batchConfirm, setBatchConfirm] = useState(false); const [batchBusy, setBatchBusy] = useState(false);
  const areasQuery = useQuery({ queryKey: ['areas'], queryFn: () => api<{ areas: AreaDto[] }>('/api/areas') });
  const plansQuery = useQuery({ queryKey: ['plans', selection, queryText, filterArea, filterStatus, archiveFilter, planSort], queryFn: () => {
    if (selection === 'archived') return api<{ plans: PlanDto[] }>('/api/plans/archived');
    if (selection === 'all') {
      const query = new URLSearchParams({ archive: archiveFilter, sort: planSort });
      if (queryText) query.set('q', queryText); if (filterArea) query.set('areaId', filterArea); if (filterStatus) query.set('status', filterStatus);
      return api<{ plans: PlanDto[] }>(`/api/plans?${query}`);
    }
    return selection === 'active' ? api<{ plans: PlanWithActivity[] }>('/api/plans/active') : api<{ plans: PlanWithActivity[] }>(`/api/plans?areaId=${selection}`);
  } });
  const areas = useMemo(() => areasQuery.data?.areas ?? [], [areasQuery.data]);
  const plans = useMemo(() => plansQuery.data?.plans ?? [], [plansQuery.data]);

  useEffect(() => { setSearchText(queryText); }, [queryText]);
  useEffect(() => {
    if (selection !== 'all' || searchText === queryText) return;
    const timer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams); next.set('view', 'all'); next.delete('area');
      if (searchText.trim()) next.set('q', searchText.trim()); else next.delete('q');
      setSearchParams(next, { replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [queryText, searchParams, searchText, selection, setSearchParams]);
  useEffect(() => { if (selection !== 'archived') { setBatchMode(false); setSelectedArchivedIds(new Set()); } }, [selection]);

  function setAllFilter(key: 'filterArea' | 'status' | 'archive' | 'sort', value: string, defaultValue: string) {
    const next = new URLSearchParams(searchParams); next.set('view', 'all'); next.delete('area');
    if (value === defaultValue) next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  function clearAllFilters() { setSearchText(''); setSearchParams({ view: 'all' }, { replace: true }); }

  function select(value: Selection) {
    setSearchParams(value === 'active' || value === 'all' || value === 'archived' ? { view: value } : { area: value });
  }

  async function refresh() { await Promise.all([queryClient.invalidateQueries({ queryKey: ['areas'] }), queryClient.invalidateQueries({ queryKey: ['plans'] })]); }
  async function mutatePlan(path: string, body: unknown, success: string, method = 'POST') {
    try { const result = await api<{ autoActivated?: boolean }>(path, { method, body: JSON.stringify(body) }); toast.success(success);
      if (result?.autoActivated) toast.success('计划已根据节点状态自动设为进行中'); await refresh(); }
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
      if (selection === area.id) select('all'); await refresh(); toast.success('领域已删除');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '删除失败'); }
  }
  const grouped = useMemo(() => areas.map((area) => ({ area, plans: plans.filter((plan) => plan.areaId === area.id) })).filter((group) => group.plans.length > 0), [areas, plans]);
  const activeGrouped = useMemo(() => grouped.map((group) => ({ ...group, plans: [...group.plans].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)) })), [grouped]);
  const selectedArchivedPlans = plans.filter((plan) => selectedArchivedIds.has(plan.id));

  function toggleArchived(id: string) {
    setSelectedArchivedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function selectArchived(ids: string[], selected: boolean) {
    setSelectedArchivedIds((current) => { const next = new Set(current); ids.forEach((id) => selected ? next.add(id) : next.delete(id)); return next; });
  }
  async function batchDeleteArchived() {
    if (selectedArchivedPlans.length === 0) return;
    setBatchBusy(true);
    try {
      const result = await api<{ deletedCount: number }>('/api/plans/archived/batch', { method: 'DELETE',
        body: JSON.stringify({ items: selectedArchivedPlans.map((plan) => ({ id: plan.id, expectedVersion: plan.version })) }) });
      toast.success(`已永久删除 ${result.deletedCount} 个计划`); setSelectedArchivedIds(new Set()); setBatchMode(false); setBatchConfirm(false); await refresh();
    } catch (error) { showError(error); } finally { setBatchBusy(false); }
  }
  function renderPlanCard(plan: PlanDto, archivedView = false) {
    const archived = Boolean(plan.archivedAt); const selecting = archivedView && batchMode;
    return <PlanCard key={plan.id} plan={plan} showActivity={selection === 'active'} selectionMode={selecting} selected={selectedArchivedIds.has(plan.id)}
      onToggle={() => toggleArchived(plan.id)} onOpen={() => selecting ? toggleArchived(plan.id) : navigate(`/plans/${plan.id}`)}
      onOpenNode={(nodeId) => navigate(`/plans/${plan.id}?node=${encodeURIComponent(nodeId)}`)}
      onEdit={!archived ? () => setPlanModal({ open: true, plan }) : undefined} onMove={!archived ? () => setMovePlan(plan) : undefined}
      onExport={() => downloadFile(`/api/plans/${plan.id}/export`).catch(showError)}
      onArchive={!archived ? () => setConfirm({ plan, kind: 'archive' }) : undefined}
      onRestore={archived ? () => mutatePlan(`/api/plans/${plan.id}/restore`, { expectedVersion: plan.version }, '计划已恢复') : undefined}
      onDelete={archivedView && !batchMode ? () => setConfirm({ plan, kind: 'delete' }) : undefined} />;
  }
  return <div className="overview-layout">
    <aside className="area-sidebar">
      <div className="sidebar-heading"><span>领域</span><button className="icon-button" title="新建领域" onClick={() => setAreaModal({ open: true })}><FolderPlus size={17} /></button></div>
      <button className={`area-nav ${selection === 'active' ? 'active' : ''}`} onClick={() => select('active')}><Activity size={17} /><span>活跃计划</span><small>{areas.reduce((sum, area) => sum + area.activePlanCount, 0)}</small></button>
      <button className={`area-nav ${selection === 'all' ? 'active' : ''}`} onClick={() => select('all')}><Folder size={17} /><span>全部计划</span></button>
      <div className="area-list">{areas.map((area, index) => <div className={`area-row ${selection === area.id ? 'active' : ''}`} key={area.id}>
        <button className="area-main" onClick={() => select(area.id)}><span>{area.name}</span><small>{area.planCount}</small></button>
        <div className="area-actions">
          <button className="mini-icon" title="上移" disabled={index === 0} onClick={() => reorder(area, -1)}><ArrowUp size={13} /></button>
          <button className="mini-icon" title="下移" disabled={index === areas.length - 1} onClick={() => reorder(area, 1)}><ArrowDown size={13} /></button>
          <DropdownMenu.Root><DropdownMenu.Trigger className="mini-icon" aria-label={`${area.name}领域操作`}><MoreHorizontal size={13} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="start">
            <DropdownMenu.Item onSelect={() => setAreaModal({ open: true, area })}><Pencil size={15} />重命名</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={() => downloadFile(`/api/areas/${area.id}/export`).catch(showError)}><Download size={15} />导出领域</DropdownMenu.Item>
            <DropdownMenu.Item className="menu-danger" onSelect={() => deleteArea(area)}><Trash2 size={15} />删除</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </div></div>)}</div>
      <button className={`area-nav archive-nav ${selection === 'archived' ? 'active' : ''}`} onClick={() => select('archived')}><Archive size={17} /><span>已归档</span><small>{areas.reduce((sum, area) => sum + area.archivedPlanCount, 0)}</small></button>
    </aside>
    <section className="overview-content">
      <div className="page-heading"><div><p className="eyebrow">计划空间</p><h1>{selection === 'active' ? '活跃计划' : selection === 'all' ? '全部计划' : selection === 'archived' ? '已归档' : areas.find((area) => area.id === selection)?.name ?? '计划'}</h1>
        <p>{selection === 'active' ? `跨领域汇总 ${plans.length} 个进行中的计划` : selection === 'archived' ? '归档计划保持只读，可随时恢复或导出。' : selection === 'all' ? `找到 ${plans.length} 个计划` : `${plans.length} 个计划`}</p></div>
        <div className="heading-actions"><DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="secondary-button"><FileUp size={17} />导入</button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
          <DropdownMenu.Item onSelect={() => setImportMode('plan')}><FileInput size={15} />导入计划</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setImportMode('area')}><FolderInput size={15} />导入领域</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setImportMode('ai-new')}><Bot size={15} />AI 生成新计划</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => setImportMode('ai-extend')}><ListPlus size={15} />AI 扩展现有计划</DropdownMenu.Item>
        </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          {selection !== 'archived' && <button className="primary-button" disabled={areas.length === 0} onClick={() => setPlanModal({ open: true })}><Plus size={17} />新建计划</button>}</div></div>
      {selection === 'all' && <div className="plan-filter-toolbar">
        <label className="plan-search"><span>搜索</span><div><Search size={16} /><input aria-label="搜索计划" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="名称或说明" /></div></label>
        <label><span>领域</span><select aria-label="领域筛选" value={filterArea} onChange={(event) => setAllFilter('filterArea', event.target.value, '')}><option value="">全部领域</option>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
        <label><span>状态</span><select aria-label="计划状态筛选" value={filterStatus} onChange={(event) => setAllFilter('status', event.target.value, '')}><option value="">全部状态</option>{Object.entries(planStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>归档</span><select aria-label="归档状态筛选" value={archiveFilter} onChange={(event) => setAllFilter('archive', event.target.value, 'all')}><option value="all">全部</option><option value="unarchived">未归档</option><option value="archived">已归档</option></select></label>
        <label><span>排序</span><select aria-label="计划排序" value={planSort} onChange={(event) => setAllFilter('sort', event.target.value, 'updated')}><option value="updated">最近更新</option><option value="created">创建时间</option><option value="name">计划名称</option></select></label>
        <button className="icon-button filter-clear" title="清除筛选" aria-label="清除筛选" disabled={!queryText && !filterArea && !filterStatus && archiveFilter === 'all' && planSort === 'updated'} onClick={clearAllFilters}><FilterX size={17} /></button>
      </div>}
      {selection === 'archived' && plans.length > 0 && <div className="archive-batch-toolbar">{!batchMode
        ? <button className="secondary-button" onClick={() => setBatchMode(true)}><ListChecks size={17} />批量管理</button>
        : <><div><button className="secondary-button compact" onClick={() => selectArchived(plans.map((plan) => plan.id), true)}><CheckSquare size={15} />选择全部</button><button className="secondary-button compact" disabled={selectedArchivedIds.size === 0} onClick={() => setSelectedArchivedIds(new Set())}>清空选择</button><span>已选择 {selectedArchivedIds.size} 个计划</span></div><div><button className="secondary-button compact" onClick={() => { setBatchMode(false); setSelectedArchivedIds(new Set()); }}>退出批量</button><button className="danger-button compact" disabled={selectedArchivedIds.size === 0} onClick={() => setBatchConfirm(true)}><Trash2 size={15} />永久删除</button></div></>}
      </div>}
      {areas.length === 0 ? <EmptyState icon={<FolderPlus size={28} />} title="先创建一个领域" body="领域用于组织工作、学习和生活中的不同计划。" action={() => setAreaModal({ open: true })} actionLabel="新建领域" />
      : plansQuery.isLoading ? <div className="page-loader"><span className="spinner" />加载计划</div>
      : plans.length === 0 ? <EmptyState icon={selection === 'active' ? <Activity size={28} /> : selection === 'archived' ? <Archive size={28} /> : <Plus size={28} />} title={selection === 'active' ? '当前没有活跃计划' : selection === 'archived' ? '还没有归档计划' : selection === 'all' && (queryText || filterArea || filterStatus || archiveFilter !== 'all' || planSort !== 'updated') ? '没有匹配的计划' : '这个视图还没有计划'} body={selection === 'active' ? '将计划状态设为“进行中”后会显示在这里。' : selection === 'archived' ? '归档后的计划会集中显示在这里。' : selection === 'all' && (queryText || filterArea || filterStatus || archiveFilter !== 'all' || planSort !== 'updated') ? '调整搜索词或筛选条件后重试。' : '创建计划后即可开始搭建 DAG。'} action={selection === 'active' || selection === 'archived' ? undefined : () => setPlanModal({ open: true })} actionLabel="新建计划" />
      : selection === 'active' ? <div className="active-area-groups">{activeGrouped.map(({ area, plans: areaPlans }) => <section className="active-area-group" aria-labelledby={`active-area-${area.id}`} key={area.id}>
        <div className="active-area-heading"><Folder size={16} /><h2 id={`active-area-${area.id}`}>{area.name}</h2><span>{areaPlans.length} 个计划</span></div>
        <div className="active-area-grid">{areaPlans.map((plan) => renderPlanCard(plan))}</div>
      </section>)}</div>
      : selection === 'archived' ? <div className="archive-groups">{grouped.map(({ area, plans: areaPlans }) => { const ids = areaPlans.map((plan) => plan.id); const selectedCount = ids.filter((id) => selectedArchivedIds.has(id)).length; return <section className="archive-group" key={area.id}><h2>{batchMode && <GroupSelectionCheckbox label={`选择${area.name}领域`} checked={selectedCount === ids.length} indeterminate={selectedCount > 0 && selectedCount < ids.length} onChange={(checked) => selectArchived(ids, checked)} />}<span className="archive-group-name">{area.name}</span><span>{areaPlans.length}</span>{batchMode && <button className="secondary-button compact" onClick={() => selectArchived(ids, selectedCount !== ids.length)}>{selectedCount === ids.length ? '取消本领域' : '选择本领域'}</button>}</h2><div className="plan-grid">{areaPlans.map((plan) => renderPlanCard(plan, true))}</div></section>; })}</div>
      : <div className="plan-grid">{plans.map((plan) => renderPlanCard(plan))}</div>}
    </section>
    <AreaEditor state={areaModal} onClose={() => setAreaModal({ open: false })} onSaved={refresh} />
    <PlanEditor state={planModal} areas={areas} preferredAreaId={selection !== 'active' && selection !== 'all' && selection !== 'archived' ? selection : undefined} preferredStatus={selection === 'active' ? 'active' : undefined} onClose={() => setPlanModal({ open: false })} onSaved={refresh} />
    <MovePlanModal plan={movePlan} areas={areas} onClose={() => setMovePlan(null)} onSaved={refresh} />
    <ImportPlansModal open={importMode === 'plan'} areas={areas} existingPlans={plans} onClose={() => setImportMode(null)} onImported={refresh} />
    <ImportAreaModal open={importMode === 'area'} areas={areas} onClose={() => setImportMode(null)} onImported={refresh} />
    <AiPlanModal mode={importMode === 'ai-new' ? 'snapshot' : importMode === 'ai-extend' ? 'changeset' : null} areas={areas}
      onClose={() => setImportMode(null)} onApplied={async (plan) => { await refresh(); if (importMode === 'ai-extend') navigate(`/plans/${plan.id}`); }} />
    <ConfirmDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)} title={confirm?.kind === 'archive' ? '归档计划' : '永久删除计划'}
      description={confirm?.kind === 'archive' ? `“${confirm?.plan.name}”归档后将变为只读并移入已归档视图。` : `“${confirm?.plan.name}”及其全部节点和连接将永久删除，此操作无法撤销。`}
      confirmLabel={confirm?.kind === 'archive' ? '确认归档' : '永久删除'} danger={confirm?.kind === 'delete'} onConfirm={async () => { if (!confirm) return;
        await mutatePlan(`/api/plans/${confirm.plan.id}${confirm.kind === 'archive' ? '/archive' : ''}`, { expectedVersion: confirm.plan.version }, confirm.kind === 'archive' ? '计划已归档' : '计划已永久删除', confirm.kind === 'delete' ? 'DELETE' : 'POST'); setConfirm(null); }} />
    <ConfirmDialog open={batchConfirm} onOpenChange={(open) => !batchBusy && setBatchConfirm(open)} title="批量永久删除计划"
      description={`将永久删除 ${selectedArchivedPlans.length} 个计划及其全部节点和连接：${selectedArchivedPlans.slice(0, 4).map((plan) => `“${plan.name}”`).join('、')}${selectedArchivedPlans.length > 4 ? `等 ${selectedArchivedPlans.length} 个计划` : ''}。此操作无法撤销。`}
      confirmLabel={`永久删除 ${selectedArchivedPlans.length} 个计划`} danger onConfirm={batchDeleteArchived} />
  </div>;
}

function showError(error: unknown) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }

function EmptyState({ icon, title, body, action, actionLabel }: { icon: React.ReactNode; title: string; body: string; action?: () => void; actionLabel: string }) {
  return <div className="empty-state"><span>{icon}</span><h2>{title}</h2><p>{body}</p>{action && <button className="primary-button" onClick={action}><Plus size={17} />{actionLabel}</button>}</div>;
}

function GroupSelectionCheckbox({ label, checked, indeterminate, onChange }: { label: string; checked: boolean; indeterminate: boolean; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={input} className="group-selection-check" type="checkbox" aria-label={label} checked={checked} onChange={(event) => onChange(event.target.checked)} />;
}

function PlanCard({ plan, showActivity = false, selectionMode = false, selected = false, onToggle, onOpen, onOpenNode, onEdit, onMove, onExport, onArchive, onRestore, onDelete }: {
  plan: PlanWithActivity; showActivity?: boolean; selectionMode?: boolean; selected?: boolean; onToggle?: () => void; onOpen: () => void; onOpenNode: (nodeId: string) => void; onEdit?: () => void;
  onMove?: () => void; onExport: () => void; onArchive?: () => void; onRestore?: () => void; onDelete?: () => void;
}) {
  const [expanded, setExpanded] = useState(false); const activeNodes = plan.activeNodes ?? [];
  const visibleNodes = expanded ? activeNodes : activeNodes.slice(0, 3);
  return <article className={`plan-card ${plan.archivedAt ? 'archived' : ''} ${selected ? 'batch-selected' : ''}`} onDoubleClick={selectionMode ? undefined : onOpen}>
    <div className="plan-card-top"><div className="plan-card-badges"><span className={`status-pill status-${plan.status}`}>{planStatusLabels[plan.status]}</span>{plan.archivedAt && <span className="archived-card-badge">已归档</span>}</div>
    {selectionMode ? <input className="batch-card-check" type="checkbox" aria-label={`选择计划 ${plan.name}`} checked={selected} onChange={onToggle} /> : <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label="计划操作"><MoreHorizontal size={18} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="menu-content" align="end">
      {onEdit && <DropdownMenu.Item onSelect={onEdit}><Pencil size={15} />编辑信息</DropdownMenu.Item>}{onMove && <DropdownMenu.Item onSelect={onMove}><Folder size={15} />移动领域</DropdownMenu.Item>}
      <DropdownMenu.Item onSelect={onExport}><Download size={15} />导出计划</DropdownMenu.Item>{onArchive && <DropdownMenu.Item onSelect={onArchive}><Archive size={15} />归档</DropdownMenu.Item>}
      {onRestore && <DropdownMenu.Item onSelect={onRestore}><RotateCcw size={15} />恢复</DropdownMenu.Item>}{onDelete && <DropdownMenu.Item className="menu-danger" onSelect={onDelete}><Trash2 size={15} />永久删除</DropdownMenu.Item>}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}</div>
    <button className="plan-card-body" onClick={onOpen}><h2>{plan.name}</h2><p>{plan.description || '暂无说明'}</p></button>
    {showActivity && <div className="plan-activity"><div className="plan-activity-heading"><strong>当前活跃节点</strong><span>{activeNodes.length}</span></div>
      {activeNodes.length === 0 ? <p className="plan-activity-empty">暂无进行中的节点</p> : <div className="active-node-list">{visibleNodes.map((node) => <button key={node.id} className="active-node-row" onClick={() => onOpenNode(node.id)}>
        <div><strong>{node.title}</strong>{node.stepCount > 0 && <span>{node.completedStepCount}/{node.stepCount}</span>}</div>
        {node.activeSteps.length > 0 ? node.activeSteps.slice(0, 2).map((step) => <small key={step.id}><span className={`node-status node-status-${step.status}`}>{nodeStatusLabels[step.status]}</span>{step.title}{step.startDate || step.endDate ? ` · ${step.startDate ?? '未定'} 至 ${step.endDate ?? '未定'}` : ''}</small>) : <small>{node.summary || '节点正在进行中'}</small>}
      </button>)}</div>}
      {activeNodes.length > 3 && <button className="activity-expand" onClick={() => setExpanded((value) => !value)}>{expanded ? <><ChevronUp size={14} />收起</> : <><ChevronDown size={14} />还有 {activeNodes.length - 3} 个</>}</button>}
    </div>}
    <div className="plan-card-meta"><span>{plan.areaName}</span><span>{plan.nodeCount} 个节点</span><time>{new Date(plan.archivedAt ?? plan.updatedAt).toLocaleDateString('zh-CN')}</time></div></article>;
}

function AreaEditor({ state, onClose, onSaved }: { state: { open: boolean; area?: AreaDto }; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('');
  useEffect(() => { if (state.open) setName(state.area?.name ?? ''); }, [state.area, state.open]);
  function openChanged(open: boolean) { if (!open) onClose(); }
  async function submit(event: FormEvent) { event.preventDefault(); try { await api(state.area ? `/api/areas/${state.area.id}` : '/api/areas', { method: state.area ? 'PATCH' : 'POST', body: JSON.stringify(state.area ? { name, expectedVersion: state.area.version } : { name }) }); await onSaved(); onClose(); toast.success(state.area ? '领域已更新' : '领域已创建'); } catch (error) { showError(error); } }
  return <Modal open={state.open} onOpenChange={openChanged} title={state.area ? '重命名领域' : '新建领域'}><form className="stack-form" onSubmit={submit}><label>领域名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存</button></div></form></Modal>;
}

function PlanEditor({ state, areas, preferredAreaId, preferredStatus, onClose, onSaved }: { state: { open: boolean; plan?: PlanDto }; areas: AreaDto[]; preferredAreaId?: string; preferredStatus?: PlanStatus; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [status, setStatus] = useState<PlanStatus>('planning'); const [areaId, setAreaId] = useState('');
  useEffect(() => { if (state.open) { setName(state.plan?.name ?? ''); setDescription(state.plan?.description ?? ''); setStatus(state.plan?.status ?? preferredStatus ?? 'planning'); setAreaId(state.plan?.areaId ?? preferredAreaId ?? areas[0]?.id ?? ''); } }, [areas, preferredAreaId, preferredStatus, state.open, state.plan]);
  function openChanged(open: boolean) { if (!open) onClose(); }
  async function submit(event: FormEvent) { event.preventDefault(); try { await api(state.plan ? `/api/plans/${state.plan.id}` : '/api/plans', { method: state.plan ? 'PATCH' : 'POST', body: JSON.stringify(state.plan ? { name, description, status, expectedVersion: state.plan.version } : { areaId, name, description, status }) }); await onSaved(); onClose(); toast.success(state.plan ? '计划已更新' : '计划已创建'); } catch (error) { showError(error); } }
  return <Modal open={state.open} onOpenChange={openChanged} title={state.plan ? '编辑计划' : '新建计划'}><form className="stack-form" onSubmit={submit}>{!state.plan && <label>所属领域<select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label>}<label>计划名称<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required /></label><label>状态<select value={status} onChange={(e) => setStatus(e.target.value as PlanStatus)}>{Object.entries(planStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>说明<textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} /></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button">保存</button></div></form></Modal>;
}

function MovePlanModal({ plan, areas, onClose, onSaved }: { plan: PlanDto | null; areas: AreaDto[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [areaId, setAreaId] = useState('');
  useEffect(() => { if (plan) setAreaId(areas.find((area) => area.id !== plan.areaId)?.id ?? plan.areaId); }, [areas, plan]);
  return <Modal open={Boolean(plan)} onOpenChange={(open) => { if (!open) onClose(); }} title="移动计划"><form className="stack-form" onSubmit={async (e) => { e.preventDefault(); if (!plan) return; try { await api(`/api/plans/${plan.id}/move`, { method: 'POST', body: JSON.stringify({ areaId, expectedVersion: plan.version }) }); await onSaved(); onClose(); toast.success('计划已移动'); } catch (error) { showError(error); } }}><label>目标领域<select value={areaId} onChange={(e) => setAreaId(e.target.value)}>{areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!areaId || areaId === plan?.areaId}>移动</button></div></form></Modal>;
}

interface ImportItem { fileName: string; sessionId: string; areaName: string; planName: string; targetAreaId: string; createAreaName: string; error?: string; }
function ImportPlansModal({ open, areas, existingPlans, onClose, onImported }: { open: boolean; areas: AreaDto[]; existingPlans: PlanDto[]; onClose: () => void; onImported: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null); const [items, setItems] = useState<ImportItem[]>([]); const [busy, setBusy] = useState(false); const [defaultArea, setDefaultArea] = useState('');
  async function discard(entries = items) { await Promise.all(entries.filter((item) => item.sessionId).map((item) => api(`/api/import-sessions/${item.sessionId}`, { method: 'DELETE' }).catch(() => undefined))); }
  async function close() { await discard(); setItems([]); setDefaultArea(''); onClose(); }
  async function choose(files: FileList | null) { if (!files) return; setBusy(true); await discard(); const parsed: ImportItem[] = [];
    for (const file of Array.from(files)) {
      try {
        const form = new FormData(); form.append('file', file);
        const { preview } = await api<{ preview: ImportPreviewDto }>('/api/import-sessions/upload', { method: 'POST', body: form });
        const areaName = preview.suggestedAreaName ?? ''; const match = areas.find((area) => area.name.toLocaleLowerCase() === areaName.toLocaleLowerCase());
        parsed.push({ fileName: file.name, sessionId: preview.sessionId, areaName, planName: preview.planName, targetAreaId: match?.id ?? '', createAreaName: match ? '' : areaName });
      } catch (error) {
        const message = error instanceof ApiClientError ? error.message : '文件校验失败'; parsed.push({ fileName: file.name, sessionId: '', areaName: '', planName: file.name, targetAreaId: '', createAreaName: '', error: message });
      }
    }
    setItems(parsed); setBusy(false); if (input.current) input.current.value = '';
  }
  function applyDefault() { if (!defaultArea) return; setItems((current) => current.map((item) => item.error ? item : ({ ...item, targetAreaId: defaultArea, createAreaName: '' }))); }
  async function submit() { const ready = items.filter((item) => !item.error); if (ready.some((item) => !item.targetAreaId && !item.createAreaName)) return toast.error('请为每个有效文件选择或创建目标领域');
    const duplicates = ready.filter((item) => existingPlans.some((plan) => plan.areaId === item.targetAreaId && plan.name === item.planName));
    if (duplicates.length > 0 && !window.confirm(`有 ${duplicates.length} 个同名计划，将作为独立副本导入。是否继续？`)) return;
    setBusy(true); let success = 0; let autoActivated = 0; const next = [...items];
    for (let index = 0; index < next.length; index += 1) {
      const item = next[index]!; if (item.error) continue;
      try { const result = await api<{ autoActivated?: boolean }>(`/api/import-sessions/${item.sessionId}/apply`, { method: 'POST', body: JSON.stringify(item.targetAreaId ? { targetAreaId: item.targetAreaId } : { createAreaName: item.createAreaName }) }); success += 1; if (result.autoActivated) autoActivated += 1; next[index] = { ...item, sessionId: '', error: '已导入' }; }
      catch (error) { next[index] = { ...item, error: error instanceof ApiClientError ? error.message : '导入失败' }; }
    }
    const failed = next.length - success; setItems(next); toast[failed ? 'warning' : 'success'](`导入完成：${success} 成功，${failed} 失败${autoActivated ? `，其中 ${autoActivated} 个计划已自动设为进行中` : ''}`); await onImported(); setBusy(false); if (!failed) { setItems([]); onClose(); }
  }
  return <Modal open={open} onOpenChange={(value) => { if (!value) void close(); }} title="导入计划" description="支持一次选择多个 v2 .plan.json 文件，每个文件流式校验并独立处理。" wide>
    <div className="import-toolbar"><input ref={input} type="file" accept=".json,.plan.json" multiple hidden onChange={(e) => choose(e.target.files)} /><button className="secondary-button" onClick={() => input.current?.click()}><FileUp size={17} />选择文件</button>{items.length > 1 && <><select value={defaultArea} onChange={(e) => setDefaultArea(e.target.value)}><option value="">本批默认领域</option>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select><button className="secondary-button" onClick={applyDefault}>应用到全部</button></>}</div>
    <div className="import-list">{items.length === 0 ? <div className="empty-inline">尚未选择文件</div> : items.map((item, index) => <div className={`import-row ${item.error ? 'import-row-error' : ''}`} key={`${item.fileName}-${index}`}><div><strong>{item.planName}</strong><small>{item.fileName}{item.areaName ? ` · 文件领域：${item.areaName}` : ''}{item.error ? ` · ${item.error}` : ''}</small></div>{!item.error && <><select value={item.targetAreaId} onChange={(e) => setItems((current) => current.map((entry, i) => i === index ? { ...entry, targetAreaId: e.target.value, createAreaName: '' } : entry))}><option value="">创建文件中的领域</option>{areas.map((area) => <option value={area.id} key={area.id}>{area.name}</option>)}</select>{!item.targetAreaId && <input aria-label="新领域名称" placeholder="新领域名称" value={item.createAreaName} onChange={(e) => setItems((current) => current.map((entry, i) => i === index ? { ...entry, createAreaName: e.target.value } : entry))} />}</>}</div>)}</div>
    <div className="dialog-actions"><button className="secondary-button" onClick={() => void close()}>取消</button><button className="primary-button" disabled={busy || items.every((item) => Boolean(item.error))} onClick={submit}>{busy ? '正在处理' : `导入 ${items.filter((item) => !item.error).length || ''} 个计划`}</button></div>
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
      const result = await api<{ areaName: string; importedPlanCount: number; autoActivatedPlanCount: number }>('/api/area-imports', { method: 'POST', body: JSON.stringify(body) });
      toast.success(`领域“${result.areaName}”已导入，共 ${result.importedPlanCount} 个计划${result.autoActivatedPlanCount ? `，其中 ${result.autoActivatedPlanCount} 个已自动设为进行中` : ''}`);
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
