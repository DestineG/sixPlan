import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type Edge, type Node, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { AlignHorizontalSpaceAround, ArrowLeft, BookOpenText, CalendarDays, CalendarX, Copy, Download, Plus, Trash2 } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { nodeStatusLabels, planStatusLabels, type EdgeDto, type GraphDto, type NodeDto, type PlanStatus } from '@sixplan/shared';
import { api, ApiClientError, downloadFile } from '../api';
import { copyText } from '../clipboard';
import { PlanNodeCard, type PlanNodeData } from '../components/PlanNodeCard';
import { addToDateOnly, deriveDateManagedNodeStatus, isNodeOverdue, localToday, type DateIncrementUnit } from '../date-utils';

type FlowNode = Node<PlanNodeData, 'planNode'>;
type FlowEdge = Edge<{ edge: EdgeDto }>;
const nodeTypes: NodeTypes = { planNode: PlanNodeCard };
const MarkdownModal = lazy(() => import('../components/MarkdownModal').then((module) => ({ default: module.MarkdownModal })));

function isMobileViewport() { return window.matchMedia('(max-width: 760px)').matches; }

export function GraphPage() { return <ReactFlowProvider><GraphWorkspace /></ReactFlowProvider>; }

function GraphWorkspace() {
  const { planId = '' } = useParams(); const queryClient = useQueryClient(); const flow = useReactFlow<FlowNode, FlowEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]); const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [markdownNode, setMarkdownNode] = useState<NodeDto | null>(null); const [mobile, setMobile] = useState(isMobileViewport);
  const [statusDate, setStatusDate] = useState(localToday);
  const [savingPlanStatus, setSavingPlanStatus] = useState<PlanStatus | null>(null);
  const lastReconciledDay = useRef<string | null>(null);
  const graphQuery = useQuery({ queryKey: ['graph', planId], queryFn: () => api<{ graph: GraphDto }>(`/api/plans/${planId}/graph`), staleTime: 0, refetchOnMount: 'always' });
  useEffect(() => { const media = window.matchMedia('(max-width: 760px)'); const change = () => setMobile(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  useEffect(() => { if (!graphQuery.data) return; const graph = graphQuery.data.graph;
    setNodes(graph.nodes.map((node) => ({ id: node.id, type: 'planNode', position: { x: node.positionX, y: node.positionY }, data: { node, today: statusDate } })));
    setEdges(graph.edges.map((edge) => ({ id: edge.id, source: edge.sourceNodeId, target: edge.targetNodeId, data: { edge }, markerEnd: { type: MarkerType.ArrowClosed }, style: { strokeWidth: 1.7 } })));
  }, [graphQuery.data, setEdges, setNodes, statusDate]);
  useEffect(() => {
    if (nodes.length === 0) return;
    const timer = window.setTimeout(() => flow.fitView({ padding: mobile ? 0.22 : 0.16, duration: 300, maxZoom: 1.15 }), 40);
    return () => clearTimeout(timer);
  }, [flow, mobile, nodes.length]);
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
    setNodes((current) => [...current, { id: node.id, type: 'planNode', position, data: { node, today: statusDate }, selected: true }]); setSelectedNodeId(node.id); toast.success('节点已添加');
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
  async function removeSelected() { if (readOnly) return; if (selectedNode) { if (!window.confirm(`删除节点“${selectedNode.title}”及其关联连接？`)) return; try { await api(`/api/nodes/${selectedNode.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: selectedNode.version }) }); setSelectedNodeId(null); await refresh(); toast.success('节点已删除'); } catch (error) { showError(error); } return; }
    const edge = edges.find((item) => item.id === selectedEdgeId)?.data?.edge; if (edge) { try { await api(`/api/edges/${edge.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: edge.version }) });
      queryClient.setQueryData<{ graph: GraphDto }>(['graph', planId], (current) => current ? { graph: { ...current.graph, edges: current.graph.edges.filter((item) => item.id !== edge.id) } } : current);
      setEdges((current) => current.filter((item) => item.id !== edge.id)); setSelectedEdgeId(null); } catch (error) { showError(error); } }
  }
  async function layout() { const layoutGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({})); layoutGraph.setGraph({ rankdir: 'LR', nodesep: 64, ranksep: 96, marginx: 48, marginy: 48 });
    nodes.forEach((node) => layoutGraph.setNode(node.id, { width: 240, height: 132 })); edges.forEach((edge) => layoutGraph.setEdge(edge.source, edge.target)); dagre.layout(layoutGraph);
    const positioned = nodes.map((node) => { const point = layoutGraph.node(node.id); return { ...node, position: { x: point.x - 120, y: point.y - 66 } }; }); setNodes(positioned);
    try { const result = await api<{ nodes: NodeDto[] }>(`/api/plans/${planId}/nodes/positions`, { method: 'PUT', body: JSON.stringify({ positions: positioned.map((node) => ({ id: node.id, positionX: node.position.x, positionY: node.position.y, expectedVersion: node.data.node.version })) }) }); result.nodes.forEach(updateNode); requestAnimationFrame(() => flow.fitView({ padding: 0.18, duration: 400 })); toast.success('自动布局已保存'); } catch (error) { showError(error); await refresh(); }
  }
  if (graphQuery.isLoading) return <div className="page-loader"><span className="spinner" />加载计划图</div>;
  if (!graph) return <div className="error-state">计划图加载失败。<Link to="/">返回总览</Link></div>;
  return <div className="graph-page">
    <header className="graph-toolbar"><div className="graph-title"><Link className="icon-button" to={graph.plan.archivedAt ? '/?view=archived' : '/'} title="返回计划总览"><ArrowLeft size={18} /></Link><div className="graph-title-copy"><span>{graph.plan.areaName}</span><h1>{graph.plan.name}</h1></div>{!readOnly ? <label className="plan-status-control"><span>计划状态</span><select aria-label="计划状态" value={savingPlanStatus ?? graph.plan.status} disabled={Boolean(savingPlanStatus)} onChange={(event) => void changePlanStatus(event.target.value as PlanStatus)}>{Object.entries(planStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : <span className={`status-pill status-${graph.plan.status}`}>{planStatusLabels[graph.plan.status]}</span>}{graph.plan.archivedAt && <span className="archived-badge">已归档</span>}{mobile && <span className="readonly-badge">移动端只读</span>}</div>
      <div className="graph-actions">{!readOnly && <><button className="secondary-button" onClick={addNode}><Plus size={17} />添加节点</button><button className="secondary-button" onClick={layout} disabled={nodes.length === 0}><AlignHorizontalSpaceAround size={17} />自动布局</button><button className="danger-ghost-button" onClick={removeSelected} disabled={!selectedNodeId && !selectedEdgeId}><Trash2 size={17} />删除所选</button></>}<button className="secondary-button" onClick={() => downloadFile(`/api/plans/${planId}/export`).catch(showError)}><Download size={17} />导出</button></div></header>
    {readOnly && <div className="readonly-strip">{graph.plan.archivedAt ? '归档计划为只读状态。恢复后才能继续编辑。' : '移动端提供只读查看，请在桌面浏览器中编辑计划图。'}</div>}
    <div className="graph-body"><section className="graph-canvas"><ReactFlow<FlowNode, FlowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onConnect={connect} onNodeDragStop={(_, node) => savePosition(node)} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
      onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }} nodesDraggable={!readOnly} nodesConnectable={!readOnly} deleteKeyCode={null}
      onlyRenderVisibleElements={nodes.length > 500} fitView minZoom={0.2} maxZoom={1.8}>
      <Background gap={22} size={1} color="#d8dee2" /><MiniMap pannable zoomable nodeStrokeWidth={3} /><Controls showInteractive={false} /></ReactFlow></section>
      <aside className={`node-panel ${selectedNode ? 'open' : ''}`}>{selectedNode ? <NodeDetail key={selectedNode.id} node={selectedNode} readOnly={readOnly} onUpdated={updateNode} onPlanUpdated={applyPlanUpdate} onMarkdown={() => setMarkdownNode(selectedNode)} /> : <div className="panel-empty"><BookOpenText size={24} /><p>选择一个节点查看详情</p></div>}</aside></div>
    {markdownNode && <Suspense fallback={<div className="modal-loader"><span className="spinner" />加载编辑器</div>}><MarkdownModal node={markdownNode} readOnly={readOnly} onClose={() => setMarkdownNode(null)} onSaved={updateNode} /></Suspense>}
  </div>;
}

function NodeDetail({ node, readOnly, onUpdated, onPlanUpdated, onMarkdown }: { node: NodeDto; readOnly: boolean; onUpdated: (node: NodeDto) => void; onPlanUpdated: (plan: GraphDto['plan'], autoActivated: boolean) => void; onMarkdown: () => void }) {
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
      <button className="secondary-button full-button" onClick={onMarkdown}><BookOpenText size={17} />{readOnly ? '查看附加信息' : '编辑附加信息'}</button></div>
  </div>;
}
