/**
 * Subscription account usage — the Mac/iOS AccountUsage model and the
 * DeviceStore usage helpers (merge across devices, the current Session's
 * account, refresh targets) for the Web / Kraki for Windows.
 */
import type { AccountUsage, AccountUsageWindow, DeviceSummary } from '@kraki/protocol';

export interface DeviceUsageSnapshot {
  accounts: AccountUsage[];
  receivedAt: number;
}

export interface UsageRefreshState {
  requestId: string;
  startedAt: number;
  finished: boolean;
  error?: string;
}

/** One subscription account across every device that reports it. */
export interface MergedAccountUsage {
  account: AccountUsage;
  /** Devices this account is signed in on; online ones first. */
  devices: DeviceSummary[];
  id: string;
  allOffline: boolean;
}

/** 5-hour then weekly; whatever the provider reports when neither exists. */
export function ringWindows(a: AccountUsage): AccountUsageWindow[] {
  const main = [a.windows.find((w) => w.kind === 'five_hour'), a.windows.find((w) => w.kind === 'weekly')].filter(Boolean) as AccountUsageWindow[];
  return main.length ? main : a.windows.slice(0, 2);
}

export function fetchedDate(a: AccountUsage): number | null {
  if (a.error && a.windows.length === 0) return null;
  const t = Date.parse(a.fetchedAt);
  return Number.isFinite(t) ? t : null;
}

function freshnessLifetimeMs(a: AccountUsage): number {
  const s = a.staleAfterSeconds;
  if (!s || !Number.isFinite(s) || s <= 0) return 2040_000;
  return Math.min(15_900, Math.max(60, s)) * 1000;
}

export function isStale(a: AccountUsage, now = Date.now()): boolean {
  if (a.error) return true;
  const f = fetchedDate(a);
  return f === null || now - f > freshnessLifetimeMs(a);
}

export function readStatus(a: AccountUsage, now = Date.now()): string | null {
  if (a.error === 'auth') return 'Sign-in needed';
  if (a.error === 'rate_limited') {
    const retry = a.retryAt ? Date.parse(a.retryAt) : NaN;
    if (Number.isFinite(retry) && retry > now) return `Rate limited · retry in ${Math.max(1, Math.ceil((retry - now) / 60_000))}m`;
    return 'Rate limited · try refreshing';
  }
  if (a.error) return "Couldn't refresh";
  return isStale(a, now) ? 'Update overdue' : null;
}

export function lastUpdatedText(a: AccountUsage, now = Date.now()): string {
  const f = fetchedDate(a);
  if (f === null) return 'Not updated yet';
  const age = Math.max(0, (now - f) / 1000);
  if (age < 60) return 'Updated just now';
  if (age < 3600) return `Updated ${Math.floor(age / 60)}m ago`;
  if (age < 86400) return `Updated ${Math.floor(age / 3600)}h ago`;
  return `Updated ${Math.floor(age / 86400)}d ago`;
}

export const providerTitle = (a: AccountUsage) => (a.provider === 'codex' ? 'GPT' : 'Claude');

/** Masked local part only (`co•••ai`) for tight spaces. */
export function shortLabel(a: AccountUsage): string {
  if (!a.label) return providerTitle(a);
  const at = a.label.indexOf('@');
  return at > 0 ? a.label.slice(0, at) : a.label;
}

export function planTitle(a: AccountUsage): string | undefined {
  switch (a.plan) {
    case 'default_claude_max_20x': return 'Max 20×';
    case 'default_claude_max_5x': return 'Max 5×';
    case 'default_claude_pro': case 'pro': return 'Pro';
    case 'max': return 'Max';
    case 'prolite': return 'Pro Lite';
    case 'plus': return 'Plus';
    case 'team': return 'Team';
    default: return a.plan;
  }
}

