/**
 * Trace ring buffer for latency debugging.
 *
 * Purpose: capture μs-level timestamps at every message-pipeline boundary so
 * end-to-end latency (input → WS → head → tentacle → agent → back) can be
 * bisected across processes. Correlated with tentacle's `pulse-trace.log` and
 * head's trace via (seq, len, sessionId, clientId).
 *
 * Zero-cost when disabled: reads `localStorage['kraki_pulse_trace']` once at
 * module load; if not set, `traceEvent()` is a no-op.
 *
 * Enable in browser: `localStorage.setItem('kraki_pulse_trace','1');reload()`
 * Dump the ring in DevTools console: `copy(JSON.stringify(window._pulseTrace))`
 */

const MAX_EVENTS = 5000;

interface TraceEvent {
  /** Monotonic-clock milliseconds since navigation start (sub-ms precision). */
  t: number;
  /** Wall-clock ms (Date.now()) so we can align with tentacle's log. */
  wallMs: number;
  /** Component: 'arm' | 'head' | 'tentacle'. */
  comp: string;
  /** Event name (e.g. PULSE-SEND, PULSE-TX, WS-RX, APP-OUT). */
  evt: string;
  /** Sequence, correlation id, size etc. — every extra field the call passes. */
  [k: string]: unknown;
}

function checkEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('kraki_pulse_trace') === '1';
  } catch {
    return false;
  }
}

let enabled = checkEnabled();
const buffer: TraceEvent[] = [];

// Expose to the window so playwright / devtools can pull it.
if (typeof window !== 'undefined') {
  (window as unknown as { _pulseTrace: TraceEvent[]; _pulseTraceClear: () => void; _pulseTraceEnable: () => void; _pulseTraceDisable: () => void }).
    _pulseTrace = buffer;
  (window as unknown as { _pulseTraceClear: () => void })._pulseTraceClear = () => { buffer.length = 0; };
  (window as unknown as { _pulseTraceEnable: () => void })._pulseTraceEnable = () => {
    try { localStorage.setItem('kraki_pulse_trace', '1'); } catch { /* ignore */ }
    enabled = true;
  };
  (window as unknown as { _pulseTraceDisable: () => void })._pulseTraceDisable = () => {
    try { localStorage.removeItem('kraki_pulse_trace'); } catch { /* ignore */ }
    enabled = false;
  };
}

export function traceEvent(fields: Omit<TraceEvent, 't' | 'wallMs'>): void {
  if (!enabled) return;
  buffer.push({
    t: performance.now(),
    wallMs: Date.now(),
    ...fields,
  });
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
}
