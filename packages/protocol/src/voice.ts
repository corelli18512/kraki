// ============================================================
// Voice broker — lease auth types
// ============================================================
// Head issues leases; the voice broker verifies them offline.
// Types only. Canonical serialization lives in @kraki/crypto; runtime validation in the consumers.
// ============================================================

/** Lease payload schema version. Head and broker both pin this literal. */
export type VoiceLeaseVersion = 1;

/** Backend service the lease grants access to. Becomes a union when more backends are added. */
export type VoiceResource = 'voice/doubao';

/** Issuer identity. Currently only Head. */
export type VoiceLeaseIssuer = 'kraki-head';

/** Why a lease request was denied. */
export type VoiceLeaseDeniedReason =
  | 'quota_exhausted'
  | 'not_entitled'
  | 'invalid_request';

/** Signed lease payload. One lease authorizes one short-lived warm voice connection. */
export interface VoiceLeasePayload {
  /** Schema version. */
  ver: VoiceLeaseVersion;
  /** Issuer — currently always 'kraki-head'. */
  iss: VoiceLeaseIssuer;
  /** Subject — id of the user who owns the lease. */
  sub: string;
  /** Device id — the device the lease is bound to. */
  did: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expires-at, unix seconds. */
  exp: number;
  /** Cumulative audio seconds shared by all sequential recordings during this lease's lifetime. */
  quota_seconds: number;
  /** Backend service being authorized. */
  resource: VoiceResource;
  /** Unique lease id (uuid); the key for a future revocation list. */
  jti: string;
}

/** Signed lease wire format. */
export interface VoiceLease {
  payload: VoiceLeasePayload;
  /** Base64 RSA-SHA256 (PKCS#1 v1.5) signature over the payload's canonical JSON. */
  signature: string;
  /**
   * Signing algorithm identifier. Today always `'RSA-SHA256'` — future
   * algorithm rotations bump the protocol minor version and add a new
   * literal here so verifiers can refuse unknown algs explicitly.
   */
  alg: 'RSA-SHA256';
}

// ============================================================
// Capability advertisement — handshake-time
// ============================================================

/**
 * head → arm: voice dictation capability for this region. Sent inside
 * `auth_ok.voice` when the head is configured with a broker URL.
 *
 * Absence of this field means voice is not available in this region — arm
 * should hide the mic UI rather than probe with `request_voice_lease`.
 *
 * Why advertise at handshake (instead of letting arm discover via the
 * reactive `voice_lease_denied: not_entitled` path):
 *   1. UI can render the correct affordance from the first frame.
 *   2. No "blind probe" — arm doesn't speculatively request a lease.
 *   3. Each region (main / edge) advertises its own broker independently,
 *      so the multi-region story stays local: edge head config decides.
 */
export interface VoiceCapability {
  /**
   * Public WSS URL of the voice broker for this region (e.g.
   * `wss://cn.stt.kraki.chat/voice`). arm connects directly here after
   * obtaining a lease via `request_voice_lease`.
   */
  brokerUrl: string;
  /** Resource id arm should pass when calling `request_voice_lease`. */
  resource: VoiceResource;
}

// ============================================================
// WebSocket messages — arm ↔ head
// ============================================================

/** arm → head: request a new lease over the authenticated Head WebSocket. */
export interface RequestVoiceLeaseMessage {
  type: 'request_voice_lease';
  /** Requesting device id; the lease is bound to it. */
  deviceId: string;
  /** Which backend it is for. */
  resource: VoiceResource;
}

/** head → arm: success — a freshly signed lease. */
export interface VoiceLeaseGrantMessage {
  type: 'voice_lease_grant';
  lease: VoiceLease;
}

/** head → arm: denied — over quota, not entitled, etc. */
export interface VoiceLeaseDeniedMessage {
  type: 'voice_lease_denied';
  reason: VoiceLeaseDeniedReason;
  /** Human-readable detail for logs/UI. */
  detail?: string;
}

// ============================================================
// arm ↔ voice-broker — warm connection + sequential recordings
// ============================================================

/** Connection-level authorization right after the WebSocket opens; then start/finish may repeat. */
export interface VoiceAuthorizeMessage {
  type: 'authorize';
  /** User/device fields are checked against the signed lease for diagnostics. */
  uid?: string;
  deviceId?: string;
  /** Product authorization remains opaque to the generic voice gateway. */
  authorization: VoiceLease;
}

/** Broker acknowledgement of connection-level authorization. */
export interface VoiceAuthorizedMessage {
  type: 'authorized';
}

/** Start of one recording; the lease was already verified by `authorize` on this WebSocket. */
export interface VoiceStartMessage {
  type: 'start';
  /** User id (informational; truth comes from the authorized lease). */
  uid?: string;
  /** Arm device id (informational; truth comes from the authorized lease). */
  deviceId?: string;
  /** PCM stream sample rate. Default 16000. */
  sampleRate?: number;
}
