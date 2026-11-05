import { t } from '../i18n';
/**
 * The first steps of the web page that must work even when the app itself
 * cannot load. Kept free of the app's modules (main.tsx imports this
 * statically, before the pairing-link gate decides).
 */

/** Set while the one automatic reload after a failed app load runs. */
export const BOOT_RELOAD_KEY = 'kraki.bootReload';

const PAGE_STYLE = 'font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:24px;text-align:center;line-height:1.5;color:inherit';
const BUTTON = 'display:block;width:100%;margin:12px 0;padding:14px;border-radius:12px;border:0;font-size:17px;font-weight:600;cursor:pointer;background:#2384d4;color:#fff';

interface BootLoaderEnv {
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload?: () => void;
}

/**
 * Load and start the app. After a deploy, an open or cached page may ask for
 * a chunk that no longer exists (K-091): reload once to pick up the current
 * page; if that fails too, say so and offer a reload instead of a blank page.
 */
export async function loadApp(
  importBoot: () => Promise<{ boot: (root: HTMLElement) => void }>,
  root: HTMLElement,
  env: BootLoaderEnv = {},
): Promise<void> {
  const storage = env.storage ?? safeSessionStorage();
  const reload = env.reload ?? (() => window.location.reload());
  let boot: (root: HTMLElement) => void;
  try {
    ({ boot } = await importBoot());
  } catch (err) {
    console.error('[Kraki] app failed to load', err);
    if (storage && storage.getItem(BOOT_RELOAD_KEY) === null) {
      storage.setItem(BOOT_RELOAD_KEY, '1');
      reload();
      return;
    }
    renderLoadFailure(root, reload);
    return;
  }
  storage?.removeItem(BOOT_RELOAD_KEY);
  boot(root);
}

function renderLoadFailure(root: HTMLElement, reload: () => void): void {
  root.innerHTML = `<div role="alert" style="${PAGE_STYLE}">
    <h2>${t('app:boot.failedTitle')}</h2>
    <p>${t('app:boot.failed')}</p>
    <button id="kraki-reload" style="${BUTTON}">${t('app:boot.reload')}</button>
  </div>`;
  root.querySelector('#kraki-reload')!.addEventListener('click', () => reload());
}

function safeSessionStorage(): Storage | undefined {
  try { return window.sessionStorage; } catch { return undefined; }
}

/** The wordmark font (JetBrains Mono 800). Added from script so the page never
 *  waits for fonts.googleapis.com, which can stall for 20-30 s (K-090);
 *  until it arrives the wordmark uses the monospace fallback. */
export const WORDMARK_FONT_URL = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@800&display=swap';

export function loadWordmarkFont(doc: Document = document): void {
  if (doc.querySelector(`link[href="${WORDMARK_FONT_URL}"]`)) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = WORDMARK_FONT_URL;
  doc.head.appendChild(link);
}
