/**
 * Account usage panel — Kraki for Mac's UsagePeek inside the window.
 *
 * Hold F6 for a compact overview of every account (one card per account,
 * however many computers share it; the one the open Session spends first,
 * highlighted). Move the pointer in and it grows into the detail view; move
 * out while still holding and it shrinks back; release and it fades away.
 * "Account Usage" (sidebar) opens it pinned, in detail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { AccountUsage, AccountUsageWindow, DeviceSummary } from '@kraki/protocol';
import { ArrowDownCircle, Gauge, Laptop, RotateCw } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import {
  accountKeyForSession, isStale, lastUpdatedText, mergedUsage, orderedAccounts, planTitle, providerTitle,
  readStatus, ringState, ringWindows, shortLabel, shortReset, usageUpdateHint, windowName, type MergedAccountUsage,
} from '../../lib/usage';
import { desktop } from '../../lib/desktop';
import './usage.css';

export const OPEN_USAGE_EVENT = 'kraki:open-usage';
export const USAGE_SHORTCUT = 'F6';

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** One quota window: ring + the remaining percent, counting up on appear. */
export function UsageRing({ window: w, stale, size, lineWidth, delay = 0, animateIn = true }: {
  window?: AccountUsageWindow; stale: boolean; size: number; lineWidth: number; delay?: number; animateIn?: boolean;
}) {
  const state = ringState(w?.remainingPercent, stale);
  const target = w?.remainingPercent ?? 0;
  const [value, setValue] = useState(animateIn && !reduceMotion() ? 0 : target);
  useEffect(() => {
    if (!animateIn || reduceMotion()) { setValue(target); return; }
    let raf = 0;
    const start = performance.now() + delay * 1000;
    const from = 0;
    const tick = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - start) / 900));
      const eased = 1 - (1 - p) ** 3;
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delay, animateIn]);
  const r = (size - lineWidth) / 2;
  const c = 2 * Math.PI * r;
  const gid = `ur-${state}`;
  return (
    <div className={`ur ur-${state}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" className="ur-c0" />
            <stop offset="1" className="ur-c1" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className="ur-track" strokeWidth={lineWidth} />
        {w && value >= 0.6 && (
          <circle
            cx={size / 2} cy={size / 2} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={lineWidth} strokeLinecap="round"
            strokeDasharray={`${(c * Math.max(0.0001, value / 100)).toFixed(2)} ${c.toFixed(2)}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            className="ur-arc"
            style={{ filter: `drop-shadow(0 0 ${lineWidth * 0.3}px var(--ur-glow))` }}
          />
        )}
      </svg>
      <div className="ur-label">
        {w ? (
          <span className={state === 'out' ? 'ur-num is-out' : stale ? 'ur-num is-stale' : 'ur-num'} style={{ fontSize: size * 0.3, letterSpacing: -size * 0.009 }}>
            {Math.round(value)}<span className="ur-pct" style={{ fontSize: size * 0.3 * 0.42 }}>%</span>
          </span>
        ) : <span className="ur-dash" style={{ fontSize: size * 0.26 }}>—</span>}
      </div>
    </div>
  );
}

