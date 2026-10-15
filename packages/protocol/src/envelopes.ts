// Relay envelopes: what the relay sees (unicast/multicast/broadcast, pulse frames, ping/pong) and the head control types.

// ============================================================
// Relay envelopes (visible to relay)
// ============================================================

/** Per-hop pulse framing (visible to the relay, like a WS frame header).
 *
 *  When present, this envelope is carried by the pulse reliable-delivery layer
 *  (pulse = a reliable WebSocket replacement). `pulse` holds the base64 of the
 *  COMPLETE pulse wire frame, whose payload segment is the E2E ciphertext. The
 *  relay — itself a pulse endpoint on each hop — decodes the frame to read
 *  seq / ack / durable / hello / resend and to route, ack, and durably store;
 *  it treats the frame's payload segment as opaque bytes it never decrypts.
 *
 *  The ciphertext lives INSIDE the pulse frame (not in `blob`) so that pulse's
 *  own outbox, resume, and durable persistence carry it. `keys` (per-recipient
 *  wrapped AES keys) stays an envelope field because the relay reads it for
 *  fan-out and the recipient needs it to decrypt. For a pulse-carried envelope,
 *  `blob` is unused (empty string); the payload is in `pulse`.
 *
 *  Absent ⇒ legacy fire-and-forget path (`blob`/`keys` as before). Peers that
 *  don't speak pulse simply never set it. */
export interface PulseFrameField {
  /** base64 of the complete pulse wire frame (header + payload; the payload
   *  segment is the E2E ciphertext, opaque to the relay). */
  pulse?: string;
}

/** Reserved pulse routing target meaning "deliver to the head (relay) itself"
 *  rather than forward to a device. A pulse frame addressed here carries
 *  PLAINTEXT control JSON (update_preferences / remove_device /
 *  (un)register_push_token) — the head is the legitimate recipient, so there is
 *  no E2E on this hop and the payload is NOT an E2E {blob,keys}. The `@` prefix
 *  cannot collide with a real deviceId (which are `dev_`/`app_`-prefixed or a
 *  uuid, never `@`-prefixed). */
export const HEAD_PULSE_TARGET = '@head';

/**
 * Message types the head itself sends to a device as `{from:'@head', msg}` over
 * pulse. These are the ONLY types a receiver may act on from that wrapper: the
 * wrapper is plaintext, so anything else (auth_*, consumer/producer messages)
 * arriving this way is forged and must be dropped. Auth frames are accepted only
 * from the raw socket during the handshake.
 */
export const HEAD_CONTROL_TYPES: ReadonlySet<string> = new Set([
  'device_joined',
  'device_left',
  'device_removed',
  'device_pending',
  'preferences_updated',
  'push_token_registered',
  'notification_preview',
  'voice_lease_grant',
  'voice_lease_denied',
  'voice_vocabulary_updated',
]);

/**
 * Field the head stamps onto every device-originated pulse payload it forwards:
 * the authenticated deviceId of the connection that sent it. Devices cannot set
 * it themselves (the head drops any device payload that already carries `src`
 * or `from`), so receivers may trust it as the real sender. Absent when the
 * payload came through an older head.
 */
export const PULSE_SENDER_FIELD = 'src';

/** App → specific tentacle. Relay reads `to` for routing. */
export interface UnicastEnvelope extends PulseFrameField {
  type: 'unicast';
  /** Target device ID */
  to: string;
  /** Encrypted payload: base64(iv + ciphertext + tag) */
  blob: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
  /** Optional reference ID, echoed back in server_error responses */
  ref?: string;
}

/** Tentacle → explicit same-user app target set. Relay reads only `to` for routing. */
export interface MulticastEnvelope extends PulseFrameField {
  type: 'multicast';
  /** Explicit target device IDs. Must be non-empty after de-duplication. */
  to: string[];
  /** Unused in pulse mode; ciphertext is inside the pulse DATA payload. */
  blob: string;
  /** Unused in pulse mode; recipient keys are inside the pulse DATA payload. */
  keys: Record<string, string>;
  /** Optional reference ID, echoed back in server_error responses. */
  ref?: string;
}

/** Tentacle → all devices. Relay broadcasts to all other devices under the user. */
export interface BroadcastEnvelope extends PulseFrameField {
  type: 'broadcast';
  /** Encrypted payload: base64(iv + ciphertext + tag) */
  blob: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
  /** Encrypted preview for push notifications to offline devices.
   *  Presence signals the relay to send a push. Contains a truncated
   *  summary encrypted with the same recipients as the main blob. */
  pushPreview?: BlobPayload;
}

export type RelayEnvelope = UnicastEnvelope | MulticastEnvelope | BroadcastEnvelope;

/** Encrypted blob payload — shared between crypto and app layers. */
export interface BlobPayload {
  /** base64(iv ‖ ciphertext ‖ tag) */
  blob: string;
  /** Per-recipient RSA-OAEP encrypted AES key (base64), keyed by deviceId */
  keys: Record<string, string>;
}

/** Ping / pong control messages for connection keepalive. */
export interface PingMessage {
  type: 'ping';
  /** App is actually foreground now. Best-effort raw WS only, never queued.
   * Head records one account/Beijing-date for product usage, not diagnostics. */
  foreground?: boolean;
}

export interface PongMessage {
  type: 'pong';
}
