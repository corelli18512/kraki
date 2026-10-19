import './i18n';
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
import './index.css';
import { decidePairingLink, renderPairingInterstitial } from './lib/pairing-link';

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

const rootElement = document.getElementById('root')!;
// Pairing QR opened in a browser: on iPhone offer the app first (don't spend
// the single-use token), and confirm any non-Kraki relay before connecting.
const pairingDecision = decidePairingLink(window.location.search, navigator.userAgent, navigator.maxTouchPoints);
if (!renderPairingInterstitial(pairingDecision, rootElement)) {
  createRoot(rootElement).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
