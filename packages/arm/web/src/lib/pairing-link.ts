/**
 * What to do when the web app is opened from a pairing QR link
 * (`/?relay=…&token=…`).
 *
 * On iPhone the link is meant for the native app: iOS opens Kraki directly
 * when it is installed (universal link). Reaching Safari means the app is not
 * installed (or the user chose the browser), so we must NOT spend the
 * single-use token silently — offer the App Store, or pairing in the browser.
 * Android has no native app yet and keeps pairing the web client.
 *
 * A relay that is not Kraki's own must be confirmed: a crafted QR code could
 * otherwise sign this browser into a stranger's server.
 */

export const OFFICIAL_RELAY_HOST = /(^|\.)kraki\.chat$/i;

export function isOfficialRelay(relay: string): boolean {
  try {
    const url = new URL(relay);
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return false;
    // This machine's own relay (local development) needs no confirmation.
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return true;
    const configured = import.meta.env.VITE_WS_URL as string | undefined;
    if (configured) {
      try { if (new URL(configured).host === url.host) return true; } catch { /* ignore */ }
    }
    return OFFICIAL_RELAY_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

export function isIOSBrowser(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPod|iPad/i.test(userAgent)) return true;
  // iPadOS reports a Mac user agent; touch support gives it away.
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export type PairingLinkDecision =
  | { kind: 'none' }
  | { kind: 'proceed' }
  | { kind: 'offer-app' }
  | { kind: 'confirm-relay'; host: string };

export function decidePairingLink(
  search: string,
  userAgent: string,
  maxTouchPoints = 0,
): PairingLinkDecision {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  if (!token) return { kind: 'none' };
  const relay = params.get('relay');
  if (relay && !isOfficialRelay(relay) && params.get('confirmRelay') !== '1') {
    let host = relay;
    try { host = new URL(relay).host; } catch { /* show raw */ }
    return { kind: 'confirm-relay', host };
  }
  if (isIOSBrowser(userAgent, maxTouchPoints) && params.get('web') !== '1') return { kind: 'offer-app' };
  return { kind: 'proceed' };
}

function withParam(name: string, value: string): string {
  const params = new URLSearchParams(window.location.search);
  params.set(name, value);
  return `${window.location.pathname}?${params.toString()}`;
}

function strip(): string {
  return window.location.pathname;
}

const PAGE_STYLE = 'font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:24px;text-align:center;line-height:1.5;color:inherit';
const BUTTON = 'display:block;width:100%;margin:12px 0;padding:14px;border-radius:12px;border:0;font-size:17px;font-weight:600;cursor:pointer';

/** Render a blocking interstitial for the decision, before React mounts.
 *  Returns true when the app must not start yet. */
export function renderPairingInterstitial(decision: PairingLinkDecision, root: HTMLElement): boolean {
  if (decision.kind === 'none' || decision.kind === 'proceed') return false;
  const appStore = import.meta.env.VITE_IOS_APP_STORE_URL as string | undefined;
  if (decision.kind === 'confirm-relay') {
    root.innerHTML = `<div style="${PAGE_STYLE}">
      <h2>Connect to a self-hosted server?</h2>
      <p>This code asks to connect to <b></b>, which is not a Kraki server. Continue only if you set up this server yourself.</p>
      <button id="kraki-confirm" style="${BUTTON};background:#2384d4;color:#fff">Connect</button>
      <button id="kraki-cancel" style="${BUTTON};background:transparent;color:#888">Cancel</button>
    </div>`;
    root.querySelector('b')!.textContent = decision.host;
    root.querySelector('#kraki-confirm')!.addEventListener('click', () => window.location.replace(withParam('confirmRelay', '1')));
    root.querySelector('#kraki-cancel')!.addEventListener('click', () => window.location.replace(strip()));
    return true;
  }
  root.innerHTML = `<div style="${PAGE_STYLE}">
    <h2>Open in the Kraki app</h2>
    <p>${appStore
      ? 'Install Kraki for iPhone, then scan the code on your computer again.'
      : 'Kraki for iPhone is not available yet. You can connect in this browser instead.'}</p>
    ${appStore ? `<a id="kraki-store" href="" style="${BUTTON};background:#2384d4;color:#fff;text-decoration:none">Get Kraki for iPhone</a>` : ''}
    <button id="kraki-web" style="${BUTTON};background:${appStore ? 'transparent;color:#2384d4' : '#2384d4;color:#fff'}">Continue in browser</button>
  </div>`;
  const store = root.querySelector<HTMLAnchorElement>('#kraki-store');
  if (store && appStore) store.href = appStore;
  root.querySelector('#kraki-web')!.addEventListener('click', () => window.location.replace(withParam('web', '1')));
  return true;
}
