// Localization first: bundled resources only (no relay client), so the
// pairing interstitial below is already in the user's language.
import './i18n';
import './index.css';
import { decidePairingLink, renderPairingInterstitial } from './lib/pairing-link';
import { renderDesktopAuthCallback } from './lib/desktop-auth-callback';

// Pairing QR opened in a browser: on iPhone offer the app first (don't spend
// the single-use token), and confirm any non-Kraki relay before connecting.
// This must run before the app's modules load: the relay client reads the
// token from the URL as soon as it is constructed. Keep this file's static
// imports free of the app (boot.tsx is loaded dynamically).
const rootElement = document.getElementById('root')!;

/** Same key as the relay client's stored device (lib/transport.ts STORAGE_KEY),
 *  read directly: this file must not import the app. */
function hasStoredDevice(): boolean {
  try { return !!localStorage.getItem('kraki_device'); } catch { return false; }
}

if (!renderDesktopAuthCallback(rootElement)) {
  const pairingDecision = decidePairingLink(window.location.search, navigator.userAgent, navigator.maxTouchPoints, hasStoredDevice());
  if (!renderPairingInterstitial(pairingDecision, rootElement)) {
    void import('./boot').then(({ boot }) => boot(rootElement));
  }
}
