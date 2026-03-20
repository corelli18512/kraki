/**
 * Abstract base class for coding agent adapters.
 *
 * Each concrete adapter (Copilot, Claude Code, Codex, etc.) wraps
 * an agent's SDK and normalises its events into Kraki protocol types.
 *
 * The tentacle runtime sets the `on*` callbacks before calling `start()`.
 * The adapter fires them as the agent produces events.
 */

import type { ToolArgs } from '@kraki/protocol';
import type { SessionContext } from '../session-manager.js';

// ── Callback payload types ──────────────────────────────

export interface SessionCreatedEvent {
  sessionId: string;
  agent: string;
  model?: string;
}

export interface MessageEvent {
  content: string;
}

export interface MessageDeltaEvent {
  content: string;
}

export interface PermissionRequestEvent {
  id: string;
  toolArgs: ToolArgs;
  description: string;
}

export interface QuestionRequestEvent {
  id: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
}

export interface ToolStartEvent {
  toolName: string;
  args: Record<string, unknown>;
  toolCallId?: string;
}

export interface ToolCompleteEvent {
  toolName: string;
  result: string;
  toolCallId?: string;
}

export interface SessionEndedEvent {
  reason: string;
}

export interface ErrorEvent {
  message: string;
}

// ── Session configuration ───────────────────────────────

export interface CreateSessionConfig {
  /** Agent-specific model identifier (e.g. "claude-opus-4.6-1m") */
  model?: string;
  /** Working directory for the session */
  cwd?: string;
  /** Caller-supplied session ID (adapter may ignore) */
  sessionId?: string;
}

// ── Session info returned by listSessions ───────────────

export interface SessionInfo {
  id: string;
  state: 'active' | 'idle' | 'ended';
  model?: string;
  cwd?: string;
  summary?: string;
}

// ── Permission decision type ────────────────────────────

export type PermissionDecision = 'approve' | 'deny' | 'always_allow';

// ── The adapter interface ───────────────────────────────

export abstract class AgentAdapter {
  // --- Callbacks (set by the tentacle runtime) ---

  onSessionCreated: ((event: SessionCreatedEvent) => void) | null = null;
  onMessage: ((sessionId: string, event: MessageEvent) => void) | null = null;
  onMessageDelta: ((sessionId: string, event: MessageDeltaEvent) => void) | null = null;
  onPermissionRequest: ((sessionId: string, event: PermissionRequestEvent) => void) | null = null;
  /** Called when a permission is auto-resolved (e.g. by "Always Allow" for same tool kind) */
  onPermissionAutoResolved: ((sessionId: string, permissionId: string) => void) | null = null;
  onQuestionRequest: ((sessionId: string, event: QuestionRequestEvent) => void) | null = null;
  onToolStart: ((sessionId: string, event: ToolStartEvent) => void) | null = null;
  onToolComplete: ((sessionId: string, event: ToolCompleteEvent) => void) | null = null;
  onIdle: ((sessionId: string) => void) | null = null;
  onError: ((sessionId: string, event: ErrorEvent) => void) | null = null;
  onSessionEnded: ((sessionId: string, event: SessionEndedEvent) => void) | null = null;

  // --- Lifecycle ---

  /** Start the adapter (e.g. spawn CLI server). */
  abstract start(): Promise<void>;

  /** Stop the adapter and release all resources. */
  abstract stop(): Promise<void>;

  // --- Session management ---

  /** Create a new agent session. */
  abstract createSession(config: CreateSessionConfig): Promise<{ sessionId: string }>;

  /** Resume a previously created session with recovery context. */
  abstract resumeSession(sessionId: string, context?: SessionContext): Promise<{ sessionId: string }>;

  /** Send a user message to a session. */
  abstract sendMessage(sessionId: string, text: string, attachments?: string[]): Promise<void>;

  /** Respond to a pending permission request. */
  abstract respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void>;

  /** Respond to a pending agent question. */
  abstract respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
    wasFreeform: boolean,
  ): Promise<void>;

  /** Kill / disconnect a session. */
  abstract killSession(sessionId: string): Promise<void>;

  /** Abort the current turn (session stays alive). Override in concrete adapters. */
  async abortSession(_sessionId: string): Promise<void> { /* no-op by default */ }

  /** List known sessions. */
  abstract listSessions(): Promise<SessionInfo[]>;

  /** List available models. Override in concrete adapters. */
  async listModels(): Promise<string[]> { return []; }

  /** Set permission mode for a session. Override in concrete adapters. */
  setSessionMode(_sessionId: string, _mode: 'ask' | 'auto'): void { /* no-op by default */ }
}
