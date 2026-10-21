/** App debug logs (client_log) reach web-client.log, and an app message type
 *  this tentacle doesn't know is reported at warn, not only at debug.
 *  Regression: Tentacle 0.38.8 put the schema check in front of every
 *  handler, client_log was missing from it, and every web/desktop app log
 *  batch was dropped at debug level for a week (log audit 2026-10-22). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../logger.js', () => ({ createLogger: vi.fn(() => log) }));

import { handleConsumerMessage } from '../relay/consumer-messages.js';
import type { RelayClient } from '../relay-client.js';

function fakeClient(): RelayClient {
  return {
    consumerKeys: new Map(),
    isAppOnline: () => true,
    unknownAppMessageWarned: new Set<string>(),
  } as unknown as RelayClient;
}

let home: string;
const savedHome = process.env.KRAKI_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-client-log-'));
  mkdirSync(join(home, 'logs'), { recursive: true });
  process.env.KRAKI_HOME = home;
  for (const fn of Object.values(log)) fn.mockClear();
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KRAKI_HOME;
  else process.env.KRAKI_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('client_log', () => {
  it('writes a web app log batch (as web lib/logger.ts + sendBroadcast send it) to web-client.log', () => {
    handleConsumerMessage(fakeClient(), {
      type: 'client_log',
      deviceId: 'dev_app1',
      payload: {
        entries: [{ ts: '2026-10-14T06:23:07.059Z', level: 'info', scope: 'ws-client', message: 'delivered {"n":3}' }],
        targetDeviceId: 'dev_tentacle1',
      },
    });
    const file = join(home, 'logs', 'web-client.log');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('2026-10-14T06:23:07.059Z [dev_app1] [info:ws-client] delivered {"n":3}\n');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('still writes entries with odd field types (the handler stringifies them)', () => {
    handleConsumerMessage(fakeClient(), {
      type: 'client_log', deviceId: 'dev_app1',
      payload: { entries: [{ ts: 1, level: 'warn', scope: 'x', message: { a: 1 } }] },
    });
    expect(readFileSync(join(home, 'logs', 'web-client.log'), 'utf8')).toContain('[warn:x]');
  });
});

describe('unknown app message types', () => {
  it('warns once per (type, app), then logs at debug', () => {
    const client = fakeClient();
    const msg = { type: 'brand_new_feature', deviceId: 'dev_app1', payload: {} };
    handleConsumerMessage(client, msg);
    handleConsumerMessage(client, msg);
    handleConsumerMessage(client, { ...msg, deviceId: 'dev_app2' });
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0][0]).toEqual({ type: 'brand_new_feature', deviceId: 'dev_app1' });
    expect(log.debug).toHaveBeenCalledTimes(1);
  });
});
