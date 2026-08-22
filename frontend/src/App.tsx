import { useState, useEffect, useRef } from 'react';
import { Routes, Route } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { applyTheme } from './lib/theme';
import Layout from './components/Layout';
import LoadingScreen from './components/LoadingScreen';
import OnboardingStoryboard from './components/OnboardingStoryboard';
import ToastHost from './components/Toasts';
import { useRealtimeSync } from './hooks/useRealtimeSync';
import LoginPage from './pages/LoginPage';
import Dashboard from './pages/Dashboard';
import AuditLog from './pages/AuditLog';
import Policies from './pages/Policies';
import Agents from './pages/Agents';
import AgentDetail from './pages/AgentDetail';
import Firewall from './pages/Firewall';
import TestMCP from './pages/TestMCP';
import ConnectorDetailPage from './pages/ConnectorDetailPage';
import Settings from './pages/Settings';
import Profile from './pages/Profile';
import Marketplace from './pages/Marketplace';

function AppContent() {
  const [onboardingSeen, setOnboardingSeen] = useState(() => localStorage.getItem('cf_onboarding_seen') === 'true');
  const { user, loading: authLoading, signingOut } = useAuth();
  const wasAuthed = useRef(false);
  const hasSession = localStorage.getItem('cf_has_session') === 'true';

  // Single app-wide WS connection: backend state changes invalidate the
  // cache the moment they happen, so every surface updates without reload.
  useRealtimeSync();

  useEffect(() => {
    if (user) wasAuthed.current = true;
  }, [user]);

  // Apply the persisted theme override on startup (Settings > Theme).
  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => applyTheme(data?.settings?.theme || 'system'))
      .catch(() => {});
  }, []);

  if (user) {
    return (
      <>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="agents" element={<Agents />} />
            <Route path="agents/:type" element={<AgentDetail />} />
            <Route path="policies" element={<Policies />} />
            <Route path="firewall" element={<Firewall />} />
            <Route path="test-mcp" element={<TestMCP />} />
            <Route path="connectors/:name" element={<ConnectorDetailPage />} />
            <Route path="logs" element={<AuditLog />} />
            <Route path="settings" element={<Settings />} />
            <Route path="profile" element={<Profile />} />
            <Route path="marketplace" element={<Marketplace />} />
          </Route>
        </Routes>
        <ToastHost />
      </>
    );
  }

  if (signingOut) return null;

  if (authLoading) {
    if (hasSession || wasAuthed.current) return <LoadingScreen />;
    return null;
  }

  if (!onboardingSeen) {
    return <OnboardingStoryboard onComplete={() => { localStorage.setItem('cf_onboarding_seen', 'true'); setOnboardingSeen(true); }} />;
  }

  return <LoginPage />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
