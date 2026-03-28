// ------------------------------------------------------------
// Kraki Protocol — Message types and envelopes
// ------------------------------------------------------------
//
// The relay is a thin encrypted forwarder. It never reads message
// content — only the envelope fields visible to it.
//
// Two envelope directions:
//   Unicast   — app → specific tentacle (has `to` field)
//   Broadcast — tentacle → all devices (has optional `notify`)
//
// Inner messages (ProducerMessage / ConsumerMessage) are encrypted
// inside the blob and only visible to endpoints after decryption.
// ------------------------------------------------------------

// ============================================================
// Relay envelopes (visible to relay)
// ============================================================

/** App → specific tentacle. Relay reads `to` for routing. */
export interface UnicastEnvelope {
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

/** Tentacle → all devices. Relay broadcasts to all other devices under the user. */
export interface BroadcastEnvelope {
  type: 'broadcast';
  /** Hint for future push notification support. Not yet implemented. */
  notify?: boolean;
  /** Encrypted payload: base64(iv + ciphertext + tag) */
  blob: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
}

export type RelayEnvelope = UnicastEnvelope | BroadcastEnvelope;

/** Encrypted blob payload — shared between crypto and app layers. */
export interface BlobPayload {
  /** base64(iv ‖ ciphertext ‖ tag) */
  blob: string;
  /** Per-recipient RSA-OAEP encrypted AES key (base64), keyed by deviceId */
  keys: Record<string, string>;
}

// ============================================================
// Inner message base (inside encrypted blob, invisible to relay)
// ============================================================

interface BaseEnvelope {
  deviceId: string;
  seq: number;
  timestamp: string;
  sessionId?: string;
}

// ============================================================
// Producer messages (tentacle → app, inside encrypted blob)
// ============================================================

export interface SessionCreatedMessage extends BaseEnvelope {
  type: 'session_created';
  payload: {
    agent: string;
    model?: string;
    /** Echoed from create_session for request tracking */
    requestId?: string;
  };
}

export interface SessionEndedMessage extends BaseEnvelope {
  type: 'session_ended';
  payload: {
    reason: string;
  };
}

export interface UserMessage extends BaseEnvelope {
  type: 'user_message';
  payload: {
    content: string;
  };
}

export interface AgentMessage extends BaseEnvelope {
  type: 'agent_message';
  payload: {
    content: string;
    attachments?: string[];
  };
}

export interface AgentMessageDelta extends BaseEnvelope {
  type: 'agent_message_delta';
  payload: {
    content: string;
  };
}

export interface PermissionRequest extends BaseEnvelope {
  type: 'permission';
  payload: ToolArgs & {
    id: string;
    description: string;
  };
}

export interface QuestionRequest extends BaseEnvelope {
  type: 'question';
  payload: {
    id: string;
    question: string;
    choices?: string[];
  };
}

export interface ToolStartMessage extends BaseEnvelope {
  type: 'tool_start';
  payload: ToolArgs & {
    /** Unique ID for this tool invocation (matches tool_complete) */
    toolCallId?: string;
  };
}

export interface ToolCompleteMessage extends BaseEnvelope {
  type: 'tool_complete';
  payload: ToolArgs & {
    result: string;
    /** Unique ID matching the tool_start */
    toolCallId?: string;
  };
}

export interface IdleMessage extends BaseEnvelope {
  type: 'idle';
  payload: Record<string, never>;
}

export interface ErrorMessage extends BaseEnvelope {
  type: 'error';
  payload: {
    message: string;
  };
}

export interface SessionModeSetMessage extends BaseEnvelope {
  type: 'session_mode_set';
  payload: {
    mode: import('./sessions.js').SessionMode;
  };
}

export interface SessionDeletedMessage extends BaseEnvelope {
  type: 'session_deleted';
  payload: Record<string, never>;
}

/** Greeting sent by tentacle to a newly joined app via unicast. */
export interface DeviceGreetingMessage extends BaseEnvelope {
  type: 'device_greeting';
  payload: {
    name: string;
    kind?: string;
    models?: string[];
    version?: string;
  };
}

/** Sent by tentacle to a device after replaying all buffered messages for a session. */
export interface SessionReplayCompleteMessage extends BaseEnvelope {
  type: 'session_replay_complete';
  payload: {
    /** The session that was replayed. */
    sessionId: string;
    /** The highest seq included in this replay batch. */
    lastSeq: number;
    /** The total highest seq in the session (for detecting if more messages are available). */
    totalLastSeq: number;
  };
}

/** Sent by tentacle to app with metadata for all active sessions. */
export interface SessionListMessage extends BaseEnvelope {
  type: 'session_list';
  payload: {
    sessions: import('./sessions.js').SessionDigest[];
  };
}

/** Broadcast by tentacle when a permission is resolved (so all apps can clear the card). */
export interface PermissionResolvedMessage extends BaseEnvelope {
  type: 'permission_resolved';
  payload: {
    permissionId: string;
  } & (
    | { resolution: 'approved' }
    | { resolution: 'denied'; reason?: string }
    | { resolution: 'always_allowed' }
  );
}

/** Broadcast by tentacle when a question is answered (so all apps can clear the card). */
export interface QuestionResolvedMessage extends BaseEnvelope {
  type: 'question_resolved';
  payload: {
    questionId: string;
    answer: string;
  };
}

export type ProducerMessage =
  | SessionCreatedMessage
  | SessionEndedMessage
  | SessionDeletedMessage
  | UserMessage
  | AgentMessage
  | AgentMessageDelta
  | PermissionRequest
  | QuestionRequest
  | ToolStartMessage
  | ToolCompleteMessage
  | IdleMessage
  | ErrorMessage
  | SessionModeSetMessage
  | DeviceGreetingMessage
  | SessionReplayCompleteMessage
  | SessionListMessage
  | PermissionResolvedMessage
  | QuestionResolvedMessage;

// ============================================================
// Consumer messages (app → tentacle, inside encrypted blob)
// ============================================================

export interface SendInputMessage extends BaseEnvelope {
  type: 'send_input';
  payload: {
    text: string;
    attachments?: string[];
  };
}

export interface ApproveMessage extends BaseEnvelope {
  type: 'approve';
  payload: {
    permissionId: string;
  };
}

export interface DenyMessage extends BaseEnvelope {
  type: 'deny';
  payload: {
    permissionId: string;
  };
}

export interface AlwaysAllowMessage extends BaseEnvelope {
  type: 'always_allow';
  payload: {
    permissionId: string;
    /** Tool kind to add to the allow list (e.g. 'shell', 'write') */
    toolKind?: string;
  };
}

export interface AnswerMessage extends BaseEnvelope {
  type: 'answer';
  payload: {
    questionId: string;
    answer: string;
  };
}

export interface KillSessionMessage extends BaseEnvelope {
  type: 'kill_session';
  payload: Record<string, never>;
}

export interface AbortSessionMessage extends BaseEnvelope {
  type: 'abort_session';
  payload: Record<string, never>;
}

export interface CreateSessionMessage extends BaseEnvelope {
  type: 'create_session';
  payload: {
    /** Client-generated request ID for tracking success/failure */
    requestId: string;
    /** Target tentacle device ID */
    targetDeviceId: string;
    /** Agent model to use (e.g. "claude-sonnet-4") */
    model: string;
    /** Initial prompt to send after session is created */
    prompt?: string;
    /** Working directory for the session */
    cwd?: string;
  };
}

export interface SetSessionModeMessage extends BaseEnvelope {
  type: 'set_session_mode';
  payload: {
    mode: import('./sessions.js').SessionMode;
  };
}

export interface DeleteSessionMessage extends BaseEnvelope {
  type: 'delete_session';
  payload: Record<string, never>;
}

export interface MarkReadMessage extends BaseEnvelope {
  type: 'mark_read';
  payload: {
    /** The highest seq the client has seen for this session */
    seq: number;
  };
}

/** Sent by app to tentacle to request replay for a specific session. */
export interface RequestSessionReplayMessage extends BaseEnvelope {
  type: 'request_session_replay';
  payload: {
    /** Session to replay. */
    sessionId: string;
    /** Replay messages with seq strictly greater than this value. Use 0 for full replay. */
    afterSeq: number;
    /** Max number of messages to return. Omit for all. */
    limit?: number;
  };
}

export type ConsumerMessage =
  | SendInputMessage
  | ApproveMessage
  | DenyMessage
  | AlwaysAllowMessage
  | AnswerMessage
  | KillSessionMessage
  | AbortSessionMessage
  | CreateSessionMessage
  | SetSessionModeMessage
  | DeleteSessionMessage
  | MarkReadMessage
  | RequestSessionReplayMessage;

// ============================================================
// Auth credentials — discriminated union by method
// ============================================================

export interface GithubTokenAuth {
  method: 'github_token';
  token: string;
}

export interface GithubOAuthAuth {
  method: 'github_oauth';
  code: string;
}

export interface PairingAuth {
  method: 'pairing';
  token: string;
}

export interface ChallengeAuth {
  method: 'challenge';
  deviceId: string;
}

export interface ApiKeyAuth {
  method: 'apikey';
  key: string;
}

export interface OpenAuth {
  method: 'open';
  sharedKey?: string;
}

export type AuthMethod = GithubTokenAuth | GithubOAuthAuth | PairingAuth | ChallengeAuth | ApiKeyAuth | OpenAuth;

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
  user: { id: string; login: string; provider: string; email?: string };
  devices: DeviceSummary[];
  /** GitHub OAuth client ID (present when GitHub OAuth is configured for web login) */
  githubClientId?: string;
  /** Relay server version */
  relayVersion?: string;
}

export type AuthErrorCode =
  | 'auth_rejected'
  | 'unknown_auth_method'
  | 'pairing_disabled'
  | 'invalid_pairing_token'
  | 'unknown_device'
  | 'no_pending_challenge'
  | 'device_not_found'
  | 'invalid_signature'
  | 'user_not_found'
  | 'device_registration_failed';

export interface AuthErrorMessage {
  type: 'auth_error';
  /** Machine-readable auth failure reason for client behavior */
  code: AuthErrorCode;
  message: string;
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
  | UpdatePreferencesMessage
  | PreferencesUpdatedMessage;

// ============================================================
// Union of all messages
// ============================================================

/** Inner message (decrypted from blob) */
export type InnerMessage = ProducerMessage | ConsumerMessage;

/** Everything that flows over the WebSocket */
export type Message = RelayEnvelope | ControlMessage;

// Re-export types used in control messages
import type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities } from './devices.js';
import type { SessionSummary, SessionDigest, SessionMode } from './sessions.js';
import type { ToolArgs } from './tools.js';
export type { DeviceSummary, DeviceRole, DeviceInfo, DeviceCapabilities, SessionSummary, SessionDigest, SessionMode, ToolArgs };
