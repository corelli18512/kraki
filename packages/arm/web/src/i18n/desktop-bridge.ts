import { desktop } from '../lib/desktop';
import { currentLanguage, onLanguageChanged } from '.';

/** Keep the Windows shell (tray, dialogs, toasts) in the page's language. */
export function syncDesktopLanguage() {
  const send = desktop?.setLanguage;
  if (!send) return;
  send(currentLanguage());
  onLanguageChanged((lang) => send(lang));
}
