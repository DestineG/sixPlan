import { memo } from 'react';
import { CalendarDays, ExternalLink, PauseCircle } from 'lucide-react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { nodeStatusLabels, planStatusLabels, type NodeDto } from '@sixplan/shared';
import { isNodeOverdue } from '../date-utils';

export interface PlanNodeData extends Record<string, unknown> {
  node: NodeDto;
  today: string;
  onOpenChild?: (node: NodeDto) => void;
}

export const PlanNodeCard = memo(function PlanNodeCard({ data, selected }: NodeProps) {
  const node = (data as PlanNodeData).node;
  const openChild = (data as PlanNodeData).onOpenChild;
  const overdue = isNodeOverdue(node.status, node.endDate, (data as PlanNodeData).today);
  return <div className={`graph-node status-border-${node.status} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="graph-node-heading"><strong>{node.title}</strong><div className="node-status-stack"><span className={`node-status node-status-${node.status}`}>{nodeStatusLabels[node.status]}</span>{overdue && <span className="overdue-badge">已逾期</span>}</div></div>
    {node.summary && <p>{node.summary}</p>}
    {node.childPlan && <button className="node-child-link nodrag nowheel" title={`进入子计划：${node.childPlan.name}`} onClick={(event) => {
      event.stopPropagation(); openChild?.(node);
    }}><span><strong>{node.childPlan.name}</strong><small>{planStatusLabels[node.childPlan.status]} · {node.childPlan.completedNodeCount}/{node.childPlan.nodeCount} 已完成{node.childPlan.archivedAt ? ' · 已归档' : ''}</small></span><ExternalLink size={14} /></button>}
    <div className="graph-node-dates">{node.startDate || node.endDate ? <><CalendarDays size={13} /><span>{node.startDate ?? '未定'} – {node.endDate ?? '未定'}</span></> : <><PauseCircle size={13} /><span>未设置日期</span></>}</div>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
});
