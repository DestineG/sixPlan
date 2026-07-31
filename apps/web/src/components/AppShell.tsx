import { Archive, CalendarRange, LogOut, Settings, ShieldCheck } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../auth-store';

export function AppShell() {
  const user = useAuthStore((state) => state.user)!;
  const setUser = useAuthStore((state) => state.setUser);
  const navigate = useNavigate();
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
    navigate('/login');
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/" aria-label="sixPlan 计划总览">
          <span className="brand-mark"><CalendarRange size={19} /></span>
          <span>sixPlan</span>
        </Link>
        <nav className="topnav" aria-label="主导航">
          <NavLink to="/"><Archive size={17} />计划</NavLink>
          <NavLink to="/settings"><Settings size={17} />设置</NavLink>
          {user.role === 'admin' && <NavLink to="/admin/users"><ShieldCheck size={17} />管理</NavLink>}
        </nav>
        <div className="account-summary">
          <span className="account-avatar">{user.username.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{user.username}</span>
          <button className="icon-button" type="button" title="退出登录" aria-label="退出登录" onClick={logout}><LogOut size={17} /></button>
        </div>
      </header>
      <main className="app-main"><Outlet /></main>
    </div>
  );
}
