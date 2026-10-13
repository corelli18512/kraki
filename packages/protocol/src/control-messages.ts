// Control messages (device ↔ relay, unencrypted): auth, pairing, devices, account, preferences, Custom Words, push tokens; and the ControlMessage union.

import type { DeviceSummary, DeviceInfo } from './devices.js';
import type { VoiceCapability } from './voice.js';
import { type AuthMethod } from './auth-methods.js';
import { type BlobPayload } from './envelopes.js';

// ============================================================
// Control messages (device ↔ relay, unencrypted)
// ============================================================

export interface AuthMessage {
  type: 'auth';
  auth: AuthMethod;
  device: DeviceInfo;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  deviceId: string;
  /** The auth method that was used */
  authMethod: AuthMethod['method'];
  user: { id: string; login: string; provider: string; email?: string; preferences?: Record<string, unknown>; region?: string };
  /** The account's Custom Words (app devices only). Presence also advertises
   *  sync support. */
  voiceVocabulary?: VoiceWord[];
  devices: DeviceSummary[];
  /** GitHub OAuth client ID (present when GitHub OAuth is configured for web login) */
  githubClientId?: string;
  /** VAPID public key for Web Push (present when web_push is enabled) */
  vapidPublicKey?: string;
  /** Relay server version */
  relayVersion?: string;
  /**
   * Voice dictation capability for this region. Absent when the head has
   * no voice broker configured — arm should hide the mic UI in that case.
   * See `VoiceCapability` for the contract.
   */
  voice?: VoiceCapability;
  /**
   * The relay acknowledges inbound Pulse data at least every this many bytes
   * (instead of only on outbound traffic or idle heartbeats), so a client may
   * pace large uploads by acknowledgements. Absent on older relays.
   */
  pulseAckBytes?: number;
}

export type AuthErrorCode =
  | 'auth_rejected'
  | 'auth_unavailable'
  | 'service_unavailable'
  | 'unknown_auth_method'
  | 'pairing_disabled'
  | 'invalid_pairing_token'
  | 'unknown_device'
  | 'no_pending_challenge'
  | 'device_not_found'
  | 'invalid_signature'
  | 'user_not_found'
  | 'device_registration_failed'
  | 'account_deleted'
  | 'wrong_region';

export interface AuthErrorMessage {
  type: 'auth_error';
  /** Machine-readable auth failure reason for client behavior */
  code: AuthErrorCode;
  message: string;
  /** When code is 'wrong_region', the correct relay URL to connect to */
  redirect?: string;
}

export interface AuthChallengeMessage {
  type: 'auth_challenge';
  nonce: string;
}

export interface AuthResponseMessage {
  type: 'auth_response';
  deviceId: string;
  signature: string;
}

export interface ServerErrorMessage {
  type: 'server_error';
  message: string;
  /** Echoed from UnicastEnvelope.ref if present */
  ref?: string;
}

/** One-shot pairing token request — no device registration needed */
export interface RequestPairingTokenMessage {
  type: 'request_pairing_token';
  /** Auth token (e.g. GitHub token) to prove identity */
  token: string;
}

export interface PairingTokenCreatedMessage {
  type: 'pairing_token_created';
  token: string;
  expiresIn: number;
}

export interface CreatePairingTokenMessage {
  type: 'create_pairing_token';
}

/** Pre-auth request to discover server capabilities. */
export interface AuthInfoRequest {
  type: 'auth_info';
}

/** Server response with supported auth methods and features. */
export interface AuthInfoResponse {
  type: 'auth_info_response';
  /** Supported auth methods (e.g. ['github_token', 'github_oauth', 'pairing']) */
  methods: AuthMethod['method'][];
  /** GitHub OAuth client ID (present when github_oauth is available) */
  githubClientId?: string;
  /** VAPID public key for Web Push (present when web_push is enabled) */
  vapidPublicKey?: string;
}

/** Sent to all connected devices when a new device joins the user's account. */
export interface DeviceJoinedMessage {
  type: 'device_joined';
  device: DeviceSummary;
}

/** Sent to all connected devices when a device disconnects. */
export interface DeviceLeftMessage {
  type: 'device_left';
  deviceId: string;
}

/** Sent to all connected devices when a device's liveness is uncertain
 *  (ping sent but pong not yet received within the grace period).
 *  Transient: will be followed by either device_joined (recovered)
 *  or device_left (terminated). */
export interface DevicePendingMessage {
  type: 'device_pending';
  deviceId: string;
}

/** Request to remove an offline device from the user's account. */
export interface RemoveDeviceMessage {
  type: 'remove_device';
  deviceId: string;
}

