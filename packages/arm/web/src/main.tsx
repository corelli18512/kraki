import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { App } from './App';
import { DashboardPage } from './pages/DashboardPage';
import { SessionPage } from './pages/SessionPage';
import { DevicesPage } from './pages/DevicesPage';
import { useTheme } from './hooks/useTheme';
import './index.css';

// Self-service channel switch: ?channel=beta or ?channel=stable
// Sets cookie and reloads before React mounts.
(function handleChannelParam() {
  const params = new URLSearchParams(window.location.search);
  const channel = params.get('channel');
  if (channel && /^[a-z]+$/.test(channel)) {
    document.cookie = `kraki_channel=${channel};path=/;max-age=${365 * 86400};SameSite=Lax`;
    params.delete('channel');
    const clean = params.toString();
    window.location.replace(window.location.pathname + (clean ? `?${clean}` : ''));
  }
})();

function Root() {
  useTheme();
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<DashboardPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="session" element={<Navigate to="/" replace />} />
          <Route path="session/:sessionId" element={<SessionPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
