/**
 * AccountUsage — read-only subscription quota for the Claude / Codex accounts
 * already signed in on this machine.
 *
 * Sources (all read-only; tokens are never refreshed, copied, logged or sent):
 *  - Pi:          $PI_CODING_AGENT_DIR/auth.json or ~/.pi/agent/auth.json
 *                 (`anthropic` and `openai-codex` OAuth entries; API keys ignored)
 *  - Codex:       $CODEX_HOME/auth.json or ~/.codex/auth.json. Without a usable
 *                 file token (keyring login, expired, rejected) Codex's own
 *                 `codex app-server` answers instead; Codex owns its renewal.
 *  - Claude Code: $CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json
 *                 (Linux / Windows; on macOS Claude Code keeps it in the Keychain,
 *                 which a background daemon must not prompt for).
 *
 * Provider endpoints (the same ones the official clients use):
 *  - Claude: GET https://api.anthropic.com/api/oauth/usage (+ /profile for identity)
 *  - Codex:  GET https://chatgpt.com/backend-api/wham/usage
 *
 * Only percentages, reset times, plan ids and masked labels leave this module.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AccountUsage, AccountUsageWindow, UsageHistorySample } from '@kraki/protocol';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { createLogger } from './logger.js';
import { getProxyForUrl } from './update.js';

const logger = createLogger('account-usage');

export type UsageProvider = 'claude' | 'codex';

/** Deliberately carries no serialization helpers: never persist or send it. */
export interface UsageCredential {
  sourceId: string;
  provider: UsageProvider;
  token?: string;
  accountId?: string;
  email?: string;
  expiresAt?: number; // epoch ms
  /** Codex home whose own app-server can answer when the file token can't. */
  codexHome?: string;
}

export class UsageAuthError extends Error {}
/** The provider answered for a different account than the credential names. */
export class UsageWrongAccount extends Error {}
export class UsageRateLimited extends Error {
  constructor(readonly retryAt: number) { super('rate limited'); }
}

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export function maskEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.indexOf('@');
  if (at <= 0) return undefined;
  const local = email.slice(0, at);
  return local.slice(0, 2) + '•••' + (local.length > 4 ? local.slice(-2) : '') + email.slice(at);
}

function jwt(token: string | undefined): Record<string, unknown> {
  if (!token) return {};
  const part = token.split('.')[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>; }
  catch { return {}; }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path) || statSync(path).size > 2_000_000) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

// ── Discovery ────────────────────────────────────────────

export interface UsagePaths { piAuth: string; codexHome: string; claudeCredentials: string }

