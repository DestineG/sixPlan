import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuthStore } from './auth-store';
import { AppShell } from './components/AppShell';
import { LoginPage, RegisterPage, ForcePasswordChangePage } from './pages/AuthPages';
import type { UserDto } from '@sixplan/shared';

const OverviewPage = lazy(() => import('./pages/OverviewPage').then((module) => ({ default: module.OverviewPage })));
const GraphPage = lazy(() => import('./pages/GraphPage').then((module) => ({ default: module.GraphPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((module) => ({ default: module.SettingsPage })));
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage').then((module) => ({ default: module.AdminUsersPage })));

function Protected({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { user, ready } = useAuthStore();
  const location = useLocation();
  if (!ready) return <div className="page-loader"><span className="spinner" />正在加载 sixPlan</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (user.mustChangePassword && location.pathname !== '/change-password') return <Navigate to="/change-password" replace />;
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return children;
}

export function App() {
  const { setUser, setReady } = useAuthStore();
  useEffect(() => {
    api<{ user: UserDto }>('/api/auth/me')
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [setReady, setUser]);

  return (
    <Suspense fallback={<div className="page-loader"><span className="spinner" />加载页面</div>}><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/change-password" element={<Protected><ForcePasswordChangePage /></Protected>} />
      <Route element={<Protected><AppShell /></Protected>}>
        <Route index element={<OverviewPage />} />
        <Route path="plans/:planId" element={<GraphPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin/users" element={<Protected admin><AdminUsersPage /></Protected>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
  );
}
