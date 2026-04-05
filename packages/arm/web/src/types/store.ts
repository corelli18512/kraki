import type {
  SessionSummary,
  DeviceSummary,
  ProducerMessage,
  ConsumerMessage,
  ModelDetail,
  SessionUsage,
} from '@kraki/protocol';

// --- Connection ---

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'awaiting_login';

// --- Chat messages ---

export interface PendingInputMessage {
  type: 'pending_input';
  id: string;
  sessionId: string;
  text: string;
  timestamp: string;
}

export type ChatMessage = ProducerMessage | ConsumerMessage | PendingInputMessage;

// --- Pending actions ---

export interface PendingPermission {
  id: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  description: string;
  timestamp: string;
}

export interface PendingQuestion {
  id: string;
  sessionId: string;
  question: string;
  choices?: string[];
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
  user: { id: string; login: string; provider: string; email?: string } | null;

  // Data
  sessions: Map<string, SessionSummary>;
  devices: Map<string, DeviceSummary>;
  messages: Map<string, ChatMessage[]>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;

  // Streaming deltas (partial agent messages being built up)
  streamingContent: Map<string, string>;

  // Pinned sessions (stick to top of list)
  pinnedSessions: Set<string>;

  // Tracks unread notification count per session
  unreadCount: Map<string, number>;

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

  // Relay server version
  relayVersion: string | null;

  // Live capabilities from tentacle greetings
  deviceModels: Map<string, string[]>;
  deviceModelDetails: Map<string, ModelDetail[]>;

  // Per-session cumulative token usage
  sessionUsage: Map<string, SessionUsage>;
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
  resolvePendingInput: (sessionId: string, seq?: number) => void;
  appendDelta: (sessionId: string, content: string) => void;
  flushDelta: (sessionId: string) => void;
  addPermission: (perm: PendingPermission) => void;
  removePermission: (id: string) => void;
  addQuestion: (q: PendingQuestion) => void;
  removeQuestion: (id: string) => void;
  togglePin: (sessionId: string) => void;
  setPinnedSessions: (pinned: Set<string>) => void;
  incrementUnread: (sessionId: string) => void;
  clearUnread: (sessionId: string) => void;
  setDraft: (sessionId: string, text: string) => void;
  setLastError: (message: string | null) => void;
  setNavigateToSession: (sessionId: string | null) => void;
  setActiveSessionId: (sessionId: string | null) => void;
  setSessionMode: (sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate') => void;
  setGithubClientId: (clientId: string | null) => void;
  setRelayVersion: (version: string | null) => void;
  setDeviceModels: (deviceId: string, models: string[]) => void;
  setDeviceModelDetails: (deviceId: string, details: ModelDetail[]) => void;
  setSessionUsage: (sessionId: string, usage: SessionUsage) => void;
  clearTransientState: () => void;
  reset: () => void;

  // Pagination
  prependMessages: (sessionId: string, older: ChatMessage[]) => void;
}

export type Store = AppState & AppActions;
