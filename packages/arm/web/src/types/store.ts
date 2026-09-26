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

export type ChatMessage = ProducerMessage | ConsumerMessage;

// --- Server-owned status card ---

export interface SessionCard {
  /** The live DRAFT text — the agent's streaming words for the current turn.
   *  Rendered as a clean in-flow spine bubble (NOT the pinned working card) and
   *  cleared when the turn's permanent `agent_message` bubble lands. */
  text: string;
  /** The single action slot (tool / tool batch / permission) of the live
   *  bubble. Questions are spine messages, never card state. */
  action: CardActionState | null;
  /** A spine bubble concluded the live segment (a reply, a question, a
   *  terminal status, idle). The live bubble stays hidden until the next
   *  delta/action reopens it — between segments it would otherwise flash
   *  away for a few frames whenever Tentacle clears the slot. */
  closed?: boolean;
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

export interface WebSessionSummary extends SessionSummary {
  /** Tentacle-owned Spine head/read cursors carried by session_list. */
  lastSeq?: number;
  readSeq?: number;
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
  sessions: Map<string, WebSessionSummary>;
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
  setSessions: (sessions: WebSessionSummary[]) => void;
  upsertSession: (session: WebSessionSummary) => void;
  removeSession: (sessionId: string) => void;
  setDevices: (devices: DeviceSummary[]) => void;
  upsertDevice: (device: DeviceSummary) => void;
  removeDevice: (deviceId: string) => void;
  setDeviceOnline: (deviceId: string, online: boolean) => void;
  appendMessage: (sessionId: string, message: ChatMessage) => void;
  applyCardMessage: (sessionId: string, content: string, reset?: boolean) => void;
  setCardAction: (sessionId: string, action: CardActionState | null) => void;
  setRuntimeStatus: (sessionId: string, status: SessionRuntimeStatus | null) => void;
  clearCard: (sessionId: string) => void;
  togglePin: (sessionId: string) => void;
  setPinnedSessions: (pinned: Set<string>) => void;
  incrementUnread: (sessionId: string) => void;
  clearUnread: (sessionId: string) => void;
  setSessionPreview: (sessionId: string, preview: SessionPreview, incrementUnread?: boolean) => void;
  clearSessionPreview: (sessionId: string) => void;
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
