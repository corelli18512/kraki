export { AgentAdapter } from './base.js';
export { CopilotAdapter } from './copilot.js';

// Re-export types consumers need
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
} from './base.js';

export { parsePermission } from '../parse-permission.js';
export type { ParsedPermission } from '../parse-permission.js';
