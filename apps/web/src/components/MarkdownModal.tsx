import { useEffect, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { Check, Save, X } from 'lucide-react';
import { toast } from 'sonner';
import type { NodeDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';

export function MarkdownModal({ node, onClose, onSaved, readOnly }: { node: NodeDto; onClose: () => void; onSaved: (node: NodeDto) => void; readOnly: boolean }) {
  const [value, setValue] = useState(node.extraContent); const [saved, setSaved] = useState(node.extraContent); const [busy, setBusy] = useState(false); const [split, setSplit] = useState(50);
  const dragging = useRef(false); const container = useRef<HTMLDivElement>(null); const dirty = value !== saved;
  useEffect(() => {
    function move(event: PointerEvent) { if (!dragging.current || !container.current) return; const box = container.current.getBoundingClientRect(); setSplit(Math.min(75, Math.max(25, ((event.clientX - box.left) / box.width) * 100))); }
    function up() { dragging.current = false; }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);
  useEffect(() => {
    function key(event: KeyboardEvent) { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (!readOnly) void save(); } if (event.key === 'Escape') attemptClose(); }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  function attemptClose() { if (dirty && !window.confirm('附加信息还有未保存修改，确定关闭吗？')) return; onClose(); }
  async function save() { if (!dirty || busy) return; setBusy(true); try { const result = await api<{ node: NodeDto }>(`/api/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify({ extraContent: value, expectedVersion: node.version }) }); setSaved(value); onSaved(result.node); toast.success('附加信息已保存'); } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '保存失败'); } finally { setBusy(false); } }
  return <div className="markdown-modal" role="dialog" aria-modal="true" aria-label={`${node.title} 附加信息`}>
    <header><div><strong>{node.title}</strong><span>附加信息</span></div><button className="icon-button inverse" aria-label="关闭" onClick={attemptClose}><X size={19} /></button></header>
    <div ref={container} className="markdown-split">
      <section className="markdown-editor" style={{ width: readOnly ? '0%' : `${split}%`, display: readOnly ? 'none' : 'block' }}><CodeMirror value={value} height="100%" extensions={[markdown()]} onChange={setValue} basicSetup={{ lineNumbers: true, foldGutter: true }} /></section>
      {!readOnly && <button className="split-handle" aria-label="调整编辑和预览宽度" onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); }} />}
      <section className="markdown-preview" style={{ width: readOnly ? '100%' : `${100 - split}%` }}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{value || '*暂无附加信息*'}</ReactMarkdown></section>
    </div>
    <footer><span className={dirty ? 'save-dirty' : 'save-clean'}>{dirty ? '有未保存修改' : <><Check size={14} />已保存</>}</span><div>{!readOnly && <button className="secondary-button inverse-secondary" onClick={attemptClose}>取消</button>}<button className="primary-button" disabled={readOnly ? false : !dirty || busy} onClick={readOnly ? attemptClose : save}>{readOnly ? '关闭' : <><Save size={16} />{busy ? '保存中' : '保存'}</>}</button></div></footer>
  </div>;
}
