import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { PromptContextNode } from '../ai-prompts';

interface ScopeNodeData extends Record<string, unknown> {
  key: string;
  title: string;
  status: string;
  checked: boolean;
  dimmed: boolean;
  onToggle: (key: string) => void;
}

type ScopeNode = Node<ScopeNodeData, 'promptScope'>;

const ScopeNodeCard = memo(function ScopeNodeCard({ data }: NodeProps<ScopeNode>) {
  return <div className={`prompt-scope-node status-border-${data.status} ${data.checked ? 'selected' : ''} ${data.dimmed ? 'dimmed' : ''}`}>
    <Handle type="target" position={Position.Left} isConnectable={false} />
    <label onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" aria-label={`选择节点 ${data.title}`} checked={data.checked} onChange={() => data.onToggle(data.key)} />
      <span title={data.title}>{data.title}</span>
    </label>
    <code>{data.key}</code>
    <Handle type="source" position={Position.Right} isConnectable={false} />
  </div>;
});

const nodeTypes: NodeTypes = { promptScope: ScopeNodeCard };

export function PromptScopeGraph({ nodes, edges, selectedKeys, onSelectedKeysChange }: {
  nodes: PromptContextNode[];
  edges: Array<{ source: string; target: string }>;
  selectedKeys: string[];
  onSelectedKeysChange: (keys: string[]) => void;
}) {
  return <ReactFlowProvider><ScopeGraph nodes={nodes} edges={edges} selectedKeys={selectedKeys} onSelectedKeysChange={onSelectedKeysChange} /></ReactFlowProvider>;
}

function ScopeGraph({ nodes, edges, selectedKeys, onSelectedKeysChange }: Parameters<typeof PromptScopeGraph>[0]) {
  const [search, setSearch] = useState('');
  const flow = useReactFlow<ScopeNode, Edge>();
  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const toggle = useCallback((key: string) => {
    onSelectedKeysChange(selected.has(key) ? selectedKeys.filter((value) => value !== key) : [...selectedKeys, key]);
  }, [onSelectedKeysChange, selected, selectedKeys]);
  const flowNodes = useMemo<ScopeNode[]>(() => nodes.map((node) => {
    const matches = !normalizedSearch || node.title.toLocaleLowerCase().includes(normalizedSearch) || node.key.includes(normalizedSearch);
    return { id: node.key, type: 'promptScope', position: node.position, data: { key: node.key, title: node.title, status: node.status,
      checked: selected.has(node.key), dimmed: !matches, onToggle: toggle } };
  }), [nodes, normalizedSearch, selected, toggle]);
  const flowEdges = useMemo<Edge[]>(() => edges.map((edge) => ({ id: `${edge.source}-${edge.target}`, source: edge.source, target: edge.target,
    markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#9ba9ae', strokeWidth: 1.5 } })), [edges]);
  useEffect(() => {
    if (!normalizedSearch) return;
    const matches = flowNodes.filter((node) => !node.data.dimmed);
    if (matches.length) requestAnimationFrame(() => flow.fitView({ nodes: matches, padding: 0.5, maxZoom: 1.2, duration: 250 }));
  }, [flow, flowNodes, normalizedSearch]);

  return <div className="prompt-scope-picker">
    <label className="prompt-node-search"><Search size={15} /><input aria-label="搜索操作范围节点" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索节点名称或 key" /></label>
    <div className="prompt-scope-canvas">
      {nodes.length ? <ReactFlow<ScopeNode, Edge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} onNodeClick={(_, node) => toggle(node.id)}
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} deleteKeyCode={null}
        fitView fitViewOptions={{ padding: 0.3, maxZoom: 1.05 }} minZoom={0.15} maxZoom={1.6} onlyRenderVisibleElements={nodes.length > 500}>
        <Background gap={20} size={1} color="#dce3e5" /><Controls showInteractive={false} />
      </ReactFlow> : <div className="empty-inline">当前计划还没有节点</div>}
    </div>
  </div>;
}
