// Storage the browser refuses is replaced first: later modules read it while
// loading.
import './lib/storage-guard';
// Localization first: bundled resources only (no relay client), so the
// pairing interstitial below is already in the user's language.
import './i18n';
import './index.css';
import { CONFIRMED_RELAY_KEY, decidePairingLink, renderPairingInterstitial } from './lib/pairing-link';
import { renderDesktopAuthCallback } from './lib/desktop-auth-callback';
import { loadApp, loadWordmarkFont } from './lib/boot-loader';

loadWordmarkFont();

// Pairing QR opened in a browser: on iPhone offer the app first (don't spend
// the single-use token), and confirm any non-Kraki relay before connecting.
// This must run before the app's modules load: the relay client reads the
// token from the URL as soon as it is constructed. Keep this file's static
// imports free of the app (boot.tsx is loaded dynamically).
const rootElement = document.getElementById('root')!;

/** Same key as the relay client's stored device (lib/transport.ts STORAGE_KEY),
 *  read directly: this file must not import the app. */
function hasStoredDevice(): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem('kraki_device') ?? 'null') as { deviceId?: unknown } | null;
    return typeof stored?.deviceId === 'string' && stored.deviceId !== '';
  } catch { return false; }
}

function confirmedRelay(): string | null {
  try { return sessionStorage.getItem(CONFIRMED_RELAY_KEY); } catch { return null; }
}

if (!renderDesktopAuthCallback(rootElement)) {
  const pairingDecision = decidePairingLink(window.location.search, navigator.userAgent, navigator.maxTouchPoints, hasStoredDevice(), confirmedRelay());
  if (!renderPairingInterstitial(pairingDecision, rootElement)) {
    // The confirmation covers this one opening of the link.
    try { sessionStorage.removeItem(CONFIRMED_RELAY_KEY); } catch { /* ignore */ }
    void loadApp(() => import('./boot'), rootElement);
  }
}
