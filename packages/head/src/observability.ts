/**
 * Operational HTTP endpoints of the relay.
 *
 * - `GET /health/ready` (public): ready to serve, not just running. Checks the
 *   database answers, the 30 s health tick is alive (event loop not stuck),
 *   and the configured push providers are loaded. 200 when ready, 503 when
 *   not; the body names the failed check, never any user data.
 * - `GET /internal/metrics` (loopback only): counters and timings for
 *   kraki-watch. Refused when the request came through a reverse proxy
 *   (any forwarding header) or from a non-loopback address.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { metrics } from './metrics.js';

export interface ReadinessContext {
  version: string;
  startedAt: number;
  /** Runs a trivial query; throws when the database is unusable. */
  pingDatabase: () => void;
  /** Push providers the relay was configured with (env PUSH_PROVIDERS). */
  expectedPushProviders: string[];
  /** Push providers actually loaded. */
  loadedPushProviders: () => string[];
  /** Live gauges for the metrics endpoint. */
  gauges: () => Record<string, number>;
  /** The health tick runs every 30 s; older than this means the loop is stuck. */
  maxHealthAgeMs?: number;
}

export function readiness(ctx: ReadinessContext, now = Date.now()): { ok: boolean; checks: Record<string, string> } {
  const checks: Record<string, string> = {};
  try {
    ctx.pingDatabase();
    checks.database = 'ok';
  } catch {
    checks.database = 'fail';
  }
  const last = metrics().lastHealthAt;
  const maxAge = ctx.maxHealthAgeMs ?? 90_000;
  // Before the first tick (first 30 s after start) the loop is judged by uptime.
  checks.eventLoop = (last ?? ctx.startedAt) >= now - maxAge ? 'ok' : 'fail';
  const loaded = new Set(ctx.loadedPushProviders());
  const missing = ctx.expectedPushProviders.filter((p) => !loaded.has(p));
  checks.push = missing.length === 0 ? 'ok' : `fail:${missing.join(',')}`;
  return { ok: Object.values(checks).every((v) => v === 'ok'), checks };
}

const FORWARDING_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'cf-connecting-ip'];

export function isDirectLoopback(req: IncomingMessage): boolean {
  if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Handles the two endpoints; returns false for any other path. */
export function handleObservability(req: IncomingMessage, res: ServerResponse, ctx: ReadinessContext): boolean {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health/ready') {
    const result = readiness(ctx);
    res.writeHead(result.ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      status: result.ok ? 'ready' : 'not_ready',
      version: ctx.version,
      uptimeSec: Math.floor((Date.now() - ctx.startedAt) / 1000),
      checks: result.checks,
    }));
    return true;
  }
  if (path === '/internal/metrics') {
    if (!isDirectLoopback(req)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ version: ctx.version, ...metrics().snapshot(), gauges: ctx.gauges(), ready: readiness(ctx) }));
    return true;
  }
  return false;
}