export function defaultUsagePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): UsagePaths {
  return {
    piAuth: join(env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent'), 'auth.json'),
    codexHome: env.CODEX_HOME ?? join(home, '.codex'),
    claudeCredentials: join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json'),
  };
}

export function discoverCredentials(paths: UsagePaths): UsageCredential[] {
  const out: UsageCredential[] = [];
  const pi = readJson(paths.piAuth);
  if (pi) {
    for (const [key, provider] of [['anthropic', 'claude'], ['openai-codex', 'codex']] as const) {
      const entry = pi[key] as Record<string, unknown> | undefined;
      if (entry?.type !== 'oauth' || typeof entry.access !== 'string' || !entry.access) continue;
      const claims = jwt(entry.access);
      const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
      const profile = claims['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
      out.push({
        sourceId: `pi:${provider}`, provider, token: entry.access,
        accountId: (entry.accountId as string | undefined) ?? (auth?.chatgpt_account_id as string | undefined),
        email: (claims.email as string | undefined) ?? (profile?.email as string | undefined),
        expiresAt: typeof entry.expires === 'number' ? entry.expires : undefined,
      });
    }
  }

  const codexFile = readJson(join(paths.codexHome, 'auth.json'));
  const tokens = codexFile?.tokens as Record<string, unknown> | undefined;
  if (typeof tokens?.access_token === 'string' && tokens.access_token) {
    const claims = jwt(tokens.access_token);
    const identity = jwt(tokens.id_token as string | undefined);
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    out.push({
      sourceId: 'codex', provider: 'codex', token: tokens.access_token, codexHome: paths.codexHome,
      accountId: (tokens.account_id as string | undefined) ?? (auth?.chatgpt_account_id as string | undefined),
      email: (identity.email as string | undefined) ?? (claims.email as string | undefined),
      expiresAt: typeof claims.exp === 'number' ? claims.exp * 1000 : undefined,
    });
  } else if (existsSync(paths.codexHome) && !codexFile?.OPENAI_API_KEY) {
    // Keyring / desktop-app login: let Codex itself answer.
    out.push({ sourceId: 'codex', provider: 'codex', codexHome: paths.codexHome });
  }

  const claude = readJson(paths.claudeCredentials);
  const oauth = claude?.claudeAiOauth as Record<string, unknown> | undefined;
  if (typeof oauth?.accessToken === 'string' && oauth.accessToken) {
    out.push({
      sourceId: 'claude-code', provider: 'claude', token: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    });
  }
  return out;
}

// ── Parsing ──────────────────────────────────────────────

const FIVE_HOURS = 18_000;
const WEEK = 604_800;

/** A JSON number only — never a boolean (JSON 0/1 must stay numbers). */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function percent(value: unknown): number | undefined {
  const n = num(value);
  return n !== undefined && n >= 0 && n <= 100 ? n : undefined;
}
function isoDate(value: unknown): string | undefined {
  if (typeof value === 'number' && value > 0) return new Date(value * 1000).toISOString();
  if (typeof value === 'string') { const d = new Date(value); if (!Number.isNaN(d.getTime())) return d.toISOString(); }
  return undefined;
}
function kindOf(seconds: number | undefined, id: string): AccountUsageWindow['kind'] {
  if (id.startsWith('extra-')) return 'other';
  if (seconds !== undefined && Math.abs(seconds - FIVE_HOURS) < 120) return 'five_hour';
  if (seconds !== undefined && Math.abs(seconds - WEEK) < 3600) return 'weekly';
  return 'other';
}
function makeWindow(id: string, used: number, seconds: number | undefined, resetsAt: string | undefined, title?: string): AccountUsageWindow {
  return {
    id, kind: kindOf(seconds, id), remainingPercent: Math.max(0, Math.min(100, 100 - used)),
    ...(resetsAt && { resetsAt }), ...(seconds !== undefined && { durationSeconds: seconds }),
    ...(title && { title }),
  };
}

export interface ParsedUsage { windows: AccountUsageWindow[]; plan?: string }

export function parseClaudeUsage(root: Record<string, unknown>): ParsedUsage {
  const windows: AccountUsageWindow[] = [];
  const known: [string, number, string | undefined][] = [
    ['five_hour', FIVE_HOURS, undefined], ['seven_day', WEEK, undefined],
    ['seven_day_opus', WEEK, 'Opus'], ['seven_day_sonnet', WEEK, 'Sonnet'],
  ];
  for (const [id, seconds, title] of known) {
    const obj = root[id] as Record<string, unknown> | undefined;
    const used = percent(obj?.utilization);
    if (used === undefined) continue;
    const w = makeWindow(id, used, seconds, isoDate(obj?.resets_at), title);
    if (title) w.kind = 'other';
    windows.push(w);
  }
  if (!windows.length) throw new Error('no recognizable Claude subscription windows');
  return { windows };
}

export function parseCodexUsage(root: Record<string, unknown>, now = Date.now()): ParsedUsage {
  const windows: AccountUsageWindow[] = [];
  const add = (obj: Record<string, unknown>, prefix: string, label?: string) => {
    for (const key of ['primary_window', 'secondary_window']) {
      const w = obj[key] as Record<string, unknown> | undefined;
      const used = percent(w?.used_percent);
      if (used === undefined) continue;
      const seconds = num(w?.limit_window_seconds);
      const after = num(w?.reset_after_seconds);
      const reset = isoDate(w?.reset_at) ?? (after !== undefined && after >= 0 ? new Date(now + after * 1000).toISOString() : undefined);
      windows.push(makeWindow(prefix + key, used, seconds, reset, label));
    }
  };
  add((root.rate_limit as Record<string, unknown>) ?? {}, '');
  const extras = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits as Record<string, unknown>[] : [];
  extras.forEach((item, i) => add((item.rate_limit as Record<string, unknown>) ?? item, `extra-${i}-`,
    (item.limit_name as string | undefined) ?? (item.metered_feature as string | undefined)));
  if (!windows.length) throw new Error('no recognizable Codex subscription windows');
  return { windows, plan: root.plan_type as string | undefined };
}

/** `account/read` + `account/rateLimits/read` results from `codex app-server`. */
export function parseCodexAppServer(account: Record<string, unknown>, limits: Record<string, unknown>):
  ParsedUsage & { accountId: string; email?: string } {
  const details = account.account as Record<string, unknown> | null | undefined;
  if (details?.type === 'apiKey') throw new UsageAuthError('Codex home uses an API key, not a subscription');
  if (!details && account.requiresOpenaiAuth === true) throw new UsageAuthError('Codex is not signed in');
  const routing = account.workspaceRouting as Record<string, unknown> | undefined;
  const accountId = (routing?.chatgptAccountId as string | undefined) ?? (limits.accountId as string | undefined);
  if (!accountId) throw new Error('Codex returned no account identity');
  const windows: AccountUsageWindow[] = [];
  const add = (snap: Record<string, unknown>, prefix: string, label?: string) => {
    for (const key of ['primary', 'secondary']) {
      const w = snap[key] as Record<string, unknown> | undefined;
      const used = percent(w?.usedPercent);
      if (used === undefined) continue;
      const mins = num(w?.windowDurationMins);
      windows.push(makeWindow(`${prefix}${key}_window`, used, mins !== undefined ? mins * 60 : undefined, isoDate(w?.resetsAt), label));
    }
  };
  const main = (limits.rateLimits as Record<string, unknown>) ?? {};
  add(main, '');
  const mainId = (main.limitId as string | undefined) ?? 'codex';
  const byId = (limits.rateLimitsByLimitId as Record<string, Record<string, unknown>>) ?? {};
  Object.keys(byId).filter(k => k !== mainId).sort().forEach((k, i) =>
    add(byId[k], `extra-${i}-`, (byId[k].limitName as string | undefined) ?? k));
  if (!windows.length) throw new Error('no recognizable Codex subscription windows');
  return { windows, accountId, email: details?.email as string | undefined,
    plan: (main.planType as string | undefined) ?? (details?.planType as string | undefined) };
}

export function retryAt(header: string | null, now = Date.now()): number {
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return now + Math.max(60, secs) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(now + 60_000, date);
  }
  return now + 300_000;
}

// ── Fetching ─────────────────────────────────────────────

export type FetchLike = (url: string, init: { headers: Record<string, string>; redirect: 'error'; signal: AbortSignal }) =>
  Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export interface AppServerRunner {
  (codexHome: string): Promise<{ account: Record<string, unknown>; limits: Record<string, unknown> }>;
}

export interface FetchedAccount {
  accountKey: string;
  provider: UsageProvider;
  email?: string;
  plan?: string;
  windows: AccountUsageWindow[];
  fetchedAt: number;
}

/**
 * GET with the user's HTTP(S)_PROXY / NO_PROXY honored (Node's fetch ignores
 * them), without touching process-wide agents the relay connection uses.
 * Redirects are refused so a bearer token never follows one.
 */
export const proxiedGet: FetchLike = (url, init) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const timeout = 20_000;
  const finish = (res: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => { size += c.length; if (size > 2_000_000) res.destroy(new Error('response too large')); else chunks.push(c); });
    res.on('end', () => resolve({
      status: res.statusCode ?? 0,
      headers: { get: (name) => { const v = res.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] ?? null : v ?? null; } },
      json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
    }));
    res.on('error', reject);
  };
  const options = (socket?: Socket): RequestOptions => ({
    method: 'GET', host: target.hostname, port: target.port ? Number(target.port) : 443,
    path: target.pathname + target.search, headers: init.headers, servername: target.hostname,
    ...(socket && { socket, agent: false }),
  });
  const proxy = getProxyForUrl(url);
  if (!proxy) {
    const req = httpsRequest(options(), finish);
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    return req.end();
  }
  const auth = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : undefined;
  const connect = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
    host: proxy.hostname, port: proxy.port ? Number(proxy.port) : proxy.protocol === 'https:' ? 443 : 80,
    method: 'CONNECT', path: `${target.hostname}:${target.port || 443}`,
    headers: { Host: `${target.hostname}:${target.port || 443}`, ...(auth && { 'Proxy-Authorization': auth }) },
  });
  connect.setTimeout(timeout, () => connect.destroy(new Error('proxy timed out')));
  connect.on('error', reject);
  connect.on('connect', (res, socket, head) => {
    if (res.statusCode !== 200) { socket.destroy(); return reject(new Error(`proxy CONNECT ${res.statusCode}`)); }
    if (head.length) socket.unshift(head);
    const req = httpsRequest(options(socket), finish);
    req.setTimeout(timeout, () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => { socket.destroy(); reject(err); });
    req.end();
  });
  connect.end();
});

