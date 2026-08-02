import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, CalendarPlus, CalendarX, GripVertical, Plus, Trash2 } from 'lucide-react';
import { nodeStatusLabels, type GraphDto, type NodeDto, type NodeStepDto } from '@sixplan/shared';
import { toast } from 'sonner';
import { api, ApiClientError } from '../api';
import { addToDateOnly, deriveDateManagedNodeStatus, localToday, type DateIncrementUnit } from '../date-utils';
import { createRandomHex } from '../random';
import { Modal } from './Dialogs';

interface DraftStep extends NodeStepDto {
  isNew?: boolean;
}

function draftKey(): string {
  return `step-${createRandomHex(12)}`;
}

export function NodeStepsModal({ node, readOnly, onClose, onUpdated, onPlanUpdated }: {
  node: NodeDto | null;
  readOnly: boolean;
  onClose: () => void;
  onUpdated: (node: NodeDto) => void;
  onPlanUpdated: (plan: GraphDto['plan'], autoActivated: boolean) => void;
}) {
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const stepsRef = useRef<DraftStep[]>([]); const nodeVersion = useRef(0); const dirty = useRef(false); const summaryInput = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null); const inFlight = useRef<Promise<void> | null>(null); const dragId = useRef(''); const initializedNodeId = useRef(''); const selectedKey = useRef('');

  useEffect(() => {
    if (!node) { initializedNodeId.current = ''; return; }
    if (initializedNodeId.current === node.id) return;
    initializedNodeId.current = node.id;
    const initial = node.steps.map((step) => ({ ...step }));
    stepsRef.current = initial; setSteps(initial); selectedKey.current = initial[0]?.key ?? ''; setSelectedId(initial[0]?.id ?? '');
    nodeVersion.current = node.version; dirty.current = false; setSaveState('idle');
  }, [node]);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  function updateSteps(next: DraftStep[]) { stepsRef.current = next; setSteps(next); }
  function scheduleSave(immediate = false) {
    if (readOnly) return;
    dirty.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; void persist(); }, immediate ? 0 : 500);
  }
  function persist(): Promise<void> {
    if (!node || readOnly || !dirty.current) return inFlight.current ?? Promise.resolve();
    if (inFlight.current) return inFlight.current;
    dirty.current = false; setSaveState('saving');
    const snapshot = stepsRef.current.map((step) => ({
      ...(step.isNew ? {} : { id: step.id, expectedVersion: step.version }), key: step.key, title: step.title,
      status: step.status, startDate: step.startDate, endDate: step.endDate, summary: step.summary
    }));
    let failed = false;
    const request = api<{ node: NodeDto; plan: GraphDto['plan']; autoActivated: boolean }>(`/api/nodes/${node.id}/steps`, {
      method: 'PUT', body: JSON.stringify({ expectedNodeVersion: nodeVersion.current, steps: snapshot })
    }).then((result) => {
      nodeVersion.current = result.node.version;
      if (dirty.current) {
        const savedByKey = new Map(result.node.steps.map((step) => [step.key, step]));
        updateSteps(stepsRef.current.map((step, index) => {
          const saved = savedByKey.get(step.key);
          return saved ? { ...step, id: saved.id, version: saved.version, sortOrder: index, createdAt: saved.createdAt,
            updatedAt: saved.updatedAt, isNew: false } : step;
        }));
      } else {
        updateSteps(result.node.steps.map((step) => ({ ...step })));
      }
      const selected = result.node.steps.find((step) => step.key === selectedKey.current);
      setSelectedId(selected?.id ?? result.node.steps[0]?.id ?? ''); selectedKey.current = selected?.key ?? result.node.steps[0]?.key ?? '';
      onUpdated(result.node); onPlanUpdated(result.plan, result.autoActivated); setSaveState('saved');
    }).catch((error) => {
      failed = true; dirty.current = true; setSaveState('error');
      toast.error(error instanceof ApiClientError ? error.message : '子阶段自动保存失败');
    }).finally(() => {
      inFlight.current = null;
      if (dirty.current && !failed) scheduleSave(true);
    });
    inFlight.current = request;
    return request;
  }

  function addStep() {
    if (!node || readOnly) return;
    const first = stepsRef.current.length === 0; const now = new Date().toISOString(); const id = `draft-${createRandomHex(16)}`;
    const next: DraftStep = { id, nodeId: node.id, key: draftKey(), title: '新子阶段',
      status: first ? node.status : 'not_started', startDate: first ? node.startDate : null, endDate: first ? node.endDate : null,
      summary: '', sortOrder: stepsRef.current.length, version: 0, createdAt: now, updatedAt: now, isNew: true };
    updateSteps([...stepsRef.current, next]); selectedKey.current = next.key; setSelectedId(id); scheduleSave(true);
  }
  function change<K extends 'title' | 'status' | 'startDate' | 'endDate' | 'summary'>(key: K) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = event.target.value;
      updateSteps(stepsRef.current.map((step) => {
        if (step.id !== selectedId) return step;
        const next = { ...step, [key]: key === 'startDate' || key === 'endDate' ? value || null : value } as DraftStep;
        if (key === 'status' || key === 'startDate' || key === 'endDate') {
          next.status = deriveDateManagedNodeStatus(next.status, next.startDate, localToday());
        }
        return next;
      }));
      scheduleSave(key === 'status');
    };
  }
  function removeStep(step: DraftStep) {
    if (readOnly || !window.confirm(`删除子阶段“${step.title}”？`)) return;
    const next = stepsRef.current.filter((item) => item.id !== step.id).map((item, index) => ({ ...item, sortOrder: index }));
    updateSteps(next); selectedKey.current = next[0]?.key ?? ''; setSelectedId(next[0]?.id ?? ''); scheduleSave(true);
  }
  function move(stepId: string, offset: -1 | 1) {
    const current = [...stepsRef.current]; const index = current.findIndex((step) => step.id === stepId); const target = index + offset;
    if (index < 0 || target < 0 || target >= current.length) return;
    const [item] = current.splice(index, 1); current.splice(target, 0, item!);
    updateSteps(current.map((step, sortOrder) => ({ ...step, sortOrder }))); scheduleSave(true);
  }
  function drop(targetId: string) {
    const sourceId = dragId.current; dragId.current = ''; if (!sourceId || sourceId === targetId) return;
    const current = [...stepsRef.current]; const from = current.findIndex((step) => step.id === sourceId); const to = current.findIndex((step) => step.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = current.splice(from, 1); current.splice(to, 0, item!);
    updateSteps(current.map((step, sortOrder) => ({ ...step, sortOrder }))); scheduleSave(true);
  }
  async function close() {
    if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) await inFlight.current;
    if (dirty.current) await persist();
    if (!dirty.current) onClose();
  }

  const selected = steps.find((step) => step.id === selectedId) ?? null;
  function setStartDateToToday() {
    if (!selected) return;
    const today = localToday();
    updateSteps(stepsRef.current.map((step) => step.id === selected.id ? { ...step, startDate: today, endDate: step.endDate && step.endDate < today ? null : step.endDate, status: deriveDateManagedNodeStatus(step.status, today, today) } : step)); scheduleSave();
  }
  function clearDates() {
    if (!selected) return;
    updateSteps(stepsRef.current.map((step) => step.id === selected.id ? { ...step, startDate: null, endDate: null, status: deriveDateManagedNodeStatus(step.status, null, localToday()) } : step)); scheduleSave();
  }
  function extendEndDate(amount: number, unit: DateIncrementUnit) {
    if (!selected || (!selected.endDate && !selected.startDate)) return;
    updateSteps(stepsRef.current.map((step) => { const baseDate = step.endDate || step.startDate; return step.id === selected.id && baseDate ? { ...step, endDate: addToDateOnly(baseDate, amount, unit), status: deriveDateManagedNodeStatus(step.status, step.startDate, localToday()) } : step; })); scheduleSave();
  }
  function insertTodayIntoSummary() {
    const input = summaryInput.current;
    if (!selected || !input || document.activeElement !== input) { toast.error('请先将光标放入简短说明'); return; }
    const start = input.selectionStart; const end = input.selectionEnd; const today = localToday();
    const summary = `${selected.summary.slice(0, start)}${today}${selected.summary.slice(end)}`;
    if (summary.length > 2000) { toast.error('插入后将超过简短说明的 2000 字限制'); return; }
    updateSteps(stepsRef.current.map((step) => step.id === selected.id ? { ...step, summary } : step)); scheduleSave();
    requestAnimationFrame(() => { input.focus(); const caret = start + today.length; input.setSelectionRange(caret, caret); });
  }
  return <Modal open={Boolean(node)} onOpenChange={(open) => { if (!open) void close(); }} title={readOnly ? '查看子阶段' : '管理子阶段'}
    description="子阶段是节点内部的一层有序步骤，不参与 DAG 连线。" wide>
    <div className="step-modal-toolbar"><span>{steps.length} 个子阶段</span><small className={`save-state ${saveState}`}>{saveState === 'saving' ? '保存中' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''}</small>
      {!readOnly && <button className="secondary-button" onClick={addStep}><Plus size={16} />添加子阶段</button>}</div>
    <div className="step-editor-layout">
      <div className="step-list">{steps.length === 0 ? <div className="empty-inline">尚未添加子阶段</div> : steps.map((step, index) => <div
        key={step.id} className={`step-list-row ${selectedId === step.id ? 'selected' : ''}`} draggable={!readOnly}
        onDragStart={() => { dragId.current = step.id; }} onDragOver={(event) => event.preventDefault()} onDrop={() => drop(step.id)}>
        <button className="step-select" onClick={() => { selectedKey.current = step.key; setSelectedId(step.id); }}><GripVertical size={15} /><span>{index + 1}</span><div><strong>{step.title}</strong><small>{nodeStatusLabels[step.status]}</small></div></button>
        {!readOnly && <div className="step-row-actions"><button className="mini-icon" title="上移" disabled={index === 0} onClick={() => move(step.id, -1)}><ArrowUp size={13} /></button><button className="mini-icon" title="下移" disabled={index === steps.length - 1} onClick={() => move(step.id, 1)}><ArrowDown size={13} /></button><button className="mini-icon danger" title="删除" onClick={() => removeStep(step)}><Trash2 size={13} /></button></div>}
      </div>)}</div>
      <div className="step-form">{selected ? <>
        <label>子阶段 key<code>{selected.key}</code></label>
        <label>名称<input value={selected.title} maxLength={200} disabled={readOnly} onChange={change('title')} /></label>
        <label>状态<select value={selected.status} disabled={readOnly} onChange={change('status')}>{Object.entries(nodeStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="date-fields"><label>开始日期<input type="date" value={selected.startDate ?? ''} disabled={readOnly} onChange={change('startDate')} /></label><label>结束日期<input type="date" value={selected.endDate ?? ''} disabled={readOnly} onChange={change('endDate')} /></label></div>
        {!readOnly && <div className="date-shortcuts"><div className="date-primary-shortcuts"><button className="secondary-button today-shortcut" onClick={setStartDateToToday}><CalendarDays size={16} />开始日期设为今天</button><button className="secondary-button clear-date-shortcut" disabled={!selected.startDate && !selected.endDate} onClick={clearDates}><CalendarX size={16} />清除</button></div><div className="duration-shortcuts">
          <button className="secondary-button" disabled={!selected.startDate && !selected.endDate} onClick={() => extendEndDate(1, 'day')}>+1天</button>
          <button className="secondary-button" disabled={!selected.startDate && !selected.endDate} onClick={() => extendEndDate(1, 'week')}>+一周</button>
          <button className="secondary-button" disabled={!selected.startDate && !selected.endDate} onClick={() => extendEndDate(1, 'month')}>+一个月</button>
          <button className="secondary-button" disabled={!selected.startDate && !selected.endDate} onClick={() => extendEndDate(3, 'month')}>+三个月</button>
        </div></div>}
        <div className="summary-field"><div className="field-label-row"><label htmlFor={`step-summary-${selected.id}`}>简短说明</label>{!readOnly && <button type="button" className="mini-icon" title="在光标处插入当前日期" aria-label="插入子阶段当前日期" onMouseDown={(event) => event.preventDefault()} onClick={insertTodayIntoSummary}><CalendarPlus size={15} /></button>}</div><textarea ref={summaryInput} id={`step-summary-${selected.id}`} rows={6} maxLength={2000} value={selected.summary} disabled={readOnly} onChange={change('summary')} /></div>
      </> : <div className="panel-empty"><p>选择一个子阶段查看详情</p></div>}</div>
    </div>
    <div className="dialog-actions"><button className="primary-button" onClick={() => void close()}>完成</button></div>
  </Modal>;
}
