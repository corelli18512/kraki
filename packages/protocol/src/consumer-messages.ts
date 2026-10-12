/** Consumer messages (app → tentacle) and the ConsumerMessage union. */

import { type Attachment } from './attachments.js';
import { type RequestSessionMessagesMessage, type RequestSessionMessagesRangeMessage, type RequestTurnTraceMessage, type RequestCardMessage, type ClientFeaturesMessage, type SetSessionSubscriptionMessage } from './history-messages.js';
import { type BaseEnvelope } from './message-base.js';
import { type RefreshAccountUsageMessage, type UpdateDeviceMessage } from './usage-messages.js';

// ============================================================
// Consumer messages (app → tentacle, inside encrypted blob)
// ============================================================

export interface SendInputMessage extends BaseEnvelope {
  type: 'send_input';
  payload: {
    text: string;
    attachments?: Attachment[];
    /** Client-generated correlation id (UUID). When present, tentacle
     *  echoes it back inside the resulting `user_message` broadcast,
     *  allowing the originating client to resolve its pending
     *  placeholder unambiguously — even with multiple in-flight sends,
     *  reconnects, or multi-device scenarios. Optional for back-compat
     *  with older clients. */
    clientId?: string;
    /** Delivery intent chosen by the app from its observed session state.
     *  `steer` interjects into the current active turn; omitted/`prompt`
     *  preserves the normal idle-session prompt behavior. */
    delivery?: 'prompt' | 'steer';
    /** Answer the pending question with this id (replaces the `answer` command). */
    answerTo?: string;
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
    /** Optional explanation typed by the operator; relayed to the agent. */
    reason?: string;
  };
}

/** @deprecated No app sends it any more. Tentacle ≥ 0.38.7 answers it like
 *  `approve` for that one request (no session-wide grant). */
export interface AlwaysAllowMessage extends BaseEnvelope {
  type: 'always_allow';
  payload: {
    permissionId: string;
    /** Tool kind to add to the allow list (e.g. 'shell', 'write') */
    toolKind?: string;
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
    /** Which agent to use for this session */
    agentId: import('./devices.js').AgentId;
    /** Agent model to use (e.g. "claude-sonnet-4") */
    model: string;
    /** Reasoning effort level (only for models that support it) */
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    /** Context tier (only for models that support long_context) */
    contextTier?: import('./devices.js').ContextTier;
    /** Initial prompt to send after session is created */
    prompt?: string;
    /** Working directory for the session */
    cwd?: string;
  };
}

export interface SetSessionModeMessage extends BaseEnvelope {
  type: 'set_session_mode';
  payload: {
    mode: import('./sessions.js').WireSessionMode;
  };
}

export interface SetSessionModelMessage extends BaseEnvelope {
  type: 'set_session_model';
  payload: {
    model: string;
    reasoningEffort?: import('./devices.js').ReasoningEffort;
    contextTier?: import('./devices.js').ContextTier;
  };
}

export interface DeleteSessionMessage extends BaseEnvelope {
  type: 'delete_session';
  payload: Record<string, never>;
}

export interface ForkSessionMessage extends BaseEnvelope {
  type: 'fork_session';
  payload: {
    /** Client-generated request ID for tracking success/failure */
    requestId: string;
    /** Session to fork from */
    sourceSessionId: string;
  };
}

export interface MarkReadMessage extends BaseEnvelope {
  type: 'mark_read';
  payload: {
    /** The highest seq the client has seen for this session */
    seq: number;
  };
}

/**
 * Sent by app to tentacle to request replay for a specific session.
 * @deprecated Use `request_session_messages` / `session_messages_batch` instead.
 * No current client sends it. Removal plan: docs/protocol-compatibility.md.
 */
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

/** Sent by app to tentacle to rename a session. */
export interface RenameSessionMessage extends BaseEnvelope {
  type: 'rename_session';
  payload: {
    /** New manual title. Empty string clears manual title (reverts to auto-title). */
    title: string;
  };
}

export interface PinSessionMessage extends BaseEnvelope {
  type: 'pin_session';
  payload: {
    pinned: boolean;
  };
}

/** Archive or unarchive a session. Tentacle answers with a fresh `session_list`.
 *  Opening or sending to an archived session also unarchives it. */
