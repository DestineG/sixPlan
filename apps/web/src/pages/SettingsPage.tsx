import { useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackup, FolderOpen, HardDrive, KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { UserDto } from '@sixplan/shared';
import { api, ApiClientError, downloadFile, uploadBackup } from '../api';
import { useAuthStore } from '../auth-store';
import { ImportSettingsSection } from '../components/ImportSettingsSection';
import { DisplaySettingsSection } from '../components/DisplaySettingsSection';

function errorMessage(error: unknown) { return error instanceof ApiClientError ? error.message : '操作失败'; }

export function SettingsPage() {
  const user = useAuthStore((state) => state.user)!; const setUser = useAuthStore((state) => state.setUser); const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState(''); const [newPassword, setNewPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [backupPassword, setBackupPassword] = useState(''); const [restorePassword, setRestorePassword] = useState(''); const restoreFile = useRef<HTMLInputElement>(null);
  const [sitePassword, setSitePassword] = useState(''); const [siteRestorePassword, setSiteRestorePassword] = useState(''); const siteRestoreFile = useRef<HTMLInputElement>(null);
  const storage = useQuery({ queryKey: ['storage'], enabled: user.role === 'admin', queryFn: () => api<{ dataDir: string; databasePath: string; backupDir: string; exportDir: string }>('/api/admin/storage') });
  async function changePassword(event: FormEvent) { event.preventDefault(); if (newPassword !== confirm) return toast.error('两次输入的新密码不一致');
    try { await api('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) }); const result = await api<{ user: UserDto }>('/api/auth/me'); setUser(result.user); setCurrentPassword(''); setNewPassword(''); setConfirm(''); toast.success('密码已更新，其他会话已退出'); } catch (error) { toast.error(errorMessage(error)); }
  }
  async function restoreUser() { const file = restoreFile.current?.files?.[0]; if (!file) return toast.error('请选择备份文件'); if (!window.confirm('恢复将覆盖你当前的全部领域和计划，系统会先自动备份。是否继续？')) return;
    try { await uploadBackup('/api/backups/user/restore', file, restorePassword || undefined); toast.success('个人数据已恢复'); window.location.assign('/'); } catch (error) { toast.error(errorMessage(error)); }
  }
  async function restoreSite() { const file = siteRestoreFile.current?.files?.[0]; if (!file) return toast.error('请选择全站备份文件'); if (!window.confirm('全站恢复将覆盖全部账号、设置和计划，并使所有会话失效。是否继续？')) return;
    try { await uploadBackup('/api/admin/backups/restore', file, siteRestorePassword || undefined); setUser(null); navigate('/login'); toast.success('全站恢复完成，请重新登录'); } catch (error) { toast.error(errorMessage(error)); }
  }
  return <div className="settings-page page-container"><div className="page-heading"><div><p className="eyebrow">系统与数据</p><h1>设置</h1><p>管理显示偏好、账号安全、备份和本地数据目录。</p></div></div>
    <DisplaySettingsSection />
    <section className="settings-section"><div className="section-intro"><KeyRound size={21} /><div><h2>修改密码</h2><p>修改后，除当前页面外的登录会话会立即失效。</p></div></div><form className="settings-form" onSubmit={changePassword}><label>当前密码<input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required /></label><label>新密码<input type="password" minLength={8} maxLength={128} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required /></label><label>确认新密码<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label><button className="primary-button">保存密码</button></form></section>
    <section className="settings-section"><div className="section-intro"><DatabaseBackup size={21} /><div><h2>个人数据备份</h2><p>包含你的领域、普通与归档计划、节点、连接和 Markdown，不包含账号密码。</p></div></div><div className="settings-form"><label>备份密码（可选）<input type="password" minLength={backupPassword ? 8 : undefined} value={backupPassword} onChange={(e) => setBackupPassword(e.target.value)} /><small>留空生成未加密备份；系统不会保存此密码。</small></label><button className="secondary-button" onClick={() => downloadFile('/api/backups/user/export', backupPassword ? { password: backupPassword } : {}).catch((error) => toast.error(errorMessage(error)))}><DatabaseBackup size={17} />导出个人备份</button><div className="restore-row"><label>恢复文件<input ref={restoreFile} type="file" accept=".backup,.sixplan.backup" /></label><label>备份密码<input type="password" value={restorePassword} onChange={(e) => setRestorePassword(e.target.value)} /></label><button className="danger-ghost-button" onClick={restoreUser}><RotateCcw size={17} />恢复个人数据</button></div></div></section>
    <ImportSettingsSection />
    {user.role === 'admin' && <><section className="settings-section"><div className="section-intro"><ShieldCheck size={21} /><div><h2>全站备份</h2><p>包含账号哈希、系统设置和所有用户业务数据，不包含登录会话。</p></div></div><div className="settings-form"><label>备份密码（可选）<input type="password" value={sitePassword} onChange={(e) => setSitePassword(e.target.value)} /></label><button className="secondary-button" onClick={() => downloadFile('/api/admin/backups/export', sitePassword ? { password: sitePassword } : {}).catch((error) => toast.error(errorMessage(error)))}><DatabaseBackup size={17} />导出全站备份</button><div className="restore-row"><label>全站恢复文件<input ref={siteRestoreFile} type="file" accept=".backup,.sixplan.backup" /></label><label>备份密码<input type="password" value={siteRestorePassword} onChange={(e) => setSiteRestorePassword(e.target.value)} /></label><button className="danger-button" onClick={restoreSite}><RotateCcw size={17} />恢复全站</button></div></div></section>
      <section className="settings-section"><div className="section-intro"><HardDrive size={21} /><div><h2>服务端存储</h2><p>目录位于运行 sixPlan 服务的主机上。</p></div></div>{storage.data && <div className="path-list"><div><span>数据目录</span><code>{storage.data.dataDir}</code></div><div><span>数据库</span><code>{storage.data.databasePath}</code></div><div><span>恢复前备份</span><code>{storage.data.backupDir}</code></div><div><span>导出目录</span><code>{storage.data.exportDir}</code></div><button className="secondary-button" onClick={() => api('/api/admin/storage/open', { method: 'POST' }).then(() => toast.success('已在服务主机打开目录')).catch((error) => toast.error(errorMessage(error)))}><FolderOpen size={17} />在服务主机打开</button></div>}</section></>}
  </div>;
}
