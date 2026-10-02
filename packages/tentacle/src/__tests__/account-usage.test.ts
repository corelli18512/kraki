import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountUsageMonitor, UsageAuthError, UsageClient, UsageHistory, discoverCredentials, hash, maskEmail,
  parseClaudeUsage, parseCodexAppServer, parseCodexUsage, retryAt, type FetchLike,
} from '../account-usage.js';

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'kraki-usage-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

function paths(root: string) {
  return { piAuth: join(root, 'pi', 'auth.json'), codexHome: join(root, 'codex'), claudeCredentials: join(root, 'claude', '.credentials.json') };
}

describe('discoverCredentials', () => {
  it('reads Pi OAuth (ignoring API keys), Codex auth.json and Claude Code credentials', () => {
    const root = tmp(), p = paths(root);
    mkdirSync(join(root, 'pi')); mkdirSync(p.codexHome); mkdirSync(join(root, 'claude'));
    writeFileSync(p.piAuth, JSON.stringify({
      anthropic: { type: 'oauth', access: 'pi-claude', expires: 9e12 },
      'openai-codex': { type: 'oauth', access: jwt({ email: 'a@b.com' }), accountId: 'acct-pi' },
      openai: { type: 'api_key', key: 'sk-ignored' },
    }));
    writeFileSync(join(p.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt({ exp: 2e9 }), account_id: 'acct-cli', id_token: jwt({ email: 'c@d.com' }) } }));
    writeFileSync(p.claudeCredentials, JSON.stringify({ claudeAiOauth: { accessToken: 'cc-token', expiresAt: 9e12 } }));
    const creds = discoverCredentials(p);
    expect(creds.map(c => `${c.sourceId}/${c.provider}`)).toEqual(['pi:claude/claude', 'pi:codex/codex', 'codex/codex', 'claude-code/claude']);
    expect(creds[1]).toMatchObject({ accountId: 'acct-pi', email: 'a@b.com' });
    expect(creds[2]).toMatchObject({ accountId: 'acct-cli', email: 'c@d.com', codexHome: p.codexHome, expiresAt: 2e12 });
  });

  it('a Codex home without auth.json is answered by its own app-server; nothing found means nothing', () => {
    const root = tmp(), p = paths(root);
    expect(discoverCredentials(p)).toEqual([]);
    mkdirSync(p.codexHome);
    expect(discoverCredentials(p)).toEqual([{ sourceId: 'codex', provider: 'codex', codexHome: p.codexHome }]);
  });
});

describe('parsers', () => {
  it('Claude: five-hour and weekly, zero stays a number, missing windows are omitted', () => {
    const parsed = parseClaudeUsage({
      five_hour: { utilization: 0, resets_at: '2026-09-28T19:10:00.17+00:00' },
      seven_day: { utilization: 59 }, seven_day_opus: null, seven_day_sonnet: { utilization: true },
    });
    expect(parsed.windows).toEqual([
      { id: 'five_hour', kind: 'five_hour', remainingPercent: 100, resetsAt: '2026-09-28T19:10:00.170Z', durationSeconds: 18000 },
      { id: 'seven_day', kind: 'weekly', remainingPercent: 41, durationSeconds: 604800 },
    ]);
    expect(() => parseClaudeUsage({ five_hour: null })).toThrow();
  });

  it('Codex: a weekly primary window is weekly, not five-hour', () => {
    const parsed = parseCodexUsage({ plan_type: 'prolite', rate_limit: {
      primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1791109013 }, secondary_window: null } });
    expect(parsed).toEqual({ plan: 'prolite', windows: [
      { id: 'primary_window', kind: 'weekly', remainingPercent: 0, resetsAt: new Date(1791109013000).toISOString(), durationSeconds: 604800 }] });
  });

  it('Codex app-server: identity required, API-key homes rejected, extra limits labeled', () => {
    const account = { account: { type: 'chatgpt', email: 'x@y.com', planType: 'prolite' }, workspaceRouting: { chatgptAccountId: 'acct-1' } };
    const limits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300 }, planType: 'plus' },
      rateLimitsByLimitId: { codex: {}, spark: { limitName: 'Spark', primary: { usedPercent: 10, windowDurationMins: 10080 } } } };
    const parsed = parseCodexAppServer(account, limits);
    expect(parsed.accountId).toBe('acct-1');
    expect(parsed.plan).toBe('plus');
    expect(parsed.windows.map(w => [w.id, w.kind, w.remainingPercent, w.title])).toEqual([
      ['primary_window', 'five_hour', 60, undefined], ['extra-0-primary_window', 'other', 90, 'Spark']]);
    expect(() => parseCodexAppServer({ account: { type: 'apiKey' } }, limits)).toThrow();
    expect(() => parseCodexAppServer({ account: { type: 'chatgpt' } }, limits)).toThrow();
  });

  it('Retry-After has a one-minute floor; masked labels hide the middle', () => {
    expect(retryAt('0', 1000)).toBe(61_000);
    expect(retryAt(null, 0)).toBe(300_000);
    expect(maskEmail('corelli@gmail.com')).toBe('co•••li@gmail.com');
  });
});