export interface ArchiveSessionMessage extends BaseEnvelope {
  type: 'archive_session';
  payload: {
    archived: boolean;
  };
}

/** Ask a computer for its archived sessions (answered by `archived_session_list`). */
export interface RequestArchivedSessionsMessage extends BaseEnvelope {
  type: 'request_archived_sessions';
  payload: { requestId?: string };
}

/** Delete every archived session on the target computer. */
export interface DeleteArchivedSessionsMessage extends BaseEnvelope {
  type: 'delete_archived_sessions';
  payload: Record<string, never>;
}

/** Change how many days without messages before a session is archived
 *  (0 = never). Tentacle answers with a fresh `session_list`. */
export interface SetAutoArchiveDaysMessage extends BaseEnvelope {
  type: 'set_auto_archive_days';
  payload: { days: number };
}

/** Mark a session as unread. Tentacle rolls back readSeq. */
export interface MarkUnreadMessage extends BaseEnvelope {
  type: 'mark_unread';
  payload: Record<string, never>;
}

/** Request catalog of local Copilot sessions for the import picker. */
export interface RequestLocalSessionsMessage extends BaseEnvelope {
  type: 'request_local_sessions';
  payload: {
    requestId?: string;
    filter?: {
      /** Case-insensitive substring across summary, cwd, gitRoot, repository, branch. */
      search?: string;
      /** Only live sessions. */
      liveOnly?: boolean;
      /** Include already-imported sessions. Default false. */
      includeLinked?: boolean;
    };
  };
}

/** Import a local Copilot session into Kraki.
 *  Tentacle resumes the same session ID — both Kraki and original CLI share state on disk. */
export interface ImportSessionMessage extends BaseEnvelope {
  type: 'import_session';
  payload: {
    /** Echoed in session_created.payload.requestId on success. */
    requestId: string;
    /** Must match a sessionId from a previous local_sessions_list. */
    localSessionId: string;
    /** Metadata from the picker — avoids re-scanning filesystem on import. */
    meta?: {
      cwd?: string;
      summary?: string;
      source?: import('./sessions.js').LocalSessionSource;
      model?: string;
      branch?: string;
      startTime?: string;
    };
  };
}

/** Sent by app to tentacle to request the bytes of a stored attachment.
 *  Used when a client sees a `ContentRef` it can't satisfy from its local
 *  cache (typical after reconnect/replay). Tentacle responds with one or more
 *  `attachment_data` messages addressed to the requester. */
export interface RequestAttachmentMessage extends BaseEnvelope {
  type: 'request_attachment';
  payload: {
    /** Attachment id from the ContentRef. */
    id: string;
    /** Session the attachment belongs to (used for AttachmentStore scoping). */
    sessionId: string;
    /** Opt into one-chunk-at-a-time delivery. Older tentacles ignore this. */
    mode?: 'paced';
    /** Chunk requested in paced mode. Defaults to the first chunk. */
    index?: number;
  };
}

/** App → tentacle: fetch locally recorded quota readings (for heatmaps). */
export interface RequestUsageHistoryMessage extends BaseEnvelope {
  type: 'request_usage_history';
  payload: {
    /** Epoch seconds; defaults to 60 days ago. */
    since?: number;
  };
}

export type ConsumerMessage =
  | SendInputMessage
  | ApproveMessage
  | DenyMessage
  | AlwaysAllowMessage
  | KillSessionMessage
  | AbortSessionMessage
  | CreateSessionMessage
  | ForkSessionMessage
  | SetSessionModeMessage
  | SetSessionModelMessage
  | DeleteSessionMessage
  | MarkReadMessage
  | MarkUnreadMessage
  | RequestSessionReplayMessage
  | RequestSessionMessagesMessage
  | RequestSessionMessagesRangeMessage
  | RequestTurnTraceMessage
  | RequestCardMessage
  | RenameSessionMessage
  | PinSessionMessage
  | ArchiveSessionMessage
  | RequestArchivedSessionsMessage
  | SetAutoArchiveDaysMessage
  | DeleteArchivedSessionsMessage
  | RequestLocalSessionsMessage
  | ImportSessionMessage
  | RequestAttachmentMessage
  | SetSessionSubscriptionMessage
  | ClientFeaturesMessage
  | RequestUsageHistoryMessage
  | RefreshAccountUsageMessage
  | UpdateDeviceMessage;