export class UsageClient {
  private profiles = new Map<string, { key: string; email?: string; plan?: string }>();
  constructor(private readonly fetchImpl: FetchLike = proxiedGet,
              private readonly appServer: AppServerRunner = runCodexAppServer) {}

  private async get(url: string, cred: UsageCredential): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.token}`, Accept: 'application/json', 'User-Agent': 'KrakiTentacle/usage',
    };
    if (cred.provider === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
    else if (cred.accountId) headers['ChatGPT-Account-Id'] = cred.accountId;
    const res = await this.fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (res.status === 401 || res.status === 403) throw new UsageAuthError(`HTTP ${res.status}`);
    if (res.status === 429) throw new UsageRateLimited(retryAt(res.headers.get('retry-after')));
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || typeof body !== 'object') throw new Error('unrecognized response');
    return body as Record<string, unknown>;
  }

  async fetch(cred: UsageCredential, now = Date.now()): Promise<FetchedAccount> {
    const expired = cred.expiresAt !== undefined && cred.expiresAt <= now;
    if (cred.provider === 'codex') {
      if (!cred.token || expired) return this.viaAppServer(cred, now);
      try { return await this.direct(cred, now); }
      catch (err) {
        if (err instanceof UsageAuthError && cred.codexHome) return this.viaAppServer(cred, now);
        throw err;
      }
    }
    if (expired) throw new UsageAuthError('login expired; the owning tool renews it on next use');
    return this.direct(cred, now);
  }

  private async viaAppServer(cred: UsageCredential, now: number): Promise<FetchedAccount> {
    if (!cred.codexHome) throw new UsageAuthError('no usable Codex login');
    const { account, limits } = await this.appServer(cred.codexHome);
    const parsed = parseCodexAppServer(account, limits);
    return { accountKey: `codex:${hash(parsed.accountId)}`, provider: 'codex', email: parsed.email,
      plan: parsed.plan, windows: parsed.windows, fetchedAt: now };
  }

  private async direct(cred: UsageCredential, now: number): Promise<FetchedAccount> {
    if (cred.provider === 'codex') {
      const root = await this.get('https://chatgpt.com/backend-api/wham/usage', cred);
      const reported = root.account_id as string | undefined;
      if (reported && cred.accountId && reported !== cred.accountId) throw new UsageWrongAccount('account mismatch');
      const parsed = parseCodexUsage(root, now);
      const id = cred.accountId ?? reported;
      return { accountKey: id ? `codex:${hash(id)}` : `codex-slot:${hash(cred.sourceId + cred.token)}`,
        provider: 'codex', email: cred.email, plan: parsed.plan, windows: parsed.windows, fetchedAt: now };
    }
    const root = await this.get('https://api.anthropic.com/api/oauth/usage', cred);
    const parsed = parseClaudeUsage(root);
    const fp = hash(cred.token ?? '');
    if (!this.profiles.has(fp)) {
      try {
        const profile = await this.get('https://api.anthropic.com/api/oauth/profile', cred);
        const account = profile.account as Record<string, unknown> | undefined;
        const org = profile.organization as Record<string, unknown> | undefined;
        if (typeof account?.uuid === 'string') {
          if (this.profiles.size > 32) this.profiles.clear();
          this.profiles.set(fp, {
            key: `claude:${hash(`${account.uuid}:${(org?.uuid as string | undefined) ?? ''}`)}`,
            email: account.email as string | undefined,
            plan: (org?.rate_limit_tier as string | undefined)
              ?? (account.has_claude_max ? 'max' : account.has_claude_pro ? 'pro' : undefined),
          });
        }
      } catch { /* identity is optional; quota is still valid */ }
    }
    const identity = this.profiles.get(fp);
    return { accountKey: identity?.key ?? `claude-slot:${hash(cred.sourceId + fp)}`, provider: 'claude',
      email: identity?.email ?? cred.email, plan: identity?.plan, windows: parsed.windows, fetchedAt: now };
  }
}

// ── codex app-server ─────────────────────────────────────

/** Desktop-bundled binaries first (they match the app's own login), then CLIs on PATH. */
export function codexExecutables(env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  const list = env.KRAKI_CODEX_PATH ? [env.KRAKI_CODEX_PATH] : [];
  if (process.platform === 'darwin') {
    for (const app of ['Codex.app', 'ChatGPT.app']) {
      list.push(`/Applications/${app}/Contents/Resources/codex`, join(home, 'Applications', app, 'Contents/Resources/codex'));
    }
  }
  list.push('codex');
  return list.filter(p => p === 'codex' || existsSync(p));
}

export function runCodexAppServer(codexHome: string, timeoutMs = 25_000): Promise<{ account: Record<string, unknown>; limits: Record<string, unknown> }> {
  const [bin] = codexExecutables();
  return new Promise((resolve, reject) => {
    const child = spawn(bin ?? 'codex', ['-s', 'read-only', '-a', 'never', 'app-server'], {
      env: { ...process.env, CODEX_HOME: codexHome }, cwd: homedir(), stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true, shell: process.platform === 'win32',
    });
    const responses = new Map<number, Record<string, unknown>>();
    let buffer = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (err) return reject(err);
      const account = responses.get(2), limits = responses.get(3);
      const error = (limits?.error ?? account?.error) as Record<string, unknown> | undefined;
      if (error) {
        const text = String(error.message ?? '').toLowerCase();
        return reject(/auth|login|401|token/.test(text) ? new UsageAuthError('Codex login unavailable') : new Error('Codex app-server error'));
      }
      resolve({ account: (account?.result as Record<string, unknown>) ?? {}, limits: (limits?.result as Record<string, unknown>) ?? {} });
    };
    const timer = setTimeout(() => finish(new Error('Codex app-server timed out')), timeoutMs);
    child.on('error', () => finish(new Error('Codex is not installed')));
    child.on('exit', () => finish(responses.size >= 2 ? undefined : new Error('Codex app-server exited')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 4_000_000) return finish(new Error('Codex app-server output too large'));
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg.id === 2 || msg.id === 3) responses.set(msg.id as number, msg);
        } catch { /* notification or partial */ }
      }
      if (responses.size >= 2) finish();
    });
    const send = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'kraki-tentacle', version: 'usage' } } });
    send({ method: 'initialized' });
    send({ id: 2, method: 'account/read', params: {} });
    send({ id: 3, method: 'account/rateLimits/read', params: {} });
  });
}

// ── Pi-owned renewal ─────────────────────────────────────

/** Pi provider ids for `pi auth check`. */
export const piProviderId = (provider: UsageProvider): string => (provider === 'claude' ? 'anthropic' : 'openai-codex');

/**
 * Asks Pi itself to renew an expired OAuth login (`pi auth check --provider … --json`).
 * Pi refreshes under its own lock on auth.json and re-reads the file inside it, so this
 * can't race running Pi processes; this module still never writes the file. No
 * conversation is created. Resolves true when Pi reports the login ready.
 */
export function renewPiLogin(provider: UsageProvider, agentDir: string, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('pi', ['auth', 'check', '--provider', piProviderId(provider), '--json'], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, cwd: homedir(), stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true, shell: process.platform === 'win32',
    });
    let out = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (c: Buffer) => { if (out.length < 10_000) out += c.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Never log the output; this form carries no credentials, but stay strict.
      try { resolve(code === 0 && (JSON.parse(out) as { status?: string }).status === 'ready'); } catch { resolve(false); }
    });
  });
}

// ── History ──────────────────────────────────────────────

/** Append-only JSON Lines file (0600). No credentials, no emails. */
export class UsageHistory {
  private last = new Map<string, number>();
  private loaded = false;
  constructor(readonly path: string) {}

  load(since = 0): UsageHistorySample[] {
    let text = '';
    try { text = readFileSync(this.path, 'utf8'); } catch { return []; }
    const out: UsageHistorySample[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { const s = JSON.parse(line) as UsageHistorySample; if (s.t >= since) out.push(s); } catch { /* torn line */ }
    }
    return out;
  }

  append(samples: UsageHistorySample[]): void {
    if (!this.loaded) {
      for (const s of this.load()) this.last.set(`${s.k}|${s.w}`, Math.max(this.last.get(`${s.k}|${s.w}`) ?? 0, s.t));
      this.loaded = true;
    }
    // A cached or unchanged reading keeps its original timestamp: record it once.
    const fresh = samples.filter(s => s.t > (this.last.get(`${s.k}|${s.w}`) ?? 0));
    if (!fresh.length) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, fresh.map(s => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
      chmodSync(this.path, 0o600);
      for (const s of fresh) this.last.set(`${s.k}|${s.w}`, s.t);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'usage history append failed');
    }
  }
}

/** The Kraki agent id that spends a credential source's account. */
export function agentForSource(sourceId: string): string {
  if (sourceId.startsWith('pi:')) return 'pi';
  if (sourceId === 'claude-code') return 'claude';
  return 'codex';
}

// ── Monitor ──────────────────────────────────────────────

interface Slot { cred: UsageCredential; account?: FetchedAccount; error?: string; nextAllowed: number; lastRenewal?: number }

export interface AccountUsageMonitorOptions {
  paths?: UsagePaths;
  client?: UsageClient;
  history?: UsageHistory;
  intervalMs?: number;
  now?: () => number;
  /** Override for tests; defaults to `renewPiLogin`. */
  renewPi?: (provider: UsageProvider, agentDir: string) => Promise<boolean>;
}

/** Polls every 15 minutes by default; manual reads share the same cooldowns. */
export class AccountUsageMonitor {
  onChange?: (accounts: AccountUsage[]) => void;
  private slots = new Map<string, Slot>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private lastPayload = '';
  private readonly paths: UsagePaths;
  private readonly client: UsageClient;
  private readonly now: () => number;
  readonly history?: UsageHistory;

  constructor(private readonly opts: AccountUsageMonitorOptions = {}) {
    this.paths = opts.paths ?? defaultUsagePaths();
    this.client = opts.client ?? new UsageClient();
    this.history = opts.history;
    this.now = opts.now ?? Date.now;
  }

  /**
   * First reading right away, then every `intervalMs` (default 15 min) with ±10% jitter,
   * so several machines sharing an account don't hit the provider in lockstep. Anthropic's
   * usage endpoint rate-limits hard; a 429 backs that source off for its Retry-After.
   */
  start(): void {
    if (this.timer || this.stopped === false) return;
    this.stopped = false;
    void this.refresh();
    this.schedule();
  }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private stopped: boolean | null = null;
  private schedule(): void {
    if (this.stopped) return;
    const base = this.pollIntervalMs;
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().finally(() => this.schedule()); },
      base * (0.9 + Math.random() * 0.2));
    this.timer.unref?.();
  }

  private get pollIntervalMs(): number {
    const value = this.opts.intervalMs ?? 900_000;
    return Number.isFinite(value) && value > 0 ? value : 900_000;
  }

  get accounts(): AccountUsage[] {
    const byKey = new Map<string, Slot>();
    const agentsByKey = new Map<string, Set<string>>();
    for (const slot of this.slots.values()) {
      // Only accounts read successfully at least once: a signed-out Codex home or a login that
      // expired before the first reading has no identity worth a card.
      if (!slot.account) continue;
      const key = slot.account?.accountKey ?? `${slot.cred.provider}-slot:${hash(slot.cred.sourceId)}`;
      const agents = agentsByKey.get(key) ?? new Set<string>();
      agents.add(agentForSource(slot.cred.sourceId));
      agentsByKey.set(key, agents);
      const prev = byKey.get(key);
      // Same account from several sources: keep the freshest successful reading.
      if (!prev || (slot.account && !slot.error && (!prev.account || prev.error || slot.account.fetchedAt > prev.account.fetchedAt))) byKey.set(key, slot);
    }
    return [...byKey.entries()].map(([accountKey, slot]) => ({
      accountKey,
      provider: slot.cred.provider,
      ...(maskEmail(slot.account?.email ?? slot.cred.email) && { label: maskEmail(slot.account?.email ?? slot.cred.email) }),
      ...(slot.account?.plan && { plan: slot.account.plan }),
      windows: slot.account?.windows ?? [],
      fetchedAt: slot.account ? new Date(slot.account.fetchedAt).toISOString() : '',
      staleAfterSeconds: Math.ceil(this.pollIntervalMs * 22 / 10_000) + 60,
      ...(slot.error && { error: slot.error }),
      ...(slot.error === 'rate_limited' && { retryAt: new Date(slot.nextAllowed).toISOString() }),
      agents: [...(agentsByKey.get(accountKey) ?? [])].sort(),
    })).sort((a, b) => a.provider.localeCompare(b.provider) || (a.label ?? '').localeCompare(b.label ?? ''));
  }

  refresh(): Promise<void> {
    this.running ??= this.doRefresh().finally(() => { this.running = null; });
    return this.running;
  }

  private async doRefresh(): Promise<void> {
    const creds = discoverCredentials(this.paths);
    const seen = new Set<string>();
    for (const cred of creds) {
      seen.add(cred.sourceId);
      const prev = this.slots.get(cred.sourceId);
      const changed = prev && (prev.cred.token !== cred.token || prev.cred.provider !== cred.provider);
      if (prev && !changed) { this.slots.set(cred.sourceId, { ...prev, cred }); continue; }
      // A renewed token in the same source is normally the same account: keep its last reading
      // (shown as stale until a fresh one lands) unless the credential names a different account.
      const sameAccount = prev && prev.cred.provider === cred.provider
        && !(prev.cred.accountId && cred.accountId && prev.cred.accountId !== cred.accountId);
      this.slots.set(cred.sourceId, sameAccount
        ? { cred, account: prev.account, error: prev.error,
            // A token rotation must not bypass the provider's Retry-After.
            nextAllowed: prev.error === 'rate_limited' ? prev.nextAllowed : 0,
            lastRenewal: prev.lastRenewal }
        : { cred, nextAllowed: 0 });
    }
    for (const id of [...this.slots.keys()]) if (!seen.has(id)) this.slots.delete(id);

    const now = this.now();
    await Promise.all([...this.slots.values()].filter(s => s.nextAllowed <= now).map(async (slot) => {
      try {
        try {
          slot.account = await this.client.fetch(slot.cred, this.now());
        } catch (err) {
          const renewed = err instanceof UsageAuthError ? await this.renewViaPi(slot) : null;
          if (!renewed) throw err;
          slot.cred = renewed;
          slot.account = await this.client.fetch(renewed, this.now());
        }
        slot.error = undefined;
        slot.nextAllowed = this.now() + 60_000;
      } catch (err) {
        if (err instanceof UsageRateLimited) { slot.nextAllowed = err.retryAt; slot.error = 'rate_limited'; }
        // An expired login keeps the last numbers; apps show them as stale.
        else if (err instanceof UsageAuthError) { slot.error = 'auth'; slot.nextAllowed = this.now() + 60_000; }
        else if (err instanceof UsageWrongAccount) { slot.account = undefined; slot.error = 'auth'; slot.nextAllowed = this.now() + 60_000; }
        else { slot.error = 'unavailable'; slot.nextAllowed = this.now() + 60_000; }
        logger.debug({ source: slot.cred.sourceId, err: (err as Error).message }, 'usage fetch failed');
      }
    }));

    const accounts = this.accounts;
    this.record(accounts);
    const payload = JSON.stringify(accounts.map(a => ({ ...a, fetchedAt: a.error ? '' : a.fetchedAt })));
    if (payload !== this.lastPayload) {
      this.lastPayload = payload;
      this.onChange?.(accounts);
    }
  }

  /** Pi logins only, at most once per source every 10 minutes. Returns the reread credential. */
  private async renewViaPi(slot: Slot): Promise<UsageCredential | null> {
    if (!slot.cred.sourceId.startsWith('pi:')) return null;
    if (slot.lastRenewal && this.now() - slot.lastRenewal < 600_000) return null;
    slot.lastRenewal = this.now();
    const ok = await (this.opts.renewPi ?? renewPiLogin)(slot.cred.provider, dirname(this.paths.piAuth));
    if (!ok) return null;
    const fresh = discoverCredentials(this.paths).find(c => c.sourceId === slot.cred.sourceId);
    if (!fresh || (fresh.token === slot.cred.token && (fresh.expiresAt ?? Infinity) <= this.now())) return null;
    return fresh;
  }

  private record(accounts: AccountUsage[]): void {
    if (!this.history) return;
    const samples: UsageHistorySample[] = [];
    for (const a of accounts) {
      if (a.error) continue;
      const t = Math.round(Date.parse(a.fetchedAt) / 1000);
      for (const w of a.windows) {
        samples.push({ t, k: a.accountKey, w: w.id, ...(w.durationSeconds !== undefined && { d: w.durationSeconds }),
          u: Math.round((100 - w.remainingPercent) * 100) / 100,
          ...(w.resetsAt && { r: Math.round(Date.parse(w.resetsAt) / 1000) }) });
      }
    }
    this.history.append(samples);
  }
}
