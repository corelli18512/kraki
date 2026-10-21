// Localization first: bundled resources only (no relay client), so the
// pairing interstitial below is already in the user's language.
import './i18n';
import './index.css';
import { decidePairingLink, renderPairingInterstitial } from './lib/pairing-link';

// Pairing QR opened in a browser: on iPhone offer the app first (don't spend
// the single-use token), and confirm any non-Kraki relay before connecting.
// This must run before the app's modules load: the relay client reads the
// token from the URL as soon as it is constructed. Keep this file's static
// imports free of the app (boot.tsx is loaded dynamically).
const rootElement = document.getElementById('root')!;
const pairingDecision = decidePairingLink(window.location.search, navigator.userAgent, navigator.maxTouchPoints);
if (!renderPairingInterstitial(pairingDecision, rootElement)) {
  void import('./boot').then(({ boot }) => boot(rootElement));
}
