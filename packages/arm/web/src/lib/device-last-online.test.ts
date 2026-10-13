import { describe, expect, it } from 'vitest';
import { deviceLastOnline } from './device-last-online';

describe('deviceLastOnline (DevicesPane)', () => {
  const now = new Date(2026, 9, 13, 12);
  it('uses the local calendar for today and yesterday', () => {
    expect(deviceLastOnline(new Date(2026, 9, 13, 1).toISOString(), now)).toBe('today');
    expect(deviceLastOnline(new Date(2026, 9, 12, 23).toISOString(), now)).toBe('yesterday');
    expect(deviceLastOnline(new Date(2026, 8, 28, 12).toISOString(), now)).toBe('Sep 28');
  });
  it('accepts SQLite UTC and ISO timestamps, hiding absent or invalid values', () => {
    expect(deviceLastOnline('2026-09-28 12:00:00', now)).toBe(deviceLastOnline('2026-09-28T12:00:00Z', now));
    expect(deviceLastOnline(undefined, now)).toBeNull();
    expect(deviceLastOnline('', now)).toBeNull();
    expect(deviceLastOnline('invalid', now)).toBeNull();
  });
});
