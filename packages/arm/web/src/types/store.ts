import type {
  SessionSummary,
  DeviceSummary,
  ProducerMessage,
  ConsumerMessage,
  AgentCapabilities,
  ModelDetail,
  SessionUsage,
  LocalSession,
  CardActionState,
} from '@kraki/protocol';

// --- Connection ---

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'awaiting_login';

// --- Chat messages ---

export interface PendingInputMessage {
  type: 'pending_input';
  id: string;
  /** Client-generated correlation id (UUID). Echoed back inside the
   *  resulting `user_message` broadcast so this placeholder can be
   *  resolved unambiguously. `id` and `clientId` are typically the
   *  same value; `clientId` is kept as a separate field for clarity
   *  and to survive future changes to how `id` is generated. */
  clientId: string;
  sessionId: string;
  text: string;
  timestamp: string;
  attachments?: import('@kraki/protocol').Attachment[];
}

export type ChatMessage = ProducerMessage | ConsumerMessage | PendingInputMessage;

// --- Server-owned status card ---

export interface SessionCard {
  /** The live DRAFT text — the agent's streaming words for the current turn.
   *  Rendered as a clean in-flow spine bubble (NOT the pinned working card) and
   *  cleared when the turn's permanent `agent_message` bubble lands. */
  text: string;
  /** The single action slot (tool / permission / question). The ONLY thing the
   *  pinned status card renders. */
  action: CardActionState | null;
}

export interface SessionRuntimeStatus {
  status: 'compacting';
  reason?: 'manual' | 'threshold' | 'overflow';
}

export interface SessionPreview {
  text: string;
  type: string;
  timestamp: string;
}

// --- Store ---

export interface AppState {
  // Connection
  status: ConnectionStatus;
  deviceId: string | null;
  reconnectAttempts: number;
  nextReconnectDelayMs: number | null;

  // Authenticated user
  user: { id: string; login: string; provider: string; email?: string; preferences?: Record<string, unknown> } | null;

  // Data
  sessions: Map<string, SessionSummary>;
  devices: Map<string, DeviceSummary>;
  messages: Map<string, ChatMessage[]>;
  cards: Map<string, SessionCard>;
  /** Ephemeral session runtime state; never persisted to localStorage/IDB. */
  runtimeStatuses: Map<string, SessionRuntimeStatus>;

  // Pinned sessions (stick to top of list)
  pinnedSessions: Set<string>;

  // Tracks unread notification count per session
  unreadCount: Map<string, number>;

  // Session preview (last meaningful message for list display and sort)
  sessionPreviews: Map<string, SessionPreview>;

  // Last server/system error for UI display
  lastError: string | null;

  // Per-session message drafts
  drafts: Map<string, string>;

  // Session ID to navigate to (set by ws-client, consumed by UI)
  navigateToSession: string | null;

  // Currently viewed session (set by SessionPage)
  activeSessionId: string | null;

  // Per-session permission mode ('ask' = prompt user, 'auto' = auto-approve)
  sessionModes: Map<string, 'safe' | 'discuss' | 'execute' | 'delegate'>;

  // GitHub OAuth client ID from relay (for web login)
  githubClientId: string | null;

  // VAPID public key from relay (for Web Push)
  vapidPublicKey: string | null;

  // Relay server version
  relayVersion: string | null;

  // Live capabilities from tentacle greetings
  deviceAgents: Map<string, AgentCapabilities[]>;
  deviceVersions: Map<string, string>;

  // Per-session cumulative token usage
  sessionUsage: Map<string, SessionUsage>;

  // Sessions currently loading initial messages
  loadingSessions: Set<string>;

  // Sessions with outstanding create/import/fork requests (not yet confirmed by session_created)
  pendingSessions: Set<string>;

  // Local session import picker
  localSessions: LocalSession[];
  localSessionsLoading: boolean;
}

export interface AppActions {
  // Connection
  setStatus: (status: ConnectionStatus) => void;
  setAuth: (deviceId: string) => void;
  setUser: (user: AppState['user']) => void;
  setReconnectState: (attempts: number, nextDelayMs: number | null) => void;

  // Data
  setSessions: (sessions: SessionSummary[]) => void;
  upsertSession: (session: SessionSummary) => void;
  removeSession: (sessionId: string) => void;
  setDevices: (devices: DeviceSummary[]) => void;
  upsertDevice: (device: DeviceSummary) => void;
  removeDevice: (deviceId: string) => void;
  setDeviceOnline: (deviceId: string, online: boolean) => void;
  appendMessage: (sessionId: string, message: ChatMessage) => void;
  /** Replace a pending_input with the matching `user_message` broadcast.
   *  When `clientId` is provided, the pending with that exact id is
   *  resolved; otherwise the first pending (legacy fallback for clients
   *  or replays without clientId) is resolved. `serverContent` overrides
   *  the pending's local text if present. */
  resolvePendingInput: (
    sessionId: string,
    seq: number,
    clientId?: string,
    serverContent?: string,
  ) => boolean;
  applyCardMessage: (sessionId: string, content: string, reset?: boolean) => void;
  setCardAction: (sessionId: string, action: CardActionState | null) => void;
  setRuntimeStatus: (sessionId: string, status: SessionRuntimeStatus | null) => void;
  clearCard: (sessionId: string) => void;
  togglePin: (sessionId: string) => void;
  setPinnedSessions: (pinned: Set<string>) => void;
  incrementUnread: (sessionId: string) => void;
  clearUnread: (sessionId: string) => void;
  setSessionPreview: (sessionId: string, preview: SessionPreview, incrementUnread?: boolean) => void;
  setDraft: (sessionId: string, text: string) => void;
  setLastError: (message: string | null) => void;
  setNavigateToSession: (sessionId: string | null) => void;
  setActiveSessionId: (sessionId: string | null) => void;
  setSessionMode: (sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate') => void;
  setGithubClientId: (clientId: string | null) => void;
  setVapidPublicKey: (key: string | null) => void;
  setRelayVersion: (version: string | null) => void;
  setDeviceAgents: (deviceId: string, agents: AgentCapabilities[]) => void;
  clearDeviceAgents: (deviceId: string) => void;
  setDeviceVersion: (deviceId: string, version: string) => void;
  setSessionUsage: (sessionId: string, usage: SessionUsage) => void;
  setSessionLoading: (sessionId: string, loading: boolean) => void;
  addPendingSession: (sessionId: string) => void;
  removePendingSession: (sessionId: string) => void;
  setLocalSessions: (sessions: LocalSession[]) => void;
  setLocalSessionsLoading: (loading: boolean) => void;
  clearTransientState: () => void;
  reset: () => void;

  // Pagination
  prependMessages: (sessionId: string, older: ChatMessage[]) => void;
  /** Attach a turn's lazily-pulled trace (TRACE axis). Replaces any existing
   *  tool_start/tool_complete/agent_narration for the turn concluding at
   *  `bubbleSeq`, positioning the entries just before that bubble. When
   *  `bubbleSeq` points at a user_message (an in-progress turn seeded on
   *  reload), the entries are placed just AFTER it instead. In-memory only —
   *  trace is never persisted to IndexedDB. */
  setTurnSteps: (sessionId: string, bubbleSeq: number, entries: ChatMessage[]) => void;
}

export type Store = AppState & AppActions;
