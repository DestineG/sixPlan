import { memo } from 'react';
import { CalendarDays, ListChecks, PauseCircle } from 'lucide-react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { nodeStatusLabels, type NodeDto } from '@sixplan/shared';
import { isNodeOverdue } from '../date-utils';

export interface PlanNodeData extends Record<string, unknown> { node: NodeDto; today: string; }

export const PlanNodeCard = memo(function PlanNodeCard({ data, selected }: NodeProps) {
  const node = (data as PlanNodeData).node;
  const overdue = isNodeOverdue(node.status, node.endDate, (data as PlanNodeData).today);
  const completedSteps = node.steps.filter((step) => step.status === 'completed').length;
  const activeStep = node.steps.find((step) => step.status === 'in_progress');
  return <div className={`graph-node status-border-${node.status} ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} className="node-handle" />
    <div className="graph-node-heading"><strong>{node.title}</strong><div className="node-status-stack"><span className={`node-status node-status-${node.status}`}>{nodeStatusLabels[node.status]}</span>{overdue && <span className="overdue-badge">已逾期</span>}</div></div>
    {node.summary && <p>{node.summary}</p>}
    {node.steps.length > 0 && <div className="graph-node-steps"><ListChecks size={13} /><span>{completedSteps}/{node.steps.length}</span><strong>{activeStep?.title ?? '暂无进行中子阶段'}</strong></div>}
    <div className="graph-node-dates">{node.startDate || node.endDate ? <><CalendarDays size={13} /><span>{node.startDate ?? '未定'} – {node.endDate ?? '未定'}</span></> : <><PauseCircle size={13} /><span>未设置日期</span></>}</div>
    <Handle type="source" position={Position.Right} className="node-handle" />
  </div>;
});
