/**
 * Pick the fastest relay region for a new account by measuring, not guessing.
 *
 * 1. Ask the main server for the CURRENT region list (`GET /api/regions`);
 *    regions come and go, so nothing is hard-coded here.
 * 2. Open a real WebSocket to every region at once, through exactly the path
 *    the daemon will use later (system/env proxy or direct), and send a few
 *    WebSocket ping frames. The relay answers pings at the protocol level,
 *    before any sign-in.
 * 3. The region with the lowest median pong round trip wins. Unreachable
 *    regions are skipped; if none answers, the caller lets the server decide.
 *
 * The result is sent as `preferredRegion` at sign-up. A region is assigned
 * once per account, so this only matters the first time.
 */

import WebSocket from 'ws';
import { wsProxyOptions, proxyFor } from './proxy.js';

export interface RegionEntry {
  code: string;
  relayUrl: string;
  displayName?: string;
}

export interface RegionMeasurement {
  code: string;
  relayUrl: string;
  /** Time to an open WebSocket (DNS + TCP + TLS + upgrade, via proxy if any). */
  connectMs?: number;
  /** Median ping→pong round trip on the open socket. */
  medianRttMs?: number;
  samplesMs: number[];
  proxied: boolean;
  error?: string;
}

export interface ProbeResult {
  /** Fastest reachable region, or undefined when none answered. */
  best?: string;
  measurements: RegionMeasurement[];
  listVersion?: number;
  totalMs: number;
}

export interface ProbeOptions {
  /** Ping frames per region (default 5). */
  pings?: number;
  /** Gap between pings (default 60 ms). */
  intervalMs?: number;
  /** Give up on a region after this long (default 4 s). */
  timeoutMs?: number;
  /** Ignore the proxy and connect directly (comparison only). */
  direct?: boolean;
  fetchRegions?: (apiBase: string) => Promise<{ version?: number; regions: RegionEntry[] }>;
  openSocket?: (url: string, direct: boolean) => WebSocket;
  now?: () => number;
}

export async function fetchRegionList(apiBase: string): Promise<{ version?: number; regions: RegionEntry[] }> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/regions`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`regions: HTTP ${res.status}`);
  const body = await res.json() as { version?: number; regions?: RegionEntry[] };
  const regions = (body.regions ?? []).filter(
    (r) => typeof r?.code === 'string' && typeof r?.relayUrl === 'string' && /^wss?:\/\//.test(r.relayUrl),
  );
  return { version: body.version, regions };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function measureRegion(region: RegionEntry, opts: ProbeOptions = {}): Promise<RegionMeasurement> {
  const pings = opts.pings ?? 5;
  const intervalMs = opts.intervalMs ?? 60;
  const timeoutMs = opts.timeoutMs ?? 4_000;
  const direct = opts.direct ?? false;
  const now = opts.now ?? (() => performance.now());
  const open = opts.openSocket ?? ((url: string, d: boolean) => new WebSocket(url, d ? {} : wsProxyOptions(url)));
  const proxied = !direct && proxyFor(region.relayUrl) !== undefined;

  return new Promise((resolve) => {
    const started = now();
    const samples: number[] = [];
    let connectMs: number | undefined;
    let sentAt = 0;
    let sent = 0;
    let done = false;
    let ws: WebSocket;
    let gap: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (gap) clearTimeout(gap);
      try { ws.terminate(); } catch { /* already closed */ }
      resolve({
        code: region.code,
        relayUrl: region.relayUrl,
        connectMs,
        medianRttMs: samples.length > 0 ? Math.round(median(samples) * 10) / 10 : undefined,
        samplesMs: samples.map((s) => Math.round(s * 10) / 10),
        proxied,
        ...(samples.length === 0 && { error: error ?? 'no answer' }),
      });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    const ping = () => {
      sentAt = now();
      sent += 1;
      try { ws.ping(); } catch (err) { finish((err as Error).message); }
    };

    try {
      ws = open(region.relayUrl, direct);
    } catch (err) {
      finish((err as Error).message);
      return;
    }
    ws.on('open', () => {
      connectMs = Math.round(now() - started);
      ping();
    });
    ws.on('pong', () => {
      samples.push(now() - sentAt);
      if (sent >= pings) finish();
      else gap = setTimeout(ping, intervalMs);
    });
    ws.on('error', (err) => finish(err.message));
    ws.on('close', () => finish('closed'));
  });
}

/** Measure every region of the current list in parallel and pick the fastest. */
export async function probeRegions(apiBase: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const { version, regions } = await (opts.fetchRegions ?? fetchRegionList)(apiBase);
  const measurements = await Promise.all(regions.map((r) => measureRegion(r, opts)));
  const reachable = measurements.filter((m) => m.medianRttMs !== undefined);
  // Ties within 10% keep the server's order (its default region comes first).
  let best: RegionMeasurement | undefined;
  for (const m of reachable) {
    if (!best || m.medianRttMs! < best.medianRttMs! * 0.9) best = m;
  }
  return { best: best?.code, measurements, listVersion: version, totalMs: Math.round(now() - started) };
}
