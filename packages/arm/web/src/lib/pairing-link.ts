import { t } from '../i18n';
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
    // Kraki's relays are only reached over TLS (as on iOS): a plain ws://
    // link naming them is not one of ours and is confirmed like any other.
    return url.protocol === 'wss:' && OFFICIAL_RELAY_HOST.test(url.hostname);
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

/** The relay the user confirmed with Connect, kept in this tab's
 *  sessionStorage: the link itself cannot carry the consent, or a crafted
 *  link would simply include it. */
export const CONFIRMED_RELAY_KEY = 'kraki.confirmedRelay';

/** `hasStoredDevice`: this browser is already signed in. A link without a
 *  token then cannot move it to another relay (the relay client keeps the
 *  stored one), so there is nothing to confirm. Without a sign-in, a
 *  token-less `?relay=` still points sign-in at that server and is confirmed.
 *  `confirmedRelay`: the relay the user confirmed in this tab
 *  (CONFIRMED_RELAY_KEY). */
export function decidePairingLink(
  search: string,
  userAgent: string,
  maxTouchPoints = 0,
  hasStoredDevice = false,
  confirmedRelay: string | null = null,
): PairingLinkDecision {
  const params = new URLSearchParams(search);
  const token = params.get('token');
  const relay = params.get('relay');
  if (!token && (!relay || hasStoredDevice)) return { kind: 'none' };
  if (relay && !isOfficialRelay(relay) && confirmedRelay !== relay) {
    let host = relay;
    try { host = new URL(relay).host; } catch { /* show raw */ }
    return { kind: 'confirm-relay', host };
  }
  if (!token) return { kind: 'none' };
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
      <h2>${t('app:pairing.confirmTitle')}</h2>
      <p>${t('app:pairing.confirmDetail')}</p>
      <button id="kraki-confirm" style="${BUTTON};background:#2384d4;color:#fff">${t('app:pairing.connect')}</button>
      <button id="kraki-cancel" style="${BUTTON};background:transparent;color:#888">${t('common:action.cancel')}</button>
    </div>`;
    root.querySelector('b')!.textContent = decision.host;
    root.querySelector('#kraki-confirm')!.addEventListener('click', () => {
      const relay = new URLSearchParams(window.location.search).get('relay');
      try {
        if (relay) window.sessionStorage.setItem(CONFIRMED_RELAY_KEY, relay);
      } catch { /* storage blocked: the page asks again */ }
      window.location.reload();
    });
    root.querySelector('#kraki-cancel')!.addEventListener('click', () => window.location.replace(strip()));
    return true;
  }
  root.innerHTML = `<div style="${PAGE_STYLE}">
    <h2>${t('app:pairing.appTitle')}</h2>
    <p>${appStore
      ? t('app:pairing.install')
      : t('app:pairing.unavailable')}</p>
    ${appStore ? `<a id="kraki-store" href="" style="${BUTTON};background:#2384d4;color:#fff;text-decoration:none">${t('app:pairing.getApp')}</a>` : ''}
    <button id="kraki-web" style="${BUTTON};background:${appStore ? 'transparent;color:#2384d4' : '#2384d4;color:#fff'}">${t('app:pairing.browser')}</button>
  </div>`;
  const store = root.querySelector<HTMLAnchorElement>('#kraki-store');
  if (store && appStore) store.href = appStore;
  root.querySelector('#kraki-web')!.addEventListener('click', () => window.location.replace(withParam('web', '1')));
  // The App Store opens only from the tap on "Get Kraki for iPhone". Opening it
  // by itself during page load (no user gesture) made the browser replace this
  // page in history, so Back could not return to "Continue in browser"; and
  // the once-per-code guard lived in per-tab storage (K-241).
  return true;
}