function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>): FetchLike {
  return vi.fn(async (url: string) => {
    const r = routes[url] ?? { status: 404 };
    return { status: r.status ?? 200, headers: { get: () => null }, json: async () => r.body };
  }) as unknown as FetchLike;
}

describe('UsageClient', () => {
  it('Codex file token rejected → falls back to Codex app-server; same account id → same key', async () => {
    const appServer = vi.fn(async () => ({
      account: { account: { type: 'chatgpt', email: 'x@y.com' }, workspaceRouting: { chatgptAccountId: 'acct-1' } },
      limits: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 10080 } } },
    }));
    const client = new UsageClient(fakeFetch({ 'https://chatgpt.com/backend-api/wham/usage': { status: 401 } }), appServer);
    const got = await client.fetch({ sourceId: 'codex', provider: 'codex', token: 't', accountId: 'acct-1', codexHome: '/h' });
    expect(appServer).toHaveBeenCalledWith('/h');
    expect(got.accountKey).toBe(`codex:${hash('acct-1')}`);
    expect(got.windows[0].remainingPercent).toBe(80);
  });

  it('Claude identity comes from the profile (account + organization)', async () => {
    const client = new UsageClient(fakeFetch({
      'https://api.anthropic.com/api/oauth/usage': { body: { seven_day: { utilization: 10 } } },
      'https://api.anthropic.com/api/oauth/profile': { body: { account: { uuid: 'u1', email: 'z@z.com' }, organization: { uuid: 'o1', rate_limit_tier: 'default_claude_max_20x' } } },
    }));
    const got = await client.fetch({ sourceId: 'pi:claude', provider: 'claude', token: 'tok' });
    expect(got).toMatchObject({ accountKey: `claude:${hash('u1:o1')}`, email: 'z@z.com', plan: 'default_claude_max_20x' });
  });

  it('an expired Claude login is an auth error, never a stale success', async () => {
    const client = new UsageClient(fakeFetch({}));
    await expect(client.fetch({ sourceId: 'x', provider: 'claude', token: 't', expiresAt: 1 })).rejects.toThrow(/expired/);
  });
});

