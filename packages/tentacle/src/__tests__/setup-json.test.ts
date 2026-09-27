import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSetupJsonWith, type SetupJsonDeps, type SetupJsonEvent } from '../setup-json.js';

let home: string;
let prevHome: string | undefined;
let prevRelay: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'kraki-setup-json-'));
  prevHome = process.env.KRAKI_HOME;
  prevRelay = process.env.KRAKI_RELAY_URL;
  process.env.KRAKI_HOME = home;
  delete process.env.KRAKI_RELAY_URL;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.KRAKI_HOME; else process.env.KRAKI_HOME = prevHome;
  if (prevRelay === undefined) delete process.env.KRAKI_RELAY_URL; else process.env.KRAKI_RELAY_URL = prevRelay;
  rmSync(home, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeDeps(routes: Record<string, (init?: RequestInit) => Response>, overrides: Partial<SetupJsonDeps> = {}) {
  const events: SetupJsonEvent[] = [];
  const deps: SetupJsonDeps = {
    emit: (e) => events.push(e),
    fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const handler = routes[url];
      if (!handler) throw new Error(`unexpected fetch ${url}`);
      return handler(init);
    }) as unknown as typeof fetch,
    ghAuthToken: () => null,
    sleep: async () => {},
    queryRelayInfo: async () => ({ githubClientId: 'relay-client' }),
    resolveRelay: async () => ({ ok: true, relayUrl: 'wss://us.relay.test', region: 'us' }),
    apiBase: 'https://api.test',
    officialRelay: 'wss://relay.test',
    ...overrides,
  };
  return { deps, events };
}

describe('kraki setup --json', () => {
  it('runs the GitHub device flow, resolves the relay and writes config last', async () => {
    let polls = 0;
    const { deps, events } = makeDeps({
      'https://api.test/api/config': () => json({ githubClientId: 'cid' }),
      'https://github.com/login/device/code': (init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({ client_id: 'cid' });
        return json({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
      },
      'https://github.com/login/oauth/access_token': () => {
        polls++;
        return polls < 2 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_new' });
      },
      'https://api.github.com/user': () => json({ login: 'octocat' }),
    });

    const code = await runSetupJsonWith(['--device-name', 'Studio'], deps);

    expect(code).toBe(0);
    expect(events.map((e) => e.event)).toEqual(['start', 'device_code', 'authenticated', 'relay', 'done']);
    expect(events[1]).toMatchObject({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    expect(events[2]).toMatchObject({ username: 'octocat', source: 'device_flow' });
    expect(events[3]).toMatchObject({ relay: 'wss://us.relay.test', region: 'us', fallback: false });
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config).toMatchObject({ relay: 'wss://us.relay.test', authMethod: 'github_token', device: { name: 'Studio' } });
    expect(readFileSync(join(home, 'github-token'), 'utf8').trim()).toBe('gho_new');
  });

  it('reuses a valid gh token without a device flow and without copying it', async () => {
    const { deps, events } = makeDeps({
      'https://api.github.com/user': () => json({ login: 'octocat' }),
    }, { ghAuthToken: () => 'gho_from_gh' });

    expect(await runSetupJsonWith([], deps)).toBe(0);
    expect(events.find((e) => e.event === 'authenticated')).toMatchObject({ source: 'gh' });
    expect(events.some((e) => e.event === 'device_code')).toBe(false);
    expect(existsSync(join(home, 'github-token'))).toBe(false);
  });

  it('falls through a revoked saved token to the device flow', async () => {
    writeFileSync(join(home, 'github-token'), 'gho_revoked\n');
    const { deps, events } = makeDeps({
      'https://api.test/api/config': () => json({ githubClientId: 'cid' }),
      'https://github.com/login/device/code': () => json({ device_code: 'dc', user_code: 'X', verification_uri: 'u', expires_in: 900 }),
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_new' }),
      'https://api.github.com/user': (init) => {
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth.endsWith('gho_revoked') ? json({ message: 'Bad credentials' }, 401) : json({ login: 'octocat' });
      },
    });

    expect(await runSetupJsonWith([], deps)).toBe(0);
    expect(events.find((e) => e.event === 'authenticated')).toMatchObject({ source: 'device_flow' });
  });

  it('reports a denied sign-in as an error event and writes nothing', async () => {
    const { deps, events } = makeDeps({
      'https://api.test/api/config': () => json({ githubClientId: 'cid' }),
      'https://github.com/login/device/code': () => json({ device_code: 'dc', user_code: 'X', verification_uri: 'u', expires_in: 900 }),
      'https://github.com/login/oauth/access_token': () => json({ error: 'access_denied' }),
    });

    expect(await runSetupJsonWith([], deps)).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: 'error', code: 'denied' });
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('fails with relay_unreachable before writing config', async () => {
    const { deps, events } = makeDeps({
      'https://api.github.com/user': () => json({ login: 'octocat' }),
    }, {
      ghAuthToken: () => 'gho_from_gh',
      queryRelayInfo: async () => { throw new Error('ECONNREFUSED'); },
    });

    expect(await runSetupJsonWith([], deps)).toBe(1);
    expect(events.at(-1)).toMatchObject({ event: 'error', code: 'relay_unreachable' });
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('keeps an existing device name and agent pinning on re-setup', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      relay: 'wss://old', authMethod: 'github_token', device: { name: 'Old Name', id: 'dev_keep' }, agents: ['claude'],
    }));
    writeFileSync(join(home, 'device-id'), 'dev_keep');
    const { deps } = makeDeps({
      'https://api.github.com/user': () => json({ login: 'octocat' }),
    }, { ghAuthToken: () => 'gho_from_gh' });

    expect(await runSetupJsonWith([], deps)).toBe(0);
    const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(config.device.name).toBe('Old Name');
    expect(config.agents).toEqual(['claude']);
    expect(config.relay).toBe('wss://us.relay.test');
  });
});
