import { beforeEach, describe, expect, it } from 'vitest';
import { notificationsEnabled, setNotificationsEnabled } from './notification-prefs';

const KEY = 'kraki:notifications.enabled';

describe('notification preference browser reader', () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [null, true],
    ['0', false],
    ['1', true],
    ['false', false],
    ['true', true],
    ['', true],
    ['unknown', true],
  ])('decodes stored %s as %s without rewriting it', (stored, enabled) => {
    if (stored !== null) localStorage.setItem(KEY, stored);
    expect(notificationsEnabled()).toBe(enabled);
    expect(localStorage.getItem(KEY)).toBe(stored);
  });

  it('persists current 0/1 encoding and reads it again without cached state', () => {
    setNotificationsEnabled(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(notificationsEnabled()).toBe(false);
    setNotificationsEnabled(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(notificationsEnabled()).toBe(true);
    localStorage.setItem(KEY, 'false');
    expect(notificationsEnabled()).toBe(false);
  });

  it.each(['0', 'false'])('reads injected storage %s instead of the ambient browser storage', (stored) => {
    localStorage.setItem(KEY, '1');
    const storage = { getItem: (key: string) => key === KEY ? stored : null };
    expect(notificationsEnabled(storage)).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('defaults on for empty injected storage even when ambient storage is off', () => {
    setNotificationsEnabled(false);
    expect(notificationsEnabled({ getItem: () => null })).toBe(true);
  });
});
