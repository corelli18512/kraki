// kraki — Kraki agent bridge
//
// The tentacle connects coding agents to the Kraki relay.
// It wraps agent SDKs via adapters and translates their events
// into the @kraki/protocol message types.

export { AgentAdapter, CopilotAdapter, parsePermission } from './adapters/index.js';

export type {
  CreateSessionConfig,
  SessionInfo,
  PermissionDecision,
  SessionCreatedEvent,
  MessageEvent,
  MessageDeltaEvent,
  PermissionRequestEvent,
  QuestionRequestEvent,
  ToolStartEvent,
  ToolCompleteEvent,
  SessionEndedEvent,
  ErrorEvent,
  ParsedPermission,
} from './adapters/index.js';

export { loadConfig, saveConfig, configExists, getOrCreateDeviceId } from './config.js';
export { SessionManager } from './session-manager.js';
export type { SessionContext, SessionMeta, RunRecord } from './session-manager.js';
export { RelayClient } from './relay-client.js';
export type { RelayClientOptions, RelayClientState } from './relay-client.js';
export { KeyManager } from './key-manager.js';
export { MessageStore } from './message-store.js';
export type { BufferedMessage } from './message-store.js';

