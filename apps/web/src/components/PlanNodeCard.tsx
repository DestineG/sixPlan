import { memo } from 'react';
import { CalendarDays, PauseCircle } from 'lucide-react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { nodeStatusLabels, type NodeDto } from '@sixplan/shared';

export interface PlanNodeData extends Record<string, unknown> { node: NodeDto; }

export const PlanNodeCard = memo(function PlanNodeCard({ data, selected }: NodeProps) {
  const node = (data as PlanNodeData).node;
  return <div className={`graph-node status-border-${node.status} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="graph-node-heading"><strong>{node.title}</strong><span className={`node-status node-status-${node.status}`}>{nodeStatusLabels[node.status]}</span></div>
    {node.summary && <p>{node.summary}</p>}
    <div className="graph-node-dates">{node.startDate || node.endDate ? <><CalendarDays size={13} /><span>{node.startDate ?? '未定'} – {node.endDate ?? '未定'}</span></> : <><PauseCircle size={13} /><span>未设置日期</span></>}</div>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
});
