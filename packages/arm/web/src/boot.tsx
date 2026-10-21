/**
 * The web app proper. Loaded by main.tsx only after the pairing-link gate:
 * importing it constructs the relay client, which reads (and strips) a
 * pairing token from the URL, so nothing here may load while the gate is
 * still deciding (offer the iPhone app / confirm a foreign relay).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { App } from './App';
import { DashboardPage } from './pages/DashboardPage';
import { SessionPage } from './pages/SessionPage';
import { DevicesPage } from './pages/DevicesPage';
import { useTheme } from './hooks/useTheme';
import { trackVisualViewport } from './lib/visual-viewport';
import { desktop } from './lib/desktop';
import { syncDesktopLanguage } from './i18n/desktop-bridge';
import { desktopBuildNumber, desktopDiagHttp, diag } from './lib/diag';

trackVisualViewport();
syncDesktopLanguage();
// Performance data (Settings › Share Performance Data): Windows shell only.
diag.start(desktopDiagHttp(), { version: desktop?.version ?? '0', build: desktopBuildNumber() });

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

export function boot(rootElement: HTMLElement): void {
  createRoot(rootElement).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
