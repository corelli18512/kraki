import { create } from 'zustand';

export const useUsageShortcut = create<{ shortcut: string; enabled: boolean; recording: boolean }>(() => ({
  shortcut: localStorage.getItem('kraki:usage.shortcut') ?? 'F6',
  enabled: localStorage.getItem('kraki:usage.enabled') !== '0',
  recording: false,
}));

export function setUsageShortcut(shortcut: string, enabled: boolean) {
  localStorage.setItem('kraki:usage.shortcut', shortcut);
  localStorage.setItem('kraki:usage.enabled', enabled ? '1' : '0');
  useUsageShortcut.setState({ shortcut, enabled });
}

/** Electron accelerator spelling is shared with the optional global registration. */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Meta', 'Shift', 'Escape'].includes(e.key)) return null;
  if (!/^F([1-9]|1[0-9]|20)$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) return null;
  return [e.metaKey && 'Super', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key.length === 1 ? e.key.toUpperCase() : e.key].filter(Boolean).join('+');
}
export function matchesUsageShortcut(e: KeyboardEvent): boolean {
  const { shortcut, enabled, recording } = useUsageShortcut.getState();
  return enabled && !recording && shortcutFromEvent(e) === shortcut;
}