function AccountRings({ account, size, lineWidth, spacing, now, delay, animateIn }: {
  account: AccountUsage; size: number; lineWidth: number; spacing: number; now: number; delay: number; animateIn: boolean;
}) {
  const windows = ringWindows(account);
  const stale = isStale(account, now);
  const small = size < 70;
  return (
    <div className="ua-rings" style={{ gap: spacing }}>
      {windows.length === 0 && (
        <div className="ua-ring-col">
          <UsageRing stale={stale} size={size} lineWidth={lineWidth} animateIn={false} />
          <span className="ua-ring-note" style={{ fontSize: small ? 9.5 : 10.5 }}>{account.error === 'auth' ? 'Sign-in needed' : 'Unavailable'}</span>
        </div>
      )}
      {windows.map((w, i) => (
        <div key={w.id} className="ua-ring-col" title={`${windowName(w)} ${Math.round(w.remainingPercent)}% left, resets in ${shortReset(w.resetsAt, now)}`}>
          <UsageRing window={w} stale={stale} size={size} lineWidth={lineWidth} delay={delay + i * 0.06} animateIn={animateIn} />
          <div className="ua-ring-tags">
            <span className="ua-ring-name" style={{ fontSize: small ? 9.5 : 10.5 }}>{windowName(w)}</span>
            <span className="ua-ring-reset" style={{ fontSize: small ? 9.5 : 10.5 }}>↻ {shortReset(w.resetsAt, now)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderChip({ provider }: { provider: string }) {
  return <span className={provider === 'codex' ? 'ua-chip is-gpt' : 'ua-chip is-claude'}>{provider === 'codex' ? 'GPT' : 'Claude'}</span>;
}

function AccountTile({ account, ringSize, lineWidth, showsPlan, shortName, delay, animateIn, now }: {
  account: AccountUsage; ringSize: number; lineWidth: number; showsPlan?: boolean; shortName?: boolean; delay: number; animateIn: boolean; now: number;
}) {
  const big = ringSize > 70;
  return (
    <div className="ua-tile" style={{ gap: big ? 10 : 8 }}>
      <div className="ua-tile-head">
        <div className="ua-tile-names">
          <span className="ua-tile-name" style={{ fontSize: big ? 14 : 12 }} title={account.label ?? providerTitle(account)}>
            {shortName ? shortLabel(account) : (account.label ?? providerTitle(account))}
          </span>
          {showsPlan && planTitle(account) && <span className="ua-tile-plan">{planTitle(account)}</span>}
        </div>
        <div className="ua-tile-badges">
          <ProviderChip provider={account.provider} />
          {isStale(account, now) && account.windows.length > 0 && <span className="ua-stale">Stale</span>}
        </div>
      </div>
      <AccountRings account={account} size={ringSize} lineWidth={lineWidth} spacing={big ? 18 : 14} now={now} delay={delay} animateIn={animateIn} />
    </div>
  );
}

function DeviceLine({ devices }: { devices: DeviceSummary[] }) {
  const shown = devices.length > 2 ? devices.slice(0, 1) : devices;
  return (
    <span className="ua-devices" title={devices.map((d) => d.name + (d.online ? '' : ' (offline)')).join('\n')}>
      <Laptop className="ua-devices-icon" />
      {shown.map((d, i) => (
        <span key={d.id}>{i > 0 && ' · '}<span className={d.online ? undefined : 'is-offline'}>{d.name}</span></span>
      ))}
      {devices.length > 2 && ` +${devices.length - 1}`}
    </span>
  );
}

function ReadStatus({ account, offline, now }: { account: AccountUsage; offline: boolean; now: number }) {
  const status = offline ? 'Device offline' : readStatus(account, now);
  return (
    <div className="ua-read">
      <span>{lastUpdatedText(account, now)}</span>
      {status && <span className="ua-read-warn">{status}</span>}
    </div>
  );
}

function RefreshControls() {
  const status = useStore((s) => s.status);
  const devices = useStore((s) => s.devices);
  const usage = useStore((s) => s.deviceUsage);
  const refreshes = useStore((s) => s.usageRefreshes);
  const now = useNow(1000);
  const targets = [...devices.values()].filter((d) => d.role === 'tentacle' && d.online && wsClient.deviceHasFeature(d.id, 'account_usage_refresh')).map((d) => d.id);
  const connected = status === 'connected';
  const busy = connected && targets.some((id) => refreshes.get(id)?.finished === false);
  const ready = connected && targets.some((id) => { const r = refreshes.get(id); return !r || (r.finished && now - r.startedAt >= 60_000); });
  let text: string;
  if (!connected) text = 'Connect to refresh';
  else if (busy) text = 'Refreshing…';
  else if (targets.length === 0) text = [...devices.values()].some((d) => d.role === 'tentacle' && d.online) ? 'Update or enable account usage on your device to refresh' : 'No device online';
  else {
    const err = targets.map((id) => refreshes.get(id)?.error).find(Boolean);
    if (err === 'timeout') text = 'Refresh timed out. Try again.';
    else if (err === 'offline' || err === 'connection') text = 'Connection lost. Try again.';
    else if (err === 'disabled') text = 'Enable account usage on the device.';
    else if (err === 'busy') text = 'Device is already refreshing. Try again shortly.';
    else if (err) text = "Couldn't refresh. Try again.";
    else if (targets.some((id) => usage.get(id)?.accounts.some((a) => a.error))) text = "Some accounts couldn't be updated";
    else text = ready ? 'Provider rate limits apply' : 'Refreshed recently · wait a moment';
  }
  return (
    <div className="ua-refresh">
      {busy && <span className="ua-spinner" />}
      <span className="ua-refresh-text">{text}</span>
      <button type="button" className="ua-refresh-btn" disabled={!ready || busy} title="Refresh readings without bypassing provider rate limits" onClick={() => wsClient.refreshAccountUsage()}>
        <RotateCw />Refresh
      </button>
    </div>
  );
}

function Empty({ outdated }: { outdated: DeviceSummary[] }) {
  return (
    <div className="ua-empty">
      <Gauge className="ua-empty-icon" />
      <span>{outdated.length ? usageUpdateHint(outdated) : 'No Claude or Codex accounts found on your devices'}</span>
    </div>
  );
}

function Card({ merged, isCurrent, index, now }: { merged: MergedAccountUsage; isCurrent: boolean; index: number; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const size = ref.current?.getBoundingClientRect();
  const rx = hover && size ? (0.5 - hover.y / size.height) * 6 : 0;
  const ry = hover && size ? (hover.x / size.width - 0.5) * 6 : 0;
  return (
    <div
      ref={ref}
      className={`ua-card${isCurrent ? ' is-current' : ''}${hover ? ' is-hover' : ''}`}
      style={{
        transform: reduceMotion() ? undefined : `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(${hover ? -2 : 0}px)`,
        '--hx': hover && size ? `${(hover.x / size.width) * 100}%` : '50%',
        '--hy': hover && size ? `${(hover.y / size.height) * 100}%` : '50%',
        animationDelay: `${0.06 + index * 0.035}s`,
      } as React.CSSProperties}
      onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); setHover({ x: e.clientX - b.left, y: e.clientY - b.top }); }}
      onMouseLeave={() => setHover(null)}
    >
      <AccountTile account={merged.account} ringSize={88} lineWidth={8} showsPlan delay={0.14 + index * 0.035} animateIn now={now} />
      <ReadStatus account={merged.account} offline={merged.allOffline} now={now} />
      <span className="ua-flex" />
      <div className="ua-card-foot">
        <DeviceLine devices={merged.devices} />
        <span className="ua-flex" />
        {isCurrent && <span className="ua-current">Current session</span>}
      </div>
    </div>
  );
}

function useUsageData() {
  const usage = useStore((s) => s.deviceUsage);
  const devices = useStore((s) => s.devices);
  const sessions = useStore((s) => s.sessions);
  const { sessionId } = useParams<{ sessionId: string }>();
  const current = useMemo(() => {
    const session = sessionId ? sessions.get(sessionId) : undefined;
    return session ? accountKeyForSession(usage, session.deviceId, session.agent, session.model) : null;
  }, [sessionId, sessions, usage]);
  const accounts = useMemo(() => orderedAccounts(mergedUsage(usage, devices), current), [usage, devices, current]);
  const outdated = useMemo(() => [...devices.values()]
    .filter((d) => d.role === 'tentacle' && d.online && wsClient.deviceHasFeature(d.id, 'account_usage') === false && !usage.has(d.id))
    .sort((a, b) => a.name.localeCompare(b.name)), [devices, usage]);
  return { accounts, current, outdated };
}

type Mode = 'closed' | 'compact' | 'detail';

/** Mount once in the window. */
export function UsagePanel() {
  const [mode, setMode] = useState<Mode>('closed');
  const [pinned, setPinned] = useState(false);
  const [closing, setClosing] = useState(false);
  const held = useRef(false);
  const inside = useRef(false);
  const { accounts, current, outdated } = useUsageData();
  const now = useNow(15_000);

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setMode('closed'); setClosing(false); setPinned(false); }, 180);
  }, []);
  const open = useCallback((m: Mode, pin: boolean) => {
    setClosing(false);
    setMode(m);
    setPinned(pin);
    wsClient.refreshAccountUsage({ automatic: true });
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== USAGE_SHORTCUT || e.repeat) return;
      e.preventDefault();
      if (mode !== 'closed' && pinned) { close(); return; }
      held.current = true;
      open(inside.current ? 'detail' : 'compact', false);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== USAGE_SHORTCUT) return;
      held.current = false;
      if (!pinned) close();
    };
    const blur = () => { if (held.current) { held.current = false; if (!pinned) close(); } };
    const openPinned = () => open('detail', true);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener(OPEN_USAGE_EVENT, openPinned);
    const offTray = desktop?.onOpen?.('usage', openPinned);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener(OPEN_USAGE_EVENT, openPinned);
      offTray?.();
    };
  }, [mode, pinned, open, close]);

  useEffect(() => {
    if (!pinned) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [pinned, close]);

  if (mode === 'closed') return null;
  const detailed = mode === 'detail';
  return (
    <>
      {pinned && <div className="ua-scrim" onMouseDown={close} />}
      <div
        className={`ua-panel ${detailed ? 'is-detail' : 'is-compact'}${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-label="Account Usage"
        data-testid="usage-panel"
        onMouseEnter={() => { inside.current = true; if (held.current) setMode('detail'); }}
        onMouseLeave={() => { inside.current = false; if (held.current && !pinned) setMode('compact'); }}
      >
        {detailed && <RefreshControls />}
        {accounts.length === 0 ? <Empty outdated={outdated} /> : detailed ? (
          <div className="ua-detail">
            <div className="ua-grid ua-grid-detail">
              {accounts.map((m, i) => <Card key={m.id} merged={m} isCurrent={m.id === current} index={i} now={now} />)}
            </div>
            {outdated.length > 0 && <div className="ua-update"><ArrowDownCircle />{usageUpdateHint(outdated)}</div>}
          </div>
        ) : (
          <div className="ua-grid ua-grid-compact">
            {accounts.slice(0, 6).map((m, i) => (
              <div key={m.id} className={`ua-compact-card${m.id === current ? ' is-current' : ''}`} style={{ animationDelay: `${0.06 + i * 0.035}s` }} title={m.id === current ? 'Spent by the current session' : undefined}>
                <AccountTile account={m.account} ringSize={48} lineWidth={5} shortName delay={0.14 + i * 0.035} animateIn now={now} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
