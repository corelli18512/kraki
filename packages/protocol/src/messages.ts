// ------------------------------------------------------------
// Message types and envelope
// ------------------------------------------------------------

// --- Base envelope fields shared by all messages ---

interface BaseEnvelope {
  channel: string;
  deviceId: string;
  seq: number;
  timestamp: string;
  sessionId?: string;
}

// ============================================================
// Producer messages (tentacle → head → app)
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
    mode: 'ask' | 'auto';
  };
}

export type ProducerMessage =
  | SessionCreatedMessage
  | SessionEndedMessage
  | UserMessage
  | AgentMessage
  | AgentMessageDelta
  | PermissionRequest
  | QuestionRequest
  | ToolStartMessage
  | ToolCompleteMessage
  | IdleMessage
  | ErrorMessage
  | SessionModeSetMessage;

/** Message types the head persists for session recovery */
export type StoredMessageType =
  | 'session_created'
  | 'session_ended'
  | 'user_message'
  | 'agent_message'
  | 'permission'
  | 'question'
  | 'tool_start'
  | 'tool_complete'
  | 'error'
  | 'send_input'
  | 'approve'
  | 'deny'
  | 'always_allow'
  | 'answer'
  | 'kill_session'
  | 'session_mode_set';

/** Message types forwarded in real-time only (not persisted) */
export type TransientMessageType =
  | 'agent_message_delta'
  | 'idle'
  | 'create_session';

// ============================================================
// Consumer messages (app → head → tentacle)
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
    mode: 'ask' | 'auto';
  };
}

export interface DeleteSessionMessage extends BaseEnvelope {
  type: 'delete_session';
  payload: Record<string, never>;
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
  | DeleteSessionMessage;

// ============================================================
// Control messages (device ↔ head)
// ============================================================

export interface AuthMessage {
  type: 'auth';
  token?: string;
  channelKey?: string;
  /** One-time pairing token from QR code (alternative to token/channelKey) */
  pairingToken?: string;
  /** GitHub OAuth authorization code (exchanged server-side for access token) */
  githubCode?: string;
  device: DeviceInfo;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  channel: string;
  deviceId: string;
  e2e: boolean;
  devices: DeviceSummary[];
  sessions: SessionSummary[];
  /** Per-session last-read seq for this device (for unread tracking) */
  readState?: Record<string, number>;
  /** Channel owner identity (login, provider) for profile display */
  user?: { id: string; login: string; provider: string; email?: string };
}

export interface AuthErrorMessage {
  type: 'auth_error';
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
  /** Echoed from create_session for request tracking */
  requestId?: string;
}

export interface ReplayMessage {
  type: 'replay';
  afterSeq: number;
  sessionId?: string;
}

export interface MarkReadMessage {
  type: 'mark_read';
  sessionId: string;
  /** The highest seq the client has seen for this session */
  seq: number;
}

export interface CreatePairingTokenMessage {
  type: 'create_pairing_token';
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

export interface PingMessage {
  type: 'ping';
}

export interface PongMessage {
  type: 'pong';
}

/** Pre-auth request to discover server capabilities. */
export interface AuthInfoRequest {
  type: 'auth_info';
}

/** Server response with supported auth modes and features. */
export interface AuthInfoResponse {
  type: 'auth_info_response';
  /** Supported auth modes (e.g. ['github', 'apikey', 'open']) */
  authModes: string[];
  /** Whether E2E encryption is enabled */
  e2e: boolean;
  /** Whether device pairing is enabled */
  pairing: boolean;
  /** GitHub OAuth client ID (present when GitHub OAuth is configured for web login) */
  githubClientId?: string;
}

/** Global notification from head to all connected devices (tentacles + apps) */
export type HeadNotice =
  | { type: 'head_notice'; event: 'device_online';   data: { device: DeviceSummary } }
  | { type: 'head_notice'; event: 'device_offline';  data: { deviceId: string } }
  | { type: 'head_notice'; event: 'device_added';    data: { device: DeviceSummary } }
  | { type: 'head_notice'; event: 'device_removed';  data: { deviceId: string } }
  | { type: 'head_notice'; event: 'session_updated'; data: { session: SessionSummary } }
  | { type: 'head_notice'; event: 'session_removed'; data: { sessionId: string } }
  | { type: 'head_notice'; event: 'update_allow_list'; data: { allowedTools: string[] } };

export type ControlMessage =
  | AuthMessage
  | AuthOkMessage
  | AuthErrorMessage
  | AuthChallengeMessage
  | AuthResponseMessage
  | ServerErrorMessage
  | ReplayMessage
  | MarkReadMessage
  | CreatePairingTokenMessage
  | RequestPairingTokenMessage
  | PairingTokenCreatedMessage
  | AuthInfoRequest
  | AuthInfoResponse
  | PingMessage
  | PongMessage
  | HeadNotice;

// ============================================================
// E2E Encrypted message
// ============================================================
// In E2E mode, any ProducerMessage or ConsumerMessage is wrapped
// in this envelope. The head cannot read the inner message.
//
// The ciphertext is encrypted ONCE with a random AES key.
// The AES key is then encrypted separately for each recipient
// device using their RSA public key. This avoids duplicating
// the (potentially large) ciphertext per device.
// ============================================================

export interface EncryptedMessage extends BaseEnvelope {
  type: 'encrypted';
  /** AES-256-GCM initialization vector (base64) */
  iv: string;
  /** AES-256-GCM encrypted payload (base64) — same for all recipients */
  ciphertext: string;
  /** AES-256-GCM authentication tag (base64) — tamper detection */
  tag: string;
  /** Per-device RSA-OAEP encrypted AES key (base64) */
  keys: Record<string, string>;
  /** Agent name exposed from session_created for head session registration */
  agent?: string;
  /** Model exposed from session_created for head session registration */
  model?: string;
  /** Target device ID for encrypted create_session routing */
  targetDeviceId?: string;
  /** Delivery hint: if true, head should forward but not persist (e.g. deltas, idle) */
  ephemeral?: boolean;
}

// ============================================================
// Union of all messages
// ============================================================

export type Message = ProducerMessage | ConsumerMessage | ControlMessage | EncryptedMessage;

// Re-export types used in control messages
import type { DeviceSummary, DeviceRole, DeviceInfo } from './devices.js';
import type { SessionSummary } from './sessions.js';
import type { ToolArgs } from './tools.js';
export type { DeviceSummary, DeviceRole, DeviceInfo, SessionSummary, ToolArgs };
