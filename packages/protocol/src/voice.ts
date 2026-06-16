// ============================================================
// Voice broker — lease auth types
// ============================================================
// head 签发 lease, voice-broker 离线验证。
// 这里只放类型。canonical 序列化在 @kraki/crypto，运行时校验在使用方。
// ============================================================

/** lease payload schema 版本。head 和 broker 同时 pin 这个 literal。 */
export type VoiceLeaseVersion = 1;

/** lease 授权访问的后端服务。未来加新后端时扩成 union。 */
export type VoiceResource = 'voice/doubao';

/** 签发方身份。目前只有 head。 */
export type VoiceLeaseIssuer = 'kraki-head';

/** lease 拒发原因。 */
export type VoiceLeaseDeniedReason =
  | 'quota_exhausted'
  | 'not_entitled'
  | 'invalid_request';

/** lease 的签名 payload。一个 lease = 一份 payload + 一段签名。 */
export interface VoiceLeasePayload {
  /** Schema version. */
  ver: VoiceLeaseVersion;
  /** Issuer — 目前固定 'kraki-head'。 */
  iss: VoiceLeaseIssuer;
  /** Subject — 拥有该 lease 的用户 id。 */
  sub: string;
  /** Device id — lease 绑定到的具体设备。 */
  did: string;
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expires-at, unix seconds. */
  exp: number;
  /** 本 lease 允许的音频秒数。broker 按 session 扣。 */
  quota_seconds: number;
  /** 授权访问的后端服务。 */
  resource: VoiceResource;
  /** lease 唯一 id (uuid)。未来撤销列表的 key。 */
  jti: string;
}

/** 签好的 lease wire 格式。 */
export interface VoiceLease {
  payload: VoiceLeasePayload;
  /** Base64 RSA-SHA256 (PKCS#1 v1.5) 签名，对 payload 的 canonical JSON。 */
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

/** arm → head: 取一张新 lease。走的是已认证的 head WS。 */
export interface RequestVoiceLeaseMessage {
  type: 'request_voice_lease';
  /** 请求方设备 id。lease 会绑到这个 id。 */
  deviceId: string;
  /** 用于哪个后端。 */
  resource: VoiceResource;
}

/** head → arm: 成功 — 一张新签的 lease。 */
export interface VoiceLeaseGrantMessage {
  type: 'voice_lease_grant';
  lease: VoiceLease;
}

/** head → arm: 拒绝 — 超额、无权限等。 */
export interface VoiceLeaseDeniedMessage {
  type: 'voice_lease_denied';
  reason: VoiceLeaseDeniedReason;
  /** 给日志/UI 看的可读细节。 */
  detail?: string;
}

// ============================================================
// arm ↔ voice-broker — start 消息扩展
// ============================================================

/** broker 入口握手。BROKER_DEV_NO_AUTH=1 时 lease 可省；否则必传。 */
export interface VoiceStartMessage {
  type: 'start';
  /** User id (informational; 真相来自 lease.sub)。 */
  uid?: string;
  /** Arm 的设备 id (必须等于 lease.did)。 */
  deviceId?: string;
  /** PCM 流采样率。默认 16000。 */
  sampleRate?: number;
  /** 已签 lease — 非 dev-no-auth 模式下必传。 */
  lease?: VoiceLease;
}
