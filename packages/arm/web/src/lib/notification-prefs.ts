const PREF_KEY = 'kraki:notifications.enabled';

/** Per-device preference; preserve legacy false opt-outs alongside current 0/1 writes. */
export function notificationsEnabled(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  const stored = storage.getItem(PREF_KEY);
  return stored !== '0' && stored !== 'false';
}
export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(PREF_KEY, enabled ? '1' : '0');
}
