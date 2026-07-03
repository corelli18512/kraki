/**
 * Kraki integration helpers — the thin envelope that carries a pulse frame
 * inside Kraki's E2E ciphertext, plus the reliable-type predicate.
 *
 * This is the ONE place tentacle and arm agree on framing, so they stay
 * byte-compatible. It is Kraki-aware glue that lives adjacent to the neutral
 * core — the core itself (Endpoint/wire) still knows nothing about Kraki.
 */

import { decodeFrame, encodeFrame, type Frame } from './wire.js';

/**
 * Message types that must be delivered reliably (survive disconnect/reconnect).
 * Mirrors tentacle's PERSISTENT_TYPES plus the arm→tentacle control messages
 * that block the user if lost. Everything else (deltas, active, session_list,
 * attachment_data, greetings, pings) keeps the existing fire-and-forget path.
 */
export const RELIABLE_TYPES: ReadonlySet<string> = new Set([
  // producer (tentacle → arm)
  'session_created',
  'session_ended',
  'session_deleted',
  'agent_message',
  'user_message',
  'permission',
  'permission_resolved',
  'question',
  'question_resolved',
  'tool_start',
  'tool_complete',
  'error',
  'idle',
  // consumer (arm → tentacle) — losing these strands the user
  'send_input',
  'approve',
  'deny',
  'always_allow',
  'answer',
  'create_session',
  'fork_session',
  'kill_session',
  'abort_session',
  'set_session_mode',
  'delete_session',
]);

export function isReliableType(type: unknown): boolean {
  return typeof type === 'string' && RELIABLE_TYPES.has(type);
}

/** The decrypted plaintext shape when a message rides the pulse layer. */
export interface PulseEnvelope {
  kind: 'pulse';
  /** deviceId of the endpoint stream this frame belongs to (the sender). */
  src: string;
  /** base64 of the pulse wire frame. */
  frame: string;
}

const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(u).toString('base64');
};
const unb64 = (s: string): Uint8Array => {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
};

/** Wrap a pulse frame as the JSON plaintext that Kraki will then encrypt. */
export function packPulsePlaintext(src: string, frame: Uint8Array): string {
  const env: PulseEnvelope = { kind: 'pulse', src, frame: b64(frame) };
  return JSON.stringify(env);
}

/** If a decrypted plaintext is a pulse envelope, return {src, frame}; else null. */
export function tryUnpackPulse(plaintext: string): { src: string; frame: Uint8Array } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { kind?: unknown }).kind === 'pulse' &&
    typeof (parsed as PulseEnvelope).src === 'string' &&
    typeof (parsed as PulseEnvelope).frame === 'string'
  ) {
    return { src: (parsed as PulseEnvelope).src, frame: unb64((parsed as PulseEnvelope).frame) };
  }
  return null;
}

/** Encode a Kraki payload string as a pulse DATA-carrying frame's payload bytes. */
export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function fromUtf8(u: Uint8Array): string {
  return new TextDecoder().decode(u);
}

// Re-export for callers that want the raw codec too.
export { decodeFrame, encodeFrame, type Frame };
