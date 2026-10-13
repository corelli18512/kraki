/** Per-device notification preference, independent of account-wide preferences. */
export function notificationsEnabled(): boolean {
  return localStorage.getItem('kraki:notifications.enabled') !== '0';
}
export function setNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem('kraki:notifications.enabled', enabled ? '1' : '0');
}
