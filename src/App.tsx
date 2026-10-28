import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Role } from './data/types';
import { homeFor, useCurrentUser, useHasSession } from './store/auth';
import { useLoaded } from './store/store';
import { ConnectionBanner } from './components/ConnectionBanner';
import LoginPage from './pages/LoginPage';
import UserLayout from './pages/user/UserLayout';
import ChatPage from './pages/user/ChatPage';
import ProfilePage from './pages/user/ProfilePage';
import ConsolePage from './pages/console/ConsolePage';

function Loading() {
  return (
    <div className="app-loading" role="status">
      Carregando…
    </div>
  );
}

function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const user = useCurrentUser();
  const hasSession = useHasSession();
  const loaded = useLoaded();
  if (hasSession && !loaded) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user)} replace />;
  return children;
}

function HomeRedirect() {
  const user = useCurrentUser();
  const hasSession = useHasSession();
  const loaded = useLoaded();
  if (hasSession && !loaded) return <Loading />;
  return <Navigate to={user ? homeFor(user) : '/login'} replace />;
}

export default function App() {
  return (
    <>
      <ConnectionBanner />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireRole role="colaborador">
              <UserLayout />
            </RequireRole>
          }
        >
          <Route path="/atendimento" element={<ChatPage />} />
          <Route path="/perfil" element={<ProfilePage />} />
        </Route>
        <Route
          path="/console"
          element={
            <RequireRole role="analista">
              <ConsolePage />
            </RequireRole>
          }
        />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </>
  );
}
