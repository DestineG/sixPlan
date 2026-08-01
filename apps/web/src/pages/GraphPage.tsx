import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { AlignHorizontalSpaceAround, ArrowLeft, BookOpenText, CalendarDays, CalendarX, Copy, Download, FolderTree, GitBranch, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { nodeStatusLabels, planStatusLabels, type AreaDto, type EdgeDto, type GraphDto, type NodeDto, type PlanDto, type PlanStatus } from '@sixplan/shared';
import { api, ApiClientError, downloadFile } from '../api';
import { copyText } from '../clipboard';
import { PlanNodeCard, type PlanNodeData } from '../components/PlanNodeCard';
import { Modal } from '../components/Dialogs';
import { addToDateOnly, deriveDateManagedNodeStatus, isNodeOverdue, localToday, type DateIncrementUnit } from '../date-utils';

type FlowNode = Node<PlanNodeData, 'planNode'>;
type FlowEdge = Edge<{ edge: EdgeDto }>;
const nodeTypes: NodeTypes = { planNode: PlanNodeCard };
const minimapStatusColors = { not_started: '#66757c', in_progress: '#2568b5', completed: '#43813c', paused: '#b86a0d', abandoned: '#a6414b' } as const;
const MarkdownModal = lazy(() => import('../components/MarkdownModal').then((module) => ({ default: module.MarkdownModal })));

function isMobileViewport() { return window.matchMedia('(max-width: 760px)').matches; }

export function GraphPage() { return <ReactFlowProvider><GraphWorkspace /></ReactFlowProvider>; }

function GraphWorkspace() {
  const { planId = '' } = useParams(); const queryClient = useQueryClient(); const flow = useReactFlow<FlowNode, FlowEdge>();
  const navigate = useNavigate(); const location = useLocation();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]); const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [markdownNode, setMarkdownNode] = useState<NodeDto | null>(null); const [mobile, setMobile] = useState(isMobileViewport);
  const [statusDate, setStatusDate] = useState(localToday);
  const [savingPlanStatus, setSavingPlanStatus] = useState<PlanStatus | null>(null);
  const [childPlanNode, setChildPlanNode] = useState<NodeDto | null>(null);
  const [linkedNodeAction, setLinkedNodeAction] = useState<{ node: NodeDto; deleteNode: boolean } | null>(null);
  const [reparentOpen, setReparentOpen] = useState(false);
  const restoredPlan = useRef<string | null>(null);
  const lastReconciledDay = useRef<string | null>(null);
  const graphQuery = useQuery({ queryKey: ['graph', planId], queryFn: () => api<{ graph: GraphDto }>(`/api/plans/${planId}/graph`), staleTime: 0, refetchOnMount: 'always' });
  const rememberViewport = useCallback(() => { sessionStorage.setItem(`sixplan:graph-view:${planId}`, JSON.stringify(flow.getViewport())); }, [flow, planId]);
  const openChildPlan = useCallback((node: NodeDto) => {
    if (!node.childPlan) return;
    rememberViewport();
    sessionStorage.setItem(`sixplan:graph-selected:${planId}`, node.id);
    navigate(`/plans/${node.childPlan.id}`, { state: { returnTo: `${location.pathname}${location.search}`, returnNodeId: node.id } });
  }, [location.pathname, location.search, navigate, planId, rememberViewport]);
  useEffect(() => { const media = window.matchMedia('(max-width: 760px)'); const change = () => setMobile(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => { if (!graphQuery.data) return; const graph = graphQuery.data.graph;
    setNodes(graph.nodes.map((node) => ({ id: node.id, type: 'planNode', position: { x: node.positionX, y: node.positionY }, data: { node, today: statusDate, onOpenChild: openChildPlan } })));
    setEdges(graph.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, data: { edge }, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.7 } })));
  }, [graphQuery.data, openChildPlan, setEdges, setNodes, statusDate]);
  useEffect(() => { setNodes((current) => current.map((node) => ({ ...node, selected: node.id === selectedNodeId }))); }, [selectedNodeId, setNodes]);
  useEffect(() => {
    if (nodes.length === 0) return;
    if (restoredPlan.current === planId) return;
    restoredPlan.current = planId;
    const timer = window.setTimeout(() => {
      const saved = sessionStorage.getItem(`sixplan:graph-view:${planId}`);
      if (saved) {
        try { void flow.setViewport(JSON.parse(saved) as { x: number; y: number; zoom: number }, { duration: 180 }); }
        catch { flow.fitView({ padding: mobile ? 0.22 : 0.16, duration: 300, maxZoom: 1.15 }); }
      } else flow.fitView({ padding: mobile ? 0.22 : 0.16, duration: 300, maxZoom: 1.15 });
      const focusNodeId = (location.state as { focusNodeId?: string } | null)?.focusNodeId ?? sessionStorage.getItem(`sixplan:graph-selected:${planId}`) ?? undefined;
      if (focusNodeId && nodes.some((node) => node.id === focusNodeId)) setSelectedNodeId(focusNodeId);
    }, 40);
    return () => clearTimeout(timer);
  }, [flow, location.state, mobile, nodes, planId]);
  const graph = graphQuery.data?.graph; const planArchivedAt = graph?.plan.archivedAt; const readOnly = Boolean(planArchivedAt) || mobile;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId)?.data.node;
  const refreshOverview = useCallback(async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['areas'] }), queryClient.invalidateQueries({ queryKey: ['plans'] })]);
  }, [queryClient]);

  useEffect(() => {
    if (planArchivedAt !== null) return;
    let disposed = false; let reconciliationInFlight = false; let midnightTimer = 0;
    lastReconciledDay.current = null;
    async function reconcileStatuses() {
      const today = localToday();
      if (lastReconciledDay.current === today || reconciliationInFlight) return;
      setStatusDate(today);
      reconciliationInFlight = true;
      try {
        const result = await api<{ nodes: NodeDto[]; plan: GraphDto['plan']; autoActivated: boolean }>(`/api/plans/${planId}/nodes/reconcile-statuses`, {
          method: 'POST', body: JSON.stringify({ today })
        });
        if (disposed) return;
        lastReconciledDay.current = today;
        const updated = new Map(result.nodes.map((node) => [node.id, node]));
        queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? {
          graph: { ...current.graph, plan: result.plan, nodes: current.graph.nodes.map((node) => updated.get(node.id) ?? node) }
        } : current);
        if (result.autoActivated) { toast.success('计划已根据节点状态自动设为进行中'); void refreshOverview(); }
      } catch (error) {
        if (!disposed) toast.error(error instanceof ApiClientError ? error.message : '节点状态校准失败');
      } finally {
        reconciliationInFlight = false;
      }
    }
    function scheduleMidnightCheck() {
      const now = new Date(); const nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      midnightTimer = window.setTimeout(() => { void reconcileStatuses(); scheduleMidnightCheck(); }, nextDay.getTime() - now.getTime());
    }
    function onVisibilityChange() { if (document.visibilityState === 'visible') void reconcileStatuses(); }
    void reconcileStatuses(); scheduleMidnightCheck(); document.addEventListener('visibilitychange', onVisibilityChange);
    return () => { disposed = true; window.clearTimeout(midnightTimer); document.removeEventListener('visibilitychange', onVisibilityChange); };
  }, [planArchivedAt, planId, queryClient, refreshOverview]);

  function showError(error: unknown) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }
  function returnFromPlan() {
    rememberViewport();
    const state = location.state as { returnTo?: string; returnNodeId?: string } | null;
    if (state?.returnTo) navigate(state.returnTo, { state: { focusNodeId: state.returnNodeId } });
    else if (graph?.plan.parent) navigate(`/plans/${graph.plan.parent.planId}`, { state: { focusNodeId: graph.plan.parent.nodeId } });
    else navigate(graph?.plan.archivedAt ? '/?view=archived' : '/');
  }
  async function refresh() { await queryClient.invalidateQueries({ queryKey: ['graph', planId] }); }
  function applyPlanUpdate(plan: GraphDto['plan'], autoActivated: boolean) {
    queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? { graph: { ...current.graph, plan } } : current);
    if (autoActivated) { toast.success('计划已根据节点状态自动设为进行中'); void refreshOverview(); }
  }
  async function changePlanStatus(status: PlanStatus) {
    if (!graph || readOnly || status === graph.plan.status || savingPlanStatus) return;
    setSavingPlanStatus(status);
    try {
      const result = await api<{ plan: GraphDto['plan'] }>(`/api/plans/${planId}`, { method: 'PATCH',
        body: JSON.stringify({ status, expectedVersion: graph.plan.version }) });
      queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? {
        graph: { ...current.graph, plan: result.plan }
      } : current);
      await refreshOverview();
      toast.success('计划状态已更新');
    } catch (error) {
      showError(error);
      if (error instanceof ApiClientError && error.status === 409) await refresh();
    } finally { setSavingPlanStatus(null); }
  }
  async function addNode() { try { const position = { x: 100 + (nodes.length % 4) * 280, y: 100 + Math.floor(nodes.length / 4) * 190 };
    const { node } = await api<{ node: NodeDto }>(`/api/plans/${planId}/nodes`, { method: 'POST', body: JSON.stringify({ title: '新节点', positionX: position.x, positionY: position.y }) });
    queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? { graph: { ...current.graph, nodes: [...current.graph.nodes, node] } } : current);
    setNodes((current) => [...current, { id: node.id, type: 'planNode', position, data: { node, today: statusDate, onOpenChild: openChildPlan }, selected: true }]); setSelectedNodeId(node.id); toast.success('节点已添加');
  } catch (error) { showError(error); } }
  async function connect(connection: Connection) { if (!connection.source || !connection.target || readOnly) return; try { const { edge } = await api<{ edge: EdgeDto }>(`/api/plans/${planId}/edges`, { method: 'POST', body: JSON.stringify({ sourceNodeId: connection.source, targetNodeId: connection.target }) });
    queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? { graph: { ...current.graph, edges: [...current.graph.edges, edge] } } : current);
    setEdges((current) => [...current, { id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, data: { edge }, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.7 } }]);
  } catch (error) { showError(error); } }
  async function savePosition(node: FlowNode) { try { const result = await api<{ nodes: NodeDto[] }>(`/api/plans/${planId}/nodes/positions`, { method: 'PUT', body: JSON.stringify({ positions: [{ id: node.id, positionX: node.position.x, positionY: node.position.y, expectedVersion: node.data.node.version }] }) }); updateNode(result.nodes[0]!); } catch (error) { showError(error); await refresh(); } }
  function updateNode(updated: NodeDto) {
    queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? {
      graph: { ...current.graph, nodes: current.graph.nodes.map((node) => node.id === updated.id ? updated : node) }
    } : current);
    setNodes((current) => current.map((node) => node.id === updated.id ? { ...node, data: { ...node.data, node: updated } } : node));
    if (markdownNode?.id === updated.id) setMarkdownNode(updated);
  }
  async function removeSelected() { if (readOnly) return; if (selectedNode) { if (selectedNode.childPlan) { setLinkedNodeAction({ node: selectedNode, deleteNode: true }); return; } if (!window.confirm(`删除节点“${selectedNode.title}”及其关联连接？`)) return; try { await api(`/api/nodes/${selectedNode.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: selectedNode.version }) }); setSelectedNodeId(null); await refresh(); toast.success('节点已删除'); } catch (error) { showError(error); } return; }
    const edge = edges.find((item) => item.id === selectedEdgeId)?.data?.edge; if (edge) { try { await api(`/api/edges/${edge.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: edge.version }) });
      queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? { graph: { ...current.graph, edges: current.graph.edges.filter((item) => item.id !== edge.id) } } : current);
      setEdges((current) => current.filter((item) => item.id !== edge.id)); setSelectedEdgeId(null); } catch (error) { showError(error); } }
  }
  async function layout() { const layoutGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({})); layoutGraph.setGraph({ rankdir: 'LR', nodesep: 64, ranksep: 96, marginx: 48, marginy: 48 });
    nodes.forEach((node) => layoutGraph.setNode(node.id, { width: 240, height: node.data.node.childPlan ? 190 : 132 })); edges.forEach((edge) => layoutGraph.setEdge(edge.source, edge.target)); dagre.layout(layoutGraph);
    const positioned = nodes.map((node) => { const point = layoutGraph.node(node.id); const height = node.data.node.childPlan ? 190 : 132; return { ...node, position: { x: point.x - 120, y: point.y - height / 2 } }; }); setNodes(positioned);
    try { const result = await api<{ nodes: NodeDto[] }>(`/api/plans/${planId}/nodes/positions`, { method: 'PUT', body: JSON.stringify({ positions: positioned.map((node) => ({ id: node.id, positionX: node.position.x, positionY: node.position.y, expectedVersion: node.data.node.version })) }) }); result.nodes.forEach(updateNode); requestAnimationFrame(() => flow.fitView({ padding: 0.18, duration: 400 })); toast.success('自动布局已保存'); } catch (error) { showError(error); await refresh(); }
  }
  if (graphQuery.isLoading) return <div className="page-loader"><span className="spinner" />加载计划图</div>;
  if (!graph) return <div className="error-state">计划图加载失败。<Link to="/">返回总览</Link></div>;
  return <div className="graph-page">
    <header className="graph-toolbar"><div className="graph-title"><button className="icon-button" onClick={returnFromPlan} title={graph.plan.parent ? '返回父计划' : '返回计划总览'}><ArrowLeft size={18} /></button><div className="graph-title-copy"><span>{graph.plan.parent ? `${graph.plan.areaName} · 子计划` : graph.plan.areaName}</span><h1>{graph.plan.name}</h1></div>{!readOnly ? <label className="plan-status-control"><span>计划状态</span><select aria-label="计划状态" value={savingPlanStatus ?? graph.plan.status} disabled={Boolean(savingPlanStatus)} onChange={(event) => void changePlanStatus(event.target.value as PlanStatus)}>{Object.entries(planStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <span className={`status-pill status-${graph.plan.status}`}>{planStatusLabels[graph.plan.status]}</span>}{graph.plan.archivedAt && <span className="archived-badge">已归档</span>}{mobile && <span className="readonly-badge">移动端只读</span>}</div>
      <div className="graph-actions">{!readOnly && <>{graph.plan.parent && <button className="secondary-button" onClick={() => setReparentOpen(true)}><GitBranch size={17} />更换父节点</button>}<button className="secondary-button" onClick={addNode}><Plus size={17} />添加节点</button><button className="secondary-button" onClick={layout} disabled={nodes.length === 0}><AlignHorizontalSpaceAround size={17} />自动布局</button><button className="danger-ghost-button" onClick={removeSelected} disabled={!selectedNodeId && !selectedEdgeId}><Trash2 size={17} />删除所选</button></>}<button className="secondary-button" onClick={() => downloadFile(`/api/plans/${planId}/export`).catch(showError)}><Download size={17} />导出当前</button><button className="secondary-button" onClick={() => downloadFile(`/api/plans/${planId}/export-bundle`).catch(showError)}><FolderTree size={17} />导出计划树</button></div></header>
    {readOnly && <div className="readonly-strip">{graph.plan.archivedAt ? '归档计划为只读状态。恢复后才能继续编辑。' : '移动端提供只读查看，请在桌面浏览器中编辑计划图。'}</div>}
    <div className="graph-body"><section className="graph-canvas"><ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={connect} onNodeDragStop={(_, node) => savePosition(node)} onNodeClick={(_, node) => { setSelectedNodeId(node.id); sessionStorage.setItem(`sixplan:graph-selected:${planId}`, node.id); setSelectedEdgeId(null); }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
      onPaneClick={() => { setSelectedNodeId(null); sessionStorage.removeItem(`sixplan:graph-selected:${planId}`); setSelectedEdgeId(null); }} onMoveEnd={rememberViewport} nodesDraggable={!readOnly} nodesConnectable={!readOnly} deleteKeyCode={null}
      onlyRenderVisibleElements={nodes.length > 500} fitView minZoom={0.2} maxZoom={1.8}>
      <Background gap={22} size={1} color="#d8dee2" /><MiniMap pannable zoomable nodeStrokeWidth={3} nodeColor={(node) => minimapStatusColors[(node.data as PlanNodeData).node.status]} /><Controls showInteractive={false} /></ReactFlow></section>
      <aside className={`node-panel ${selectedNode ? 'open' : ''}`}>{selectedNode ? <NodeDetail key={selectedNode.id} node={selectedNode} readOnly={readOnly} onUpdated={updateNode} onPlanUpdated={applyPlanUpdate} onMarkdown={() => setMarkdownNode(selectedNode)} onOpenChild={() => openChildPlan(selectedNode)} onManageChild={() => selectedNode.childPlan ? setLinkedNodeAction({ node: selectedNode, deleteNode: false }) : setChildPlanNode(selectedNode)} /> : <div className="panel-empty"><BookOpenText size={24} /><p>选择一个节点查看详情</p></div>}</aside></div>
    {markdownNode && <Suspense fallback={<div className="modal-loader"><span className="spinner" />加载编辑器</div>}><MarkdownModal node={markdownNode} readOnly={readOnly} onClose={() => setMarkdownNode(null)} onSaved={updateNode} /></Suspense>}
    <ChildPlanModal node={childPlanNode} parentPlan={graph.plan} onClose={() => setChildPlanNode(null)} onSaved={async (node, enter) => { updateNode(node); setChildPlanNode(null); await refreshOverview(); if (enter) openChildPlan(node); }} />
    <UnlinkOrDeleteNodeModal state={linkedNodeAction} onClose={() => setLinkedNodeAction(null)} onSaved={async (deleted) => { setLinkedNodeAction(null); if (deleted) setSelectedNodeId(null); await refresh(); await refreshOverview(); }} />
    <ReparentPlanModal plan={reparentOpen ? graph.plan : null} onClose={() => setReparentOpen(false)} onSaved={async () => { setReparentOpen(false); await refresh(); await refreshOverview(); }} />
  </div>;
}

function NodeDetail({ node, readOnly, onUpdated, onPlanUpdated, onMarkdown, onOpenChild, onManageChild }: { node: NodeDto; readOnly: boolean; onUpdated: (node: NodeDto) => void; onPlanUpdated: (plan: GraphDto['plan'], autoActivated: boolean) => void; onMarkdown: () => void; onOpenChild: () => void; onManageChild: () => void }) {
  const [form, setForm] = useState({ title: node.title, status: node.status, startDate: node.startDate ?? '', endDate: node.endDate ?? '', summary: node.summary });
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle'); const dirty = useRef(false); const version = useRef(node.version);
  useEffect(() => { if (!dirty.current || readOnly) return; setSaveState('saving'); const timer = window.setTimeout(async () => { try { const result = await api<{ node: NodeDto; plan: GraphDto['plan']; autoActivated: boolean }>(`/api/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify({ title: form.title, status: form.status, startDate: form.startDate || null, endDate: form.endDate || null, summary: form.summary, expectedVersion: version.current }) }); version.current = result.node.version; dirty.current = false; setSaveState('saved'); onUpdated(result.node); onPlanUpdated(result.plan, result.autoActivated); } catch (error) { setSaveState('error'); toast.error(error instanceof ApiClientError ? error.message : '自动保存失败'); } }, 500); return () => clearTimeout(timer); }, [form, node.id, onPlanUpdated, onUpdated, readOnly]);
  function change<K extends keyof typeof form>(key: K) { return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => { const value = event.target.value; dirty.current = true; setForm((current) => { const next = { ...current, [key]: value }; if (key === 'status' || key === 'startDate' || key === 'endDate') next.status = deriveDateManagedNodeStatus(next.status, next.startDate || null, localToday()); return next; }); }; }
  function setDatesToToday() { const today = localToday(); dirty.current = true; setForm((current) => ({ ...current, startDate: today, endDate: today, status: deriveDateManagedNodeStatus(current.status, today, today) })); }
  function clearDates() { dirty.current = true; setForm((current) => ({ ...current, startDate: '', endDate: '', status: deriveDateManagedNodeStatus(current.status, null, localToday()) })); }
  function extendEndDate(amount: number, unit: DateIncrementUnit) { if (!form.endDate) return; dirty.current = true; setForm((current) => ({ ...current, endDate: addToDateOnly(current.endDate, amount, unit), status: deriveDateManagedNodeStatus(current.status, current.startDate || null, localToday()) })); }
  const overdue = isNodeOverdue(form.status, form.endDate || null, localToday());
  return <div className="node-detail"><div className="panel-heading"><div><span>节点详情</span><small className={`save-state ${saveState}`}>{saveState === 'saving' ? '保存中' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''}</small></div></div>
    <div className="panel-form"><label>节点 key<div className="key-copy-row"><code>{node.key}</code><button className="icon-button" title="复制节点 key" onClick={() => copyText(node.key).then(() => toast.success('节点 key 已复制')).catch(() => toast.error('复制失败'))}><Copy size={15} /></button></div></label><label>名称<input value={form.title} onChange={change('title')} disabled={readOnly} /></label><label>节点状态<div className="node-status-field"><select value={form.status} onChange={change('status')} disabled={readOnly}>{Object.entries(nodeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{overdue && <span className="overdue-badge">已逾期</span>}</div></label>
      <div className="date-fields"><label>开始日期<input type="date" value={form.startDate} onChange={change('startDate')} disabled={readOnly} /></label><label>结束日期<input type="date" value={form.endDate} onChange={change('endDate')} disabled={readOnly} /></label></div>
      {!readOnly && <div className="date-shortcuts"><div className="date-primary-shortcuts"><button className="secondary-button today-shortcut" onClick={setDatesToToday}><CalendarDays size={16} />设置起止日期为今天</button><button className="secondary-button clear-date-shortcut" disabled={!form.startDate && !form.endDate} onClick={clearDates}><CalendarX size={16} />清除</button></div><div className="duration-shortcuts">
        <button className="secondary-button" disabled={!form.endDate} onClick={() => extendEndDate(1, 'day')}>+1天</button>
        <button className="secondary-button" disabled={!form.endDate} onClick={() => extendEndDate(1, 'week')}>+一周</button>
        <button className="secondary-button" disabled={!form.endDate} onClick={() => extendEndDate(1, 'month')}>+一个月</button>
        <button className="secondary-button" disabled={!form.endDate} onClick={() => extendEndDate(3, 'month')}>+三个月</button>
      </div></div>}
      <label>简短说明<textarea rows={5} maxLength={2000} value={form.summary} onChange={change('summary')} disabled={readOnly} /></label>
      <div className="child-plan-panel"><div><FolderTree size={17} /><strong>子计划</strong></div>{node.childPlan ? <><button className="child-plan-summary" onClick={onOpenChild}><span><strong>{node.childPlan.name}</strong><small>{node.childPlan.areaName} · {planStatusLabels[node.childPlan.status]} · {node.childPlan.completedNodeCount}/{node.childPlan.nodeCount} 已完成{node.childPlan.archivedAt ? ' · 已归档' : ''}</small></span><ArrowLeft className="child-enter-icon" size={16} /></button>{!readOnly && <button className="secondary-button full-button" onClick={onManageChild}><Unlink size={16} />解除关联</button>}</> : !readOnly ? <button className="secondary-button full-button" onClick={onManageChild}><Link2 size={16} />创建或关联子计划</button> : <span className="muted-copy">未关联子计划</span>}</div>
      <button className="secondary-button full-button" onClick={onMarkdown}><BookOpenText size={17} />{readOnly ? '查看附加信息' : '编辑附加信息'}</button></div>
  </div>;
}

function ChildPlanModal({ node, parentPlan, onClose, onSaved }: {
  node: NodeDto | null;
  parentPlan: PlanDto;
  onClose: () => void;
  onSaved: (node: NodeDto, enter: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<'create' | 'link'>('create'); const [areaId, setAreaId] = useState(parentPlan.areaId);
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [childPlanId, setChildPlanId] = useState('');
  const [enter, setEnter] = useState(true); const [busy, setBusy] = useState(false);
  const areasQuery = useQuery({ queryKey: ['areas'], queryFn: () => api<{ areas: AreaDto[] }>('/api/areas'), enabled: Boolean(node) });
  const plansQuery = useQuery({ queryKey: ['plans', 'link-candidates'], queryFn: () => api<{ plans: PlanDto[] }>('/api/plans?archive=unarchived'), enabled: Boolean(node) });
  const candidates = (plansQuery.data?.plans ?? []).filter((plan) => !plan.parent && plan.id !== parentPlan.id);
  useEffect(() => { if (!node) return; setMode('create'); setAreaId(parentPlan.areaId); setName(node.title);
    setDescription(node.summary || `由“${parentPlan.name}”中的节点“${node.title}”展开`); setChildPlanId(''); setEnter(true); }, [node, parentPlan.areaId, parentPlan.name]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!node) return; setBusy(true);
    try {
      const body = mode === 'create' ? { mode, areaId, name, description, expectedNodeVersion: node.version }
        : { mode, childPlanId, expectedNodeVersion: node.version };
      const result = await api<{ node: NodeDto }>(`/api/nodes/${node.id}/child-plan`, { method: 'POST', body: JSON.stringify(body) });
      toast.success(mode === 'create' ? '子计划已创建并关联' : '计划已关联为子计划'); await onSaved(result.node, enter);
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '关联子计划失败'); }
    finally { setBusy(false); }
  }
  return <Modal open={Boolean(node)} onOpenChange={(open) => !open && onClose()} title="创建或关联子计划"
    description="子计划仍是普通计划，可独立编辑、筛选和导出。一个节点只能关联一个子计划。">
    <form className="stack-form" onSubmit={submit}><div className="segmented-control"><button type="button" className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>创建新计划</button><button type="button" className={mode === 'link' ? 'active' : ''} onClick={() => setMode('link')}>关联已有计划</button></div>
      {mode === 'create' ? <><label>所属领域<select value={areaId} onChange={(event) => setAreaId(event.target.value)}>{(areasQuery.data?.areas ?? []).map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><label>计划名称<input value={name} maxLength={200} required onChange={(event) => setName(event.target.value)} /></label><label>计划说明<textarea rows={3} maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></label></>
      : <label>已有根计划<select value={childPlanId} required onChange={(event) => setChildPlanId(event.target.value)}><option value="">请选择未归档且未关联父节点的计划</option>{candidates.map((plan) => <option key={plan.id} value={plan.id}>{plan.name} · {plan.areaName}</option>)}</select></label>}
      <label className="checkbox-row"><input type="checkbox" checked={enter} onChange={(event) => setEnter(event.target.checked)} />关联后立即进入子计划</label>
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || (mode === 'create' ? !areaId || !name.trim() : !childPlanId)}>{busy ? '正在处理' : mode === 'create' ? '创建并关联' : '确认关联'}</button></div>
    </form>
  </Modal>;
}

function UnlinkOrDeleteNodeModal({ state, onClose, onSaved }: {
  state: { node: NodeDto; deleteNode: boolean } | null;
  onClose: () => void;
  onSaved: (deleted: boolean) => Promise<void>;
}) {
  const [action, setAction] = useState<'retain' | 'archive'>('retain'); const [includeDescendants, setIncludeDescendants] = useState(false);
  const [busy, setBusy] = useState(false); const node = state?.node;
  useEffect(() => { if (state) { setAction('retain'); setIncludeDescendants(false); } }, [state]);
  async function submit() {
    const current = state;
    if (!node?.childPlan || !current) return; setBusy(true);
    try {
      if (current.deleteNode) await api(`/api/nodes/${node.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: node.version,
        childPlanAction: action, includeDescendants: action === 'archive' && includeDescendants }) });
      else await api(`/api/nodes/${node.id}/child-plan`, { method: 'DELETE', body: JSON.stringify({ expectedNodeVersion: node.version,
        expectedLinkVersion: node.childPlan.linkVersion, action, includeDescendants: action === 'archive' && includeDescendants }) });
      toast.success(current.deleteNode ? '节点已删除，子计划关系已处理' : '子计划关联已解除'); await onSaved(current.deleteNode);
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }
    finally { setBusy(false); }
  }
  return <Modal open={Boolean(state)} onOpenChange={(open) => !open && onClose()} title={state?.deleteNode ? '删除已关联子计划的节点' : '解除子计划关联'}
    description={node?.childPlan ? `将解除节点“${node.title}”与子计划“${node.childPlan.name}”的关系。` : undefined}>
    <div className="stack-form"><fieldset className="choice-fieldset"><legend>解除后如何处理子计划</legend><label><input type="radio" name="child-action" checked={action === 'retain'} onChange={() => setAction('retain')} /><span><strong>保留子计划</strong><small>子计划成为独立的根计划，内容不变</small></span></label><label><input type="radio" name="child-action" checked={action === 'archive'} onChange={() => setAction('archive')} /><span><strong>归档子计划</strong><small>关系解除后将子计划移入已归档视图</small></span></label></fieldset>
      {action === 'archive' && <label className="checkbox-row"><input type="checkbox" checked={includeDescendants} onChange={(event) => setIncludeDescendants(event.target.checked)} />同时归档该子计划的全部后代</label>}
      {state?.deleteNode && <div className="notice warning">节点及其关联连接会被永久删除；子计划本身只按上方选择保留或归档。</div>}
      <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className={state?.deleteNode ? 'danger-button' : 'primary-button'} disabled={busy} onClick={submit}>{busy ? '正在处理' : state?.deleteNode ? '确认删除节点' : '确认解除'}</button></div>
    </div>
  </Modal>;
}

function ReparentPlanModal({ plan, onClose, onSaved }: { plan: PlanDto | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [parentPlanId, setParentPlanId] = useState(''); const [parentNodeId, setParentNodeId] = useState(''); const [busy, setBusy] = useState(false);
  const plansQuery = useQuery({ queryKey: ['plans', 'reparent-candidates'], queryFn: () => api<{ plans: PlanDto[] }>('/api/plans?archive=unarchived'), enabled: Boolean(plan) });
  const parentGraph = useQuery({ queryKey: ['graph', parentPlanId, 'reparent'], queryFn: () => api<{ graph: GraphDto }>(`/api/plans/${parentPlanId}/graph`), enabled: Boolean(plan && parentPlanId) });
  const candidates = (plansQuery.data?.plans ?? []).filter((candidate) => candidate.id !== plan?.id);
  const availableNodes = (parentGraph.data?.graph.nodes ?? []).filter((node) => !node.childPlan);
  useEffect(() => { if (plan) { setParentPlanId(''); setParentNodeId(''); } }, [plan]);
  useEffect(() => { setParentNodeId(''); }, [parentPlanId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!plan) return; const node = availableNodes.find((item) => item.id === parentNodeId); if (!node) return;
    setBusy(true);
    try {
      await api(`/api/plans/${plan.id}/parent`, { method: 'PATCH', body: JSON.stringify({ parentNodeId, expectedPlanVersion: plan.version, expectedNodeVersion: node.version,
        ...(plan.parent ? { expectedParentLinkVersion: plan.parent.linkVersion } : {}) }) });
      toast.success('子计划已更换父节点'); await onSaved();
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '更换父节点失败'); }
    finally { setBusy(false); }
  }
  return <Modal open={Boolean(plan)} onOpenChange={(open) => !open && onClose()} title="更换父节点"
    description="当前计划及其全部后代会整体保留，只改变它在计划树中的父节点。跨领域关联允许存在。">
    <form className="stack-form" onSubmit={submit}><label>新的父计划<select value={parentPlanId} onChange={(event) => setParentPlanId(event.target.value)}><option value="">请选择计划</option>{candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} · {candidate.areaName}</option>)}</select></label>
      <label>新的父节点<select value={parentNodeId} disabled={!parentPlanId || parentGraph.isLoading} onChange={(event) => setParentNodeId(event.target.value)}><option value="">请选择尚未关联子计划的节点</option>{availableNodes.map((node) => <option key={node.id} value={node.id}>{node.title}</option>)}</select></label>
      {parentPlanId && !parentGraph.isLoading && availableNodes.length === 0 && <div className="notice warning">所选计划没有可用节点。请先添加节点或解除已有子计划关联。</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !parentNodeId}>{busy ? '正在处理' : '确认更换'}</button></div>
    </form>
  </Modal>;
}