describe('AccountUsageMonitor', () => {
  it('dedupes one account seen through two sources and records history once per reading', async () => {
    const root = tmp(), p = paths(root);
    mkdirSync(join(root, 'pi')); mkdirSync(p.codexHome);
    writeFileSync(p.piAuth, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'a', accountId: 'same' } }));
    writeFileSync(join(p.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'b', account_id: 'same' } }));
    const fetch = fakeFetch({ 'https://chatgpt.com/backend-api/wham/usage': { body: {
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 604800 } } } } });
    const history = new UsageHistory(join(root, 'kraki', 'usage-history.jsonl'));
    let now = 1_790_000_000_000;
    const monitor = new AccountUsageMonitor({ paths: p, client: new UsageClient(fetch), history, now: () => now });
    const seen: unknown[] = [];
    monitor.onChange = (a) => seen.push(a);
    await monitor.refresh();
    expect(monitor.accounts).toHaveLength(1);
    expect(monitor.accounts[0]).toMatchObject({ accountKey: `codex:${hash('same')}`, windows: [{ remainingPercent: 70 }],
      agents: ['codex', 'pi'] });
    expect(history.load()).toHaveLength(1);
    expect(statSync(history.path).mode & 0o777).toBe(0o600);
    // Inside the per-source minimum interval nothing is refetched, recorded or re-announced.
    await monitor.refresh();
    expect(seen).toHaveLength(1);
    expect(history.load()).toHaveLength(1);
    now += 61_000;
    await monitor.refresh();
    expect(history.load()).toHaveLength(2);
  });

  it('an expired Pi login is renewed by Pi itself, then reread and fetched', async () => {
    const root = tmp(), p = paths(root);
    mkdirSync(join(root, 'pi'));
    writeFileSync(p.piAuth, JSON.stringify({ anthropic: { type: 'oauth', access: 'old', expires: 1 } }));
    const fetch = fakeFetch({ 'https://api.anthropic.com/api/oauth/usage': { body: { seven_day: { utilization: 20 } } } });
    const renewPi = vi.fn(async (provider: string, agentDir: string) => {
      expect([provider, agentDir]).toEqual(['claude', join(root, 'pi')]);
      writeFileSync(p.piAuth, JSON.stringify({ anthropic: { type: 'oauth', access: 'new', expires: 9e15 } }));
      return true;
    });
    const monitor = new AccountUsageMonitor({ paths: p, client: new UsageClient(fetch), renewPi, now: () => 1_790_000_000_000 });
    await monitor.refresh();
    expect(renewPi).toHaveBeenCalledTimes(1);
    expect(monitor.accounts[0]).toMatchObject({ windows: [{ remainingPercent: 80 }] });
    expect(monitor.accounts[0].error).toBeUndefined();
  });

  it('a login that stays expired keeps the last reading, marked as an auth error, and renewal is throttled', async () => {
    const root = tmp(), p = paths(root);
    mkdirSync(join(root, 'pi'));
    writeFileSync(p.piAuth, JSON.stringify({ anthropic: { type: 'oauth', access: 'a', expires: 9e15 } }));
    let status = 200;
    const fetch = vi.fn(async () => ({ status, headers: { get: () => null }, json: async () => ({ seven_day: { utilization: 30 } }) })) as unknown as FetchLike;
    const renewPi = vi.fn(async () => false);
    let now = 1_790_000_000_000;
    const monitor = new AccountUsageMonitor({ paths: p, client: new UsageClient(fetch), renewPi, now: () => now });
    await monitor.refresh();
    expect(monitor.accounts[0].windows[0].remainingPercent).toBe(70);
    status = 401; now += 61_000;
    await monitor.refresh();
    expect(monitor.accounts[0]).toMatchObject({ error: 'auth', windows: [{ remainingPercent: 70 }] });
    now += 61_000;
    await monitor.refresh();
    expect(renewPi).toHaveBeenCalledTimes(1);
    // Pi renewed it on its own: the same source with a new token keeps the old reading until it refreshes.
    writeFileSync(p.piAuth, JSON.stringify({ anthropic: { type: 'oauth', access: 'b', expires: 9e15 } }));
    status = 200; now += 61_000;
    await monitor.refresh();
    expect(monitor.accounts[0].error).toBeUndefined();
  });

  it('a source that never produced a reading (signed-out Codex home) shows no card', async () => {
    const root = tmp(), p = paths(root);
    mkdirSync(p.codexHome);
    const appServer = vi.fn(async () => { throw new UsageAuthError('Codex is not signed in'); });
    const monitor = new AccountUsageMonitor({ paths: p, client: new UsageClient(fakeFetch({}), appServer) });
    await monitor.refresh();
    expect(appServer).toHaveBeenCalledTimes(1);
    expect(monitor.accounts).toEqual([]);
  });
});
