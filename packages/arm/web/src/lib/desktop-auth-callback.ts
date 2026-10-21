import { t } from '../i18n';

/**
 * Kraki for Mac / Windows sign-in: GitHub redirects to /auth/callback/desktop
 * (a sub-path of the registered /auth/callback) and we hand code+state to the
 * app through its kraki:// callback. The PKCE verifier lives only in the app,
 * so the code is useless to anyone else. Runs after localization but before
 * boot, so the relay client never starts on this page.
 */
export function renderDesktopAuthCallback(root: HTMLElement): boolean {
  if (!window.location.pathname.startsWith('/auth/callback/desktop')) return false;
  const target = 'kraki://auth/callback' + window.location.search;
  document.title = 'Kraki';
  const page = document.createElement('div');
  page.style.cssText = 'font:15px -apple-system,sans-serif;text-align:center;padding-top:22vh;color:inherit';
  const line = (tag: 'p' | 'a', text: string, css?: string) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (css) element.style.cssText = css;
    page.appendChild(element);
    return element;
  };
  line('p', t('app:desktopCallback.signedIn'), 'font-size:18px;font-weight:600');
  line('p', t('app:desktopCallback.return'));
  const link = line('a', t('app:desktopCallback.open')) as HTMLAnchorElement;
  link.href = target;
  root.replaceChildren(page);
  window.location.replace(target);
  return true;
}