export function shortReset(resetsAt: string | undefined, now = Date.now()): string {
  if (!resetsAt) return '—';
  const s = Math.floor((Date.parse(resetsAt) - now) / 1000);
  if (!Number.isFinite(s)) return '—';
  if (s <= 60) return 'now';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

export function windowName(w: AccountUsageWindow): string {
  if (w.kind === 'five_hour') return '5h';
  if (w.kind === 'weekly') return 'Weekly';
  return w.title ?? 'Limit';
}

export type RingState = 'ok' | 'mid' | 'low' | 'out' | 'stale' | 'none';
export function ringState(remaining: number | undefined, stale: boolean): RingState {
  if (remaining === undefined) return 'none';
  if (stale) return 'stale';
  if (remaining <= 0.5) return 'out';
  if (remaining < 15) return 'low';
  if (remaining < 50) return 'mid';
  return 'ok';
}

/** Every reported account merged across devices (quota is per account). */
export function mergedUsage(usage: Map<string, DeviceUsageSnapshot>, devices: Map<string, DeviceSummary>): MergedAccountUsage[] {
  const byKey = new Map<string, { account: AccountUsage; devices: DeviceSummary[] }>();
  for (const [deviceId, snapshot] of usage) {
    const device = devices.get(deviceId);
    if (!device || device.role !== 'tentacle') continue;
    for (const account of snapshot.accounts) {
      const merged = byKey.get(account.accountKey);
      if (!merged) { byKey.set(account.accountKey, { account, devices: [device] }); continue; }
      merged.devices.push(device);
      const newer = (fetchedDate(account) ?? 0) > (fetchedDate(merged.account) ?? 0);
      // A fresh successful reading beats a newer failed one.
      if ((newer && (!account.error || merged.account.error)) || (merged.account.error && !account.error)) merged.account = account;
    }
  }
  return [...byKey.values()]
    .map((m) => {
      const devs = [...m.devices].sort((a, b) => (Number(!a.online) - Number(!b.online)) || a.name.localeCompare(b.name));
      return { account: m.account, devices: devs, id: m.account.accountKey, allOffline: !devs.some((d) => d.online) };
    })
    .filter((m) => !m.allOffline || m.account.windows.length > 0)
    .sort((a, b) => (Number(a.allOffline) - Number(b.allOffline))
      || a.account.provider.localeCompare(b.account.provider)
      || (a.account.label ?? '').localeCompare(b.account.label ?? ''));
}

/** Pi model ids carry the provider: `anthropic/…`, `openai-codex/…`. */
export function providerForModel(model?: string): string | null {
  const m = model?.toLowerCase();
  if (!m) return null;
  if (m.startsWith('anthropic/') || m.includes('claude')) return 'claude';
  if (m.startsWith('openai') || m.includes('gpt') || m.includes('codex')) return 'codex';
  return null;
}

/** The account a Session on this device / agent / model spends, if unambiguous. */
export function accountKeyForSession(usage: Map<string, DeviceUsageSnapshot>, deviceId: string, agent: string, model?: string): string | null {
  const accounts = usage.get(deviceId)?.accounts;
  if (!accounts) return null;
  let candidates = accounts.filter((a) => a.agents?.includes(agent));
  const provider = providerForModel(model);
  if (provider) candidates = candidates.filter((a) => a.provider === provider);
  return candidates.length === 1 ? candidates[0].accountKey : null;
}

/** Merged accounts, the current Session's first. */
export function orderedAccounts(list: MergedAccountUsage[], currentKey: string | null): MergedAccountUsage[] {
  if (!currentKey) return list;
  const i = list.findIndex((m) => m.id === currentKey);
  if (i <= 0) return list;
  const out = [...list];
  out.unshift(out.splice(i, 1)[0]);
  return out;
}

export function canRefreshUsage(state: UsageRefreshState | undefined, snapshot: DeviceUsageSnapshot | undefined, automatic: boolean, now = Date.now()): boolean {
  if (state && (!state.finished || now - state.startedAt < 60_000)) return false;
  if (!automatic || !snapshot || snapshot.accounts.length === 0) return true;
  return snapshot.accounts.some((a) => {
    if (a.error === 'rate_limited' && a.retryAt && Date.parse(a.retryAt) > now) return false;
    const f = fetchedDate(a);
    return !!a.error || f === null || now - f >= 60_000;
  });
}

export function usageUpdateHint(devices: DeviceSummary[]): string {
  const names = devices.map((d) => d.name);
  const list = names.length > 2 ? `${names[0]} and ${names.length - 1} more` : names.join(' and ');
  return `Update Kraki on ${list} to see ${devices.length === 1 ? 'its' : 'their'} accounts`;
}
