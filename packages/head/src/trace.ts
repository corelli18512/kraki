/**
 * Head pulse-trace — structured JSONL trace for the relay hop, gated behind
 * `KRAKI_TRACE_PULSE=1`. OFF by default; zero cost on the hot path when off.
 *
 * Why this exists: every pulse-related prod outage so far (16s/frame latency,
 * OOM, event-loop stall, push-preview key miss) happened IN head, but head had
 * NO trace instrumentation — only arm (in-browser ring) and tentacle
 * (KRAKI_TRACE_PULSE) did. So bisecting "where did this message stall / get
 * dropped / OOM" across hops was impossible from head's side. This closes that
 * gap so all three hops can be correlated by (wallMs, fp, innerSeq, deviceId).
 *
 * Correlation keys:
 *  - wallMs   — Date.now() ms, aligns with arm/tentacle logs.
 *  - fp       — 64-byte djb2-ish hash of the pulse payload segment ({blob,keys}
 *               JSON is byte-identical across hops; head computes it here).
 *  - innerSeq — the tentacle-assigned ProducerMessage.seq (head can't read it
 *               since it's inside the E2E ciphertext, but arm/tentacle report
 *               it; head emits its own per-endpoint pulse `seq` instead).
 *  - deviceId  — the source/dest endpoint identity.
 *
 * Output: stdout (lands in journald on the prod systemd unit), one JSON object
 * per line, prefixed with ` TRACE ` so it's greppable but compact. Enable with
 * `KRAKI_TRACE_PULSE=1` in /etc/kraki/relay.env + `systemctl restart`.
 */

const TRACE_ENABLED = process.env.KRAKI_TRACE_PULSE === '1';

/** Cheap payload fingerprint (mirrors tentacle-pulse.ts `fp`). Same hash so a
 *  blob produced by tentacle and forwarded by head shares an fp across logs. */
export function fp(u: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < Math.min(64, u.length); i++) h = ((h << 5) - h + u[i]) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function isTraceEnabled(): boolean {
  return TRACE_ENABLED;
}

/** Emit one trace line. No-op when trace is off (checked once at module load). */
export function trace(evt: string, fields: Record<string, unknown> = {}): void {
  if (!TRACE_ENABLED) return;
  const line = JSON.stringify({
    t: Date.now(),
    comp: 'head',
    evt,
    ...fields,
  });
  // stdout → journald on the prod unit (StandardOutput=journal). Keep it a
  // single line so `journalctl -u kraki-relay | grep TRACE` works.
  process.stdout.write(` TRACE ${line}\n`);
}
