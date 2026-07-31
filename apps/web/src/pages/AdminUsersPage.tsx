import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, ShieldCheck, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import type { UserDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';
import { useAuthStore } from '../auth-store';
import { Modal } from '../components/Dialogs';

export function AdminUsersPage() {
  const current = useAuthStore((state) => state.user)!; const client = useQueryClient(); const [resetUser, setResetUser] = useState<UserDto | null>(null);
  const usersQuery = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ users: UserDto[] }>('/api/admin/users') });
  const settingsQuery = useQuery({ queryKey: ['admin-settings'], queryFn: () => api<{ registrationOpen: boolean; version: number }>('/api/admin/settings') });
  async function refresh() { await Promise.all([client.invalidateQueries({ queryKey: ['admin-users'] }), client.invalidateQueries({ queryKey: ['admin-settings'] })]); }
  function report(error: unknown) { toast.error(error instanceof ApiClientError ? error.message : '操作失败'); }
  async function toggleUser(user: UserDto) { try { await api(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify({ disabled: !user.isDisabled, expectedVersion: user.version }) }); await refresh(); toast.success(user.isDisabled ? '账号已启用' : '账号已禁用'); } catch (error) { report(error); } }
  async function toggleRegistration() { const setting = settingsQuery.data; if (!setting) return; try { await api('/api/admin/settings/registration', { method: 'PATCH', body: JSON.stringify({ open: !setting.registrationOpen, expectedVersion: setting.version }) }); await refresh(); toast.success(setting.registrationOpen ? '已关闭新用户注册' : '已开放新用户注册'); } catch (error) { report(error); } }
  return <div className="admin-page page-container"><div className="page-heading"><div><p className="eyebrow">管理员</p><h1>用户管理</h1><p>管理账号可用性和注册入口，不访问用户计划内容。</p></div><label className="toggle-control"><input type="checkbox" checked={settingsQuery.data?.registrationOpen ?? false} onChange={toggleRegistration} /><span />开放新用户注册</label></div>
    <div className="table-wrap"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{usersQuery.data?.users.map((user) => <tr key={user.id}><td><div className="user-cell"><span className="account-avatar">{user.username[0]?.toUpperCase()}</span><strong>{user.username}</strong>{user.id === current.id && <small>当前账号</small>}</div></td><td>{user.role === 'admin' ? <span className="role-badge"><ShieldCheck size={14} />管理员</span> : '普通用户'}</td><td><span className={user.isDisabled ? 'account-disabled' : 'account-active'}>{user.isDisabled ? '已禁用' : user.mustChangePassword ? '等待改密' : '正常'}</span></td><td>{new Date(user.createdAt).toLocaleString('zh-CN')}</td><td><div className="table-actions"><button className="secondary-button compact" onClick={() => setResetUser(user)}><KeyRound size={15} />重置密码</button><button className={user.isDisabled ? 'secondary-button compact' : 'danger-ghost-button compact'} disabled={user.id === current.id} onClick={() => toggleUser(user)}>{user.isDisabled ? <UserCheck size={15} /> : <UserX size={15} />}{user.isDisabled ? '启用' : '禁用'}</button></div></td></tr>)}</tbody></table></div>
    <ResetPasswordModal user={resetUser} onClose={() => setResetUser(null)} onSaved={refresh} />
  </div>;
}

function ResetPasswordModal({ user, onClose, onSaved }: { user: UserDto | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  async function submit(event: FormEvent) { event.preventDefault(); if (!user) return; try { await api(`/api/admin/users/${user.id}/reset-password`, { method: 'POST', body: JSON.stringify({ password, expectedVersion: user.version }) }); await onSaved(); setPassword(''); onClose(); toast.success('临时密码已设置，用户下次登录必须改密'); } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '重置失败'); } }
  return <Modal open={Boolean(user)} onOpenChange={(open) => !open && onClose()} title={`重置 ${user?.username ?? ''} 的密码`} description="设置后该用户的所有会话立即失效。"><form className="stack-form" onSubmit={submit}><label>临时密码<input autoFocus type="password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required /></label><div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button"><KeyRound size={16} />设置临时密码</button></div></form></Modal>;
}
