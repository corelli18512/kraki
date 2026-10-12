/** Evicting idle Copilot sessions to keep the runtime's memory in check. */

import { execSync } from 'node:child_process';
import { CopilotAdapter } from './copilot.js';
import { logger } from './copilot-session.js';

/**
 * Sum RSS (MB) of this process plus every descendant. The real memory
 * consumer is the native `copilot-darwin-arm64` grandchild, not the
 * daemon's Node heap — so we walk the whole tree and report the total.
 *
 * Returns null on Windows (no pgrep) or when the descendant walk fails;
 * callers treat null as "skip eviction this cycle" (fail-safe).
 */
export function getRuntimeRssMB(adapter: CopilotAdapter): number | null {
  if (process.platform === 'win32') return null;
  const descendants: number[] = [];
  const queue: number[] = [process.pid];
  while (queue.length) {
    const pid = queue.shift()!;
    try {
      const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      if (!out) continue;
      for (const line of out.split('\n')) {
        const child = parseInt(line, 10);
        if (!isNaN(child)) {
          descendants.push(child);
          queue.push(child);
        }
      }
    } catch { /* pgrep exits non-zero when no children — normal */ }
  }
  if (descendants.length === 0) return 0;
  try {
    const out = execSync(`ps -o rss= -p ${descendants.join(',')}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const kb = out.split('\n')
      .map((s) => parseInt(s.trim(), 10))
      .reduce((acc, v) => acc + (isNaN(v) ? 0 : v), 0);
    return Math.round(kb / 1024);
  } catch {
    return null;
  }
}

export function startEvictionSweep(adapter: CopilotAdapter): void {
  if (adapter.evictionTimer) return;
  adapter.evictionTimer = setInterval(() => {
    evictIdleSessions(adapter).catch((err) => {
      logger.warn({ err }, 'eviction sweep threw');
    });
  }, CopilotAdapter.EVICTION_SCAN_INTERVAL_MS);
  // Don't block process exit on the timer
  adapter.evictionTimer.unref?.();
}

export function stopEvictionSweep(adapter: CopilotAdapter): void {
  if (adapter.evictionTimer) {
    clearInterval(adapter.evictionTimer);
    adapter.evictionTimer = null;
  }
}

/**
 * Periodic sweep: if total runtime RSS is over threshold, evict any
 * loaded session that has been quiet > IDLE_TTL_MS and is safe to drop
 * (not mid-turn, no pending permission/question).
 *
 * Eviction is purely a memory hygiene operation; the user-visible session
 * is unaffected because the next interaction triggers lazy resume.
 */
export async function evictIdleSessions(adapter: CopilotAdapter): Promise<void> {
  if (adapter.sessions.size === 0) return;
  const rssMB = getRuntimeRssMB(adapter);
  if (rssMB === null || rssMB < CopilotAdapter.EVICTION_RSS_THRESHOLD_MB) {
    // Under the threshold (or measurement unavailable) — do nothing.
    // This is deliberately adaptive: when memory is fine, never evict.
    return;
  }

  const now = Date.now();
  const ttl = CopilotAdapter.EVICTION_IDLE_TTL_MS;
  const candidates: string[] = [];
  for (const [sessionId, entry] of adapter.sessions) {
    if (entry.pendingPermissions.size > 0 || entry.pendingQuestions.size > 0) continue;
    // turnHasOutput.get(sessionId) === true => a turn is currently in flight
    if (adapter.turnHasOutput.get(sessionId)) continue;
    const lastAt = adapter.lastActivityAt.get(sessionId) ?? 0;
    if (now - lastAt < ttl) continue;
    candidates.push(sessionId);
  }
  if (candidates.length === 0) {
    logger.info({ rssMB, loaded: adapter.sessions.size }, 'eviction: over threshold but no eligible candidates');
    return;
  }
  logger.info(
    { rssMB, threshold: CopilotAdapter.EVICTION_RSS_THRESHOLD_MB, candidates: candidates.length, loaded: adapter.sessions.size },
    'eviction: sweeping idle sessions',
  );
  for (const sessionId of candidates) {
    await evictSession(adapter, sessionId);
  }
}

/**
 * Release an idle SDK session handle so the runtime can reclaim its
 * memory. The on-disk session is intact; lazy resume picks it up on
 * next interaction. Fires {@link onSessionEvicted} so the relay-client
 * can mark the meta state `disconnected` for invariant consistency.
 */
export async function evictSession(adapter: CopilotAdapter, sessionId: string): Promise<void> {
  const entry = adapter.sessions.get(sessionId);
  if (!entry) return;
  try {
    await entry.session.disconnect();
  } catch (err) {
    logger.warn({ err, sessionId }, 'evictSession: disconnect failed, removing entry anyway');
  }
  adapter.sessions.delete(sessionId);
  adapter.lastActivityAt.delete(sessionId);
  // Note: we intentionally do NOT clear sessionModes / sessionUsage /
  // expectedModels — those represent persistent per-session preferences
  // that should survive the unload/reload cycle.
  logger.info({ sessionId }, 'session evicted from runtime (idle, over RSS threshold)');
  adapter.onSessionEvicted?.(sessionId);
}

export function touchSession(adapter: CopilotAdapter, sessionId: string): void {
  adapter.lastActivityAt.set(sessionId, Date.now());
}
