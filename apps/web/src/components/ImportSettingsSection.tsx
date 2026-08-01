import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileJson } from 'lucide-react';
import { toast } from 'sonner';
import type { ImportSettingsDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';

interface ServerLimits {
  fileBytes: number; nodes: number; edges: number; markdownBytes: number; tempBytes: number; sessionHours: number;
}

const mb = 1024 * 1024;

export function ImportSettingsSection() {
  const query = useQuery({ queryKey: ['import-settings'], queryFn: () => api<{ settings: ImportSettingsDto; serverLimits: ServerLimits }>('/api/import-settings') });
  const [form, setForm] = useState({ maxNodes: 0, maxEdges: 0, maxMarkdownMb: 0, maxFileMb: 0, sessionHours: 24 });
  useEffect(() => { if (query.data) setForm({ maxNodes: query.data.settings.maxNodes, maxEdges: query.data.settings.maxEdges,
    maxMarkdownMb: query.data.settings.maxMarkdownBytes / mb, maxFileMb: query.data.settings.maxFileBytes / mb, sessionHours: query.data.settings.sessionHours }); }, [query.data]);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!query.data) return;
    try {
      await api('/api/import-settings', { method: 'PUT', body: JSON.stringify({ maxNodes: form.maxNodes, maxEdges: form.maxEdges,
        maxMarkdownBytes: Math.round(form.maxMarkdownMb * mb), maxFileBytes: Math.round(form.maxFileMb * mb),
        sessionHours: form.sessionHours, expectedVersion: query.data.settings.version }) });
      await query.refetch(); toast.success('计划导入限制已保存');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '保存失败'); }
  }
  const limits = query.data?.serverLimits;
  return <section className="settings-section"><div className="section-intro"><FileJson size={21} /><div><h2>计划导入限制</h2><p>限制 AI JSON 和计划文件的规模。填写 0 表示不设置个人限制，服务端硬上限仍然生效。</p></div></div>
    <form className="settings-form import-settings-grid" onSubmit={save}>
      <label>最大节点数<input type="number" min={0} max={limits?.nodes} value={form.maxNodes} onChange={(event) => setForm({ ...form, maxNodes: Number(event.target.value) })} /><small>服务端上限：{limits?.nodes.toLocaleString() ?? '-'}</small></label>
      <label>最大连接数<input type="number" min={0} max={limits?.edges} value={form.maxEdges} onChange={(event) => setForm({ ...form, maxEdges: Number(event.target.value) })} /><small>服务端上限：{limits?.edges.toLocaleString() ?? '-'}</small></label>
      <label>单节点 Markdown（MB）<input type="number" min={0} step="0.25" max={limits ? limits.markdownBytes / mb : undefined} value={form.maxMarkdownMb} onChange={(event) => setForm({ ...form, maxMarkdownMb: Number(event.target.value) })} /><small>服务端上限：{limits ? limits.markdownBytes / mb : '-'} MB</small></label>
      <label>单文件大小（MB）<input type="number" min={0} step="1" max={limits ? limits.fileBytes / mb : undefined} value={form.maxFileMb} onChange={(event) => setForm({ ...form, maxFileMb: Number(event.target.value) })} /><small>服务端上限：{limits ? limits.fileBytes / mb : '-'} MB</small></label>
      <label>临时会话时长（小时）<input type="number" min={1} max={limits?.sessionHours ?? 24} value={form.sessionHours} onChange={(event) => setForm({ ...form, sessionHours: Number(event.target.value) })} /><small>过期后自动清理上传文件</small></label>
      <button className="primary-button" disabled={!query.data}>保存导入限制</button>
    </form></section>;
}
