import { create } from 'zustand';
import { isMacBrowser } from './macDownload';

/** Storage full or blocked must not break loading or the setting (K-201). */
function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* kept in memory for this page */ }
}

export const useUsageShortcut = create<{ shortcut: string; enabled: boolean; recording: boolean }>(() => ({
  shortcut: read('kraki:usage.shortcut') ?? 'F6',
  enabled: read('kraki:usage.enabled') === '1',
  recording: false,
}));

export function setUsageShortcut(shortcut: string, enabled: boolean) {
  write('kraki:usage.shortcut', shortcut);
  write('kraki:usage.enabled', enabled ? '1' : '0');
  useUsageShortcut.setState({ shortcut, enabled });
}

/** Electron accelerator spelling is shared with the optional global registration. */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Meta', 'Shift', 'Escape'].includes(e.key)) return null;
  if (!/^F([1-9]|1[0-9]|20)$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return [e.metaKey && 'Super', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
}
/** How a stored (Electron-spelled) shortcut reads to the user: in a Mac
 *  browser the Command key is "Cmd" (stored as "Super") and Alt is "Option". */
export function shortcutLabel(shortcut: string, mac = isMacBrowser()): string {
  if (!mac) return shortcut;
  return shortcut.split('+').map((part) => (part === 'Super' ? 'Cmd' : part === 'Alt' ? 'Option' : part)).join('+');
}

export function matchesUsageShortcut(e: KeyboardEvent): boolean {
  const { shortcut, enabled, recording } = useUsageShortcut.getState();
  return enabled && !recording && shortcutFromEvent(e) === shortcut;
}
