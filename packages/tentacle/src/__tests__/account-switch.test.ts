import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { adoptAccountDataOwner, loadAccountDataOwner, switchAccountData } from '../account-switch.js';
import { getOrCreateDeviceId } from '../config.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-account-switch-'));
  prevHome = process.env.KRAKI_HOME;
  process.env.KRAKI_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function seedAccount(deviceId: string, sessionId: string): void {
  writeFileSync(join(home, 'device-id'), deviceId);
  mkdirSync(join(home, 'keys'), { recursive: true });
  writeFileSync(join(home, 'keys', 'public-identity.json'), `{"for":"${deviceId}"}`);
  mkdirSync(join(home, 'trust'), { recursive: true });
  mkdirSync(join(home, 'sessions', sessionId), { recursive: true });
  writeFileSync(join(home, 'sessions', sessionId, 'meta.json'), '{}');
}

describe('K-028 account switch', () => {
  it('adopts the signed-in account when nobody owns the data yet', () => {
    seedAccount('dev_accountA', 'sess_a');
    expect(switchAccountData('alice')).toEqual({ switched: false });
    expect(loadAccountDataOwner()).toBe('alice');
    expect(getOrCreateDeviceId()).toBe('dev_accountA');
  });

  it('keeps everything for the same account (logins are case-insensitive)', () => {
    seedAccount('dev_accountA', 'sess_a');
    adoptAccountDataOwner('Alice');
    expect(switchAccountData('alice')).toEqual({ switched: false });
    expect(getOrCreateDeviceId()).toBe('dev_accountA');
    expect(existsSync(join(home, 'sessions', 'sess_a'))).toBe(true);
  });

  it('moves the previous account\'s device and sessions aside so the new account gets a new device and none of them', () => {
    seedAccount('dev_accountA', 'sess_a');
    writeFileSync(join(home, 'github-token'), 'gho_bob');
    adoptAccountDataOwner('alice');

    expect(switchAccountData('bob')).toEqual({ switched: true, from: 'alice', to: 'bob', restored: false });

    expect(getOrCreateDeviceId()).not.toBe('dev_accountA');
    expect(existsSync(join(home, 'keys'))).toBe(false);
    expect(existsSync(join(home, 'sessions', 'sess_a'))).toBe(false);
    // Nothing is deleted, and the new sign-in stays.
    expect(readFileSync(join(home, 'accounts', 'alice', 'device-id'), 'utf8')).toBe('dev_accountA');
    expect(existsSync(join(home, 'accounts', 'alice', 'sessions', 'sess_a', 'meta.json'))).toBe(true);
    expect(readFileSync(join(home, 'github-token'), 'utf8')).toBe('gho_bob');
    expect(loadAccountDataOwner()).toBe('bob');
  });

  it('restores the previous account\'s device and sessions when it signs in again', () => {
    seedAccount('dev_accountA', 'sess_a');
    adoptAccountDataOwner('alice');
    switchAccountData('bob');
    const bobDevice = getOrCreateDeviceId();

    expect(switchAccountData('alice')).toEqual({ switched: true, from: 'bob', to: 'alice', restored: true });
    expect(getOrCreateDeviceId()).toBe('dev_accountA');
    expect(existsSync(join(home, 'sessions', 'sess_a', 'meta.json'))).toBe(true);
    expect(existsSync(join(home, 'accounts', 'alice'))).toBe(false);
    expect(readFileSync(join(home, 'accounts', 'bob', 'device-id'), 'utf8')).toBe(bobDevice);
  });

  it('never overrides a recorded owner by adoption', () => {
    adoptAccountDataOwner('alice');
    adoptAccountDataOwner('bob');
    expect(loadAccountDataOwner()).toBe('alice');
  });
});
