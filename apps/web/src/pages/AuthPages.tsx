import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, LogIn, UserPlus } from 'lucide-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { UserDto } from '@sixplan/shared';
import { api, ApiClientError } from '../api';
import { useAuthStore } from '../auth-store';
import { BrandMark } from '../components/BrandMark';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return <div className="auth-page"><section className="auth-panel">
    <div className="auth-brand"><BrandMark /><strong>sixPlan</strong></div>
    <div><h1>{title}</h1><p>{subtitle}</p></div>{children}
  </section></div>;
}

export function LoginPage() {
  const user = useAuthStore((state) => state.user);
  const ready = useAuthStore((state) => state.ready);
  const setUser = useAuthStore((state) => state.setUser);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  if (ready && user) return <Navigate to={user.mustChangePassword ? '/change-password' : '/'} replace />;
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<{ user: UserDto }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      setUser(result.user); navigate(result.user.mustChangePassword ? '/change-password' : '/');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '登录失败'); } finally { setBusy(false); }
  }
  return <AuthFrame title="欢迎回来" subtitle="登录后继续维护你的计划图">
    <form className="stack-form" onSubmit={submit}>
      <label>用户名<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
      <label>密码<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <button className="primary-button full-button" disabled={busy}><LogIn size={17} />{busy ? '正在登录' : '登录'}</button>
    </form><p className="auth-switch">还没有账号？<Link to="/register">创建账号</Link></p>
  </AuthFrame>;
}

export function RegisterPage() {
  const user = useAuthStore((state) => state.user); const ready = useAuthStore((state) => state.ready); const setUser = useAuthStore((state) => state.setUser);
  const [open, setOpen] = useState<boolean | null>(null); const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false); const navigate = useNavigate();
  useEffect(() => { api<{ open: boolean }>('/api/auth/registration').then((value) => setOpen(value.open)); }, []);
  if (ready && user) return <Navigate to="/" replace />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) return toast.error('两次输入的密码不一致');
    setBusy(true);
    try { const result = await api<{ user: UserDto }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
      setUser(result.user); navigate('/');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '注册失败'); } finally { setBusy(false); }
  }
  return <AuthFrame title="创建账号" subtitle="每个账号拥有完全独立的计划空间">
    {open === false ? <div className="notice warning">管理员当前已关闭新用户注册。</div> : <form className="stack-form" onSubmit={submit}>
      <label>用户名<input autoFocus autoComplete="username" minLength={3} maxLength={32} pattern="[A-Za-z0-9._-]+" value={username} onChange={(e) => setUsername(e.target.value)} required /><small>3–32 位英文、数字、点、下划线或连字符</small></label>
      <label>密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <label>确认密码<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
      <button className="primary-button full-button" disabled={busy || open !== true}><UserPlus size={17} />{busy ? '正在创建' : '创建账号'}</button>
    </form>}<p className="auth-switch">已有账号？<Link to="/login">返回登录</Link></p>
  </AuthFrame>;
}

export function ForcePasswordChangePage() {
  const setUser = useAuthStore((state) => state.setUser); const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState(''); const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (password !== confirm) return toast.error('两次输入的密码不一致'); setBusy(true);
    try { await api('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ newPassword: password }) });
      const { user } = await api<{ user: UserDto }>('/api/auth/me'); setUser(user); navigate('/'); toast.success('密码已更新');
    } catch (error) { toast.error(error instanceof ApiClientError ? error.message : '修改失败'); } finally { setBusy(false); }
  }
  return <AuthFrame title="设置新密码" subtitle="管理员已重置你的密码，继续前必须设置新密码">
    <form className="stack-form" onSubmit={submit}>
      <label>新密码<input autoFocus type="password" minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <label>确认新密码<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
      <button className="primary-button full-button" disabled={busy}><KeyRound size={17} />保存新密码</button>
    </form>
  </AuthFrame>;
}