/**
 * App → head: permanently delete this Kraki account (App Store 5.1.1(v)).
 * The relay deletes the user, every device, push tokens, preferences, custom
 * words and voice usage, then sends `account_deleted` to every connected
 * device and closes it. Only devices with role `app` may ask.
 */
export interface DeleteAccountMessage {
  type: 'delete_account';
}

/**
 * Head → every device of a deleted account (raw WebSocket, right before the
 * relay closes the socket with `ACCOUNT_DELETED_CLOSE_CODE`). A device that
 * was offline learns it from `auth_error` code `account_deleted` instead.
 * Clients sign out, forget their credentials and stop reconnecting.
 */
export interface AccountDeletedMessage {
  type: 'account_deleted';
}

/** WebSocket close code the relay uses after deleting the account. */
export const ACCOUNT_DELETED_CLOSE_CODE = 4005;

/**
 * WebSocket close code the relay uses when the same device id authenticated
 * on a newer socket (e.g. a second browser tab sharing one stored identity).
 * The evicted client must NOT reconnect on its own: doing so evicts the newer
 * one, and the two would replace each other about once a second.
 */
export const DEVICE_REPLACED_CLOSE_CODE = 4009;

/** Broadcast confirmation that a device was removed. */
export interface DeviceRemovedMessage {
  type: 'device_removed';
  deviceId: string;
}

/** Update user preferences on the relay (e.g. intro dismissal flags). */
export interface UpdatePreferencesMessage {
  type: 'update_preferences';
  preferences: Record<string, unknown>;
}

/** Confirmation that preferences were updated. */
export interface PreferencesUpdatedMessage {
  type: 'preferences_updated';
  preferences: Record<string, unknown>;
}

/** One Custom Words entry, account-owned (not E2E encrypted). */
export interface VoiceWord { term: string; heardAs: string }
/** One user intent. Clients never upload whole lists; Head applies intents in
 *  arrival order and the last one wins. Words are matched case-insensitively. */
export interface VoiceWordOp {
  op: 'add' | 'edit' | 'remove';
  term: string;
  heardAs?: string;
  /** edit: the word being replaced (may equal `term` when only mishearings change). */
  from?: string;
}
export interface UpdateVoiceVocabularyMessage {
  type: 'update_voice_vocabulary';
  /** Echoed so the sender can drop exactly these ops from its outbox. */
  requestId: string;
  ops: VoiceWordOp[];
}
/** The account's full list after a change: to the sender (with requestId) and
 *  to the user's other online apps. */
export interface VoiceVocabularyUpdatedMessage {
  type: 'voice_vocabulary_updated';
  requestId?: string;
  words: VoiceWord[];
}

// ── Push notification token management ──────────────────

/** Register a push notification token for this device. */
export interface RegisterPushTokenMessage {
  type: 'register_push_token';
  payload: {
    /** Push provider type */
    provider: import('./devices.js').PushProviderType;
    /** Device token from the push service */
    token: string;
    /** APNs environment */
    environment?: 'production' | 'sandbox';
    /** APNs topic (bundle ID) */
    bundleId?: string;
  };
}

/** Confirmation that a push token was registered. */
export interface PushTokenRegisteredMessage {
  type: 'push_token_registered';
  payload: {
    provider: import('./devices.js').PushProviderType;
  };
}

/** Head → online `local`-provider device: the encrypted preview the relay
 *  would push to an offline phone. `key` is wrapped for the receiving device. */
export interface NotificationPreviewMessage {
  type: 'notification_preview';
  payload: { blob: string; key: string };
}

/** Remove the push token for this device. */
export interface UnregisterPushTokenMessage {
  type: 'unregister_push_token';
  payload: {
    provider: import('./devices.js').PushProviderType;
  };
}

/** Head-terminated encrypted push dispatch, sent over the existing @head Pulse channel. */
export interface DispatchPushMessage {
  type: 'dispatch_push';
  payload: {
    preview: BlobPayload;
  };
}

export type ControlMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | AuthChallengeMessage
  | AuthResponseMessage
  | ServerErrorMessage
  | RequestPairingTokenMessage
  | PairingTokenCreatedMessage
  | CreatePairingTokenMessage
  | AuthInfoRequest
  | AuthInfoResponse
  | DeviceJoinedMessage
  | DeviceLeftMessage
  | DevicePendingMessage
  | RemoveDeviceMessage
  | DeviceRemovedMessage
  | DeleteAccountMessage
  | AccountDeletedMessage
  | UpdatePreferencesMessage
  | PreferencesUpdatedMessage
  | UpdateVoiceVocabularyMessage
  | VoiceVocabularyUpdatedMessage
  | RegisterPushTokenMessage
  | PushTokenRegisteredMessage
  | NotificationPreviewMessage
  | UnregisterPushTokenMessage
  | DispatchPushMessage;
