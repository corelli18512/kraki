import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdDevices } from '../cli/devices.js';
import { writeTrustPolicy } from '../trust-store.js';

vi.mock('../cli/exit.js', () => ({ gracefulExit: (code: number) => { throw new Error(`exit:${code}`); } }));
let home: string;
let output: string;
const oldHome = process.env.KRAKI_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-account-cli-'));
  process.env.KRAKI_HOME = home;
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { output += String(chunk); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

it('lists the effective account-access policy even before startup migrates an old file', () => {
  writeTrustPolicy(join(home, 'trust'), { enforce: true });
  cmdDevices(['--json']);
  expect(JSON.parse(output)).toMatchObject({ ok: true, enforced: false, access: 'account' });
});

it('refuses the retired enforce-on command without writing a policy', () => {
  writeTrustPolicy(join(home, 'trust'), { enforce: false });
  const before = readFileSync(join(home, 'trust', 'policy.json'), 'utf8');
  expect(() => cmdDevices(['enforce', 'on', '--json'])).toThrow('exit:1');
  expect(JSON.parse(output)).toMatchObject({ ok: false });
  expect(readFileSync(join(home, 'trust', 'policy.json'), 'utf8')).toBe(before);
});

it('keeps enforce-off compatible with existing scripts', () => {
  writeTrustPolicy(join(home, 'trust'), { enforce: true });
  cmdDevices(['enforce', 'off', '--json']);
  // The policy writer also emits its structured audit log in this test host.
  const reply = output.trim().split('\n').map((line) => JSON.parse(line)).find((row) => row.ok !== undefined);
  expect(reply).toMatchObject({ ok: true, enforced: false });
  expect(JSON.parse(readFileSync(join(home, 'trust', 'policy.json'), 'utf8')).enforce).toBe(false);
});
