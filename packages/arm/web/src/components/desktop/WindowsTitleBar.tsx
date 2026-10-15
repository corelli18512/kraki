import { useEffect } from 'react';
import { desktop, hasWindowsTitleBar } from '../../lib/desktop';
import './windows-titlebar.css';

/** Native caption space exists on every route, including setup and no session. */
export function WindowsTitleBar() {
  useEffect(() => {
    if (!hasWindowsTitleBar) return;
    const root = document.documentElement;
    root.dataset.windowsTitlebar = '';
    const syncTheme = () => desktop?.titleBarOverlay?.setTheme(root.classList.contains('dark') ? 'dark' : 'light');
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      delete root.dataset.windowsTitlebar;
    };
  }, []);

  return hasWindowsTitleBar ? <div className="kwindows-titlebar" aria-hidden="true" /> : null;
}
