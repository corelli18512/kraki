/** Shared by RelayClient and its modules: options, loggers, error wording, coalescing and redirect rules. */

import type { ProducerMessage, DeviceInfo, AuthMethod } from '@kraki/protocol';
import { createLogger } from '../logger.js';

export const logger = createLogger('relay-client');
/** Pulse-trace is OFF by default. Enable with env `KRAKI_TRACE_PULSE=1`
 *  before daemon start. See tentacle-pulse.ts for why (event-loop
 *  starvation via pino sync-fsync under stream storms). */
export const TRACE_ENABLED = process.env.KRAKI_TRACE_PULSE === '1';
export const traceLogger = createLogger('pulse-trace');
export const traceLog = {
  info: TRACE_ENABLED
    ? (obj: Record<string, unknown>) => traceLogger.info(obj)
    : (_obj: Record<string, unknown>) => { /* no-op */ },
};

export const GENERIC_TERMINAL_ERROR = 'Agent request failed';

export const AGENT_LABELS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', pi: 'Pi' };

/** A session could not be reattached to its agent after a restart/eviction. */
export class SessionResumeError extends Error {
  constructor(agent: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`${AGENT_LABELS[agent] ?? agent} couldn't reopen this session: ${reason}`);
    this.name = 'SessionResumeError';
  }
}

/** User-facing text for a failed command: no "Failed to x:" stacking for
 *  errors that already explain themselves. */
export function describeFailure(prefix: string, err: unknown): string {
  if (err instanceof SessionResumeError) return err.message;
  return `${prefix}: ${(err as Error)?.message ?? String(err)}`;
}

export function normalizeTerminalErrorMessage(
  value: unknown,
): { message: string; quality: number } {
  if (typeof value !== 'string') {
    return { message: GENERIC_TERMINAL_ERROR, quality: 0 };
  }
  const message = value.trim();
  if (
    !message ||
    /^(success|unknown|error_during_execution)$/i.test(message)
  ) {
    return { message: GENERIC_TERMINAL_ERROR, quality: 0 };
  }
  const concrete =
    /\b(?:HTTP\s*)?[45]\d\d\b|status code|request id|provider|API error/i.test(
      message,
    );
  return { message, quality: concrete ? 2 : 1 };
}

export interface RelayClientOptions {
  /** Relay WebSocket URL (e.g., wss://relay.kraki.chat) */
  relayUrl: string;
  /** Device info for auth */
  device: DeviceInfo;
  /** How the relay should authenticate this device */
  authMethod: AuthMethod['method'];
  /** Auth token, such as a GitHub token or channel/shared key */
  token?: string;
  /** Reconnect delay in ms. Default: 3000 */
  reconnectDelay?: number;
  /** Max reconnect attempts. Default: Infinity */
  maxReconnects?: number;
  /** Tentacle version string (included in device_greeting) */
  version?: string;
  /** Days without messages before an unpinned session is archived; 0 = never.
   *  Default 14 (F2). */
  autoArchiveDays?: number;
  /** Persist a new auto-archive setting chosen from an app. */
  saveAutoArchiveDays?: (days: number) => void;
  /** Serve same-machine Apps over a loopback link instead of the Head.
   *  Default: on unless KRAKI_LOCAL_LINK=0. */
  localLink?: boolean;
  /** @internal Historical-protocol test fixture only; not a CLI/config option.
   *  Shipping clients omit this and always allow signed-in account devices.
   *  'policy' reproduces the previous release's on-disk enforcement behaviour
   *  so old/new transition and signature-boundary tests remain meaningful. */
  deviceTrust?: 'enforce' | 'compatible' | 'policy';
}

export const DEFAULT_AUTO_ARCHIVE_DAYS = 14;
export const AUTO_ARCHIVE_SWEEP_MS = 6 * 3600_000;

export type RelayClientState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

/**
 * Send-time coalesce key for the pulse reliable-transport layer (pulse spec §12).
 * Messages that share a key supersede each other in the outbox: a later send
 * with the same key drops earlier ones before transmission. This means a peer
 * that was offline receives exactly ONE latest value per key on reconnect — not
 * a burst of stale frames.
 *
 * Only state-covering messages get a key:
 *   - `card_action` - the current status-card state; stale actions are noise.
 *   - `compacting` - the current runtime state; stale phases are noise.
 *
 * Event messages (`agent_message`, `user_message`, `tool_start`, etc.) return
 * `undefined` - every event must be delivered.
 */
export function coalesceKeyFor(msg: Partial<ProducerMessage>): string | undefined {
  // NOT agent_message_delta: deltas are append chunks, so superseding an
  // unacked chunk with a later one drops text from the middle of the draft.
  // A reconnecting Arm is re-seeded by its subscription snapshot instead.
  if (msg.type === 'card_action' && msg.sessionId) {
    return `card_action:${msg.sessionId}`;
  }
  if (msg.type === 'compacting' && msg.sessionId) {
    return `compacting:${msg.sessionId}`;
  }
  return undefined;
}

/**
 * Whether to follow a relay's `wrong_region` redirect. From an official
 * relay only to another official one (`wss://kraki.chat` or a subdomain); a
 * self-hosted relay may send its users elsewhere, but only over TLS (plain
 * `ws://` only to this machine). The computer authenticates at the redirect
 * target, so a hostile redirect would hand its connection to anyone.
 */
export function isAcceptableRegionRedirect(current: string, redirect: string): boolean {
  let to: URL;
  let from: URL | null = null;
  try { to = new URL(redirect); } catch { return false; }
  try { from = new URL(current); } catch { /* unknown current relay */ }
  const official = (u: URL) => u.hostname === 'kraki.chat' || u.hostname.endsWith('.kraki.chat');
  const loopback = (u: URL) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (to.protocol !== 'wss:' && !(to.protocol === 'ws:' && loopback(to))) return false;
  if (from && official(from)) return to.protocol === 'wss:' && official(to);
  return true;
}
