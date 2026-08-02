import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutList } from 'lucide-react';
import { toast } from 'sonner';
import type { DisplaySettingsDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';

export function DisplaySettingsSection() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['display-settings'],
    queryFn: () => api<{ settings: DisplaySettingsDto }>('/api/display-settings')
  });
  const [activeNodeLimit, setActiveNodeLimit] = useState(5);

  useEffect(() => {
    if (query.data) setActiveNodeLimit(query.data.settings.activeNodeLimit);
  }, [query.data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!query.data) return;
    try {
      const result = await api<{ settings: DisplaySettingsDto }>('/api/display-settings', {
        method: 'PUT',
        body: JSON.stringify({ activeNodeLimit, expectedVersion: query.data.settings.version })
      });
      queryClient.setQueryData(['display-settings'], result);
      toast.success('总览显示设置已保存');
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : '保存失败');
    }
  }

  return <section className="settings-section">
    <div className="section-intro"><LayoutList size={21} /><div><h2>总览显示</h2><p>设置活跃计划卡片默认展示的进行中节点数量，超出部分仍可在卡片内展开。</p></div></div>
    <form className="settings-form" onSubmit={save}>
      <label>每个计划显示的活跃节点数
        <select value={activeNodeLimit} onChange={(event) => setActiveNodeLimit(Number(event.target.value))}>
          {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => <option value={value} key={value}>{value} 个</option>)}
        </select>
      </label>
      <button className="primary-button" disabled={!query.data}>保存显示设置</button>
    </form>
  </section>;
}
