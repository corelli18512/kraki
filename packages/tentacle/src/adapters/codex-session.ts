/** Codex adapter state: sessions, pending cards, queued input, sidecar, child threads, modes and models. */

import type { Attachment, ModelDetail, ReasoningEffort, SessionUsage } from '@kraki/protocol';
import { type RpcId } from './codex-rpc.js';
import { createLogger } from '../logger.js';
import { DEFAULT_SESSION_MODE } from '@kraki/protocol';
import { TurnTracker } from './turn-tracker.js';
import { krakiAutoApproves, type SessionMode } from './permission-policy.js';

export const logger = createLogger('codex-adapter');

export type Mode = SessionMode;
export const DEFAULT_MODE: Mode = DEFAULT_SESSION_MODE;
export const KRAKI_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
// ── Pure helpers (exported for tests) ─────────────────────

/** Codex only asks the client for commands and file changes (reads run under
 *  its own safe-command list), so both are side effects for Kraki's policy. */
export function codexShouldAutoApprove(mode: Mode, kind: 'shell' | 'write'): boolean {
  return krakiAutoApproves(mode, kind);
}

/** Map Codex model/list entries to Kraki ModelDetail. */
export function mapCodexModels(data: unknown): ModelDetail[] {
  if (!Array.isArray(data)) return [];
  const out: ModelDetail[] = [];
  for (const raw of data as Array<Record<string, unknown>>) {
    if (!raw || raw.hidden === true) continue;
    const id = typeof raw.id === 'string' ? raw.id : typeof raw.model === 'string' ? raw.model : '';
    if (!id) continue;
    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? (raw.supportedReasoningEfforts as Array<{ reasoningEffort?: string }>)
        .map((e) => e?.reasoningEffort)
        .filter((e): e is ReasoningEffort => KRAKI_EFFORTS.includes(e as ReasoningEffort))
      : [];
    const def = KRAKI_EFFORTS.includes(raw.defaultReasoningEffort as ReasoningEffort)
      ? raw.defaultReasoningEffort as ReasoningEffort : undefined;
    out.push({
      id,
      name: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
      supportsReasoningEffort: efforts.length > 0,
      ...(efforts.length > 0 && { supportedReasoningEfforts: efforts }),
      ...(def && { defaultReasoningEffort: def }),
    });
  }
  return out;
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Session state ─────────────────────────────────────────

export interface PendingPermission {
  rpcId: RpcId;
  kind: 'command' | 'file' | 'permissions';
  toolKind: 'shell' | 'write';
  params: Record<string, unknown>;
}

export interface PendingQuestion {
  rpcId: RpcId;
  source: 'ask_user' | 'native';
  /** native request_user_input: questions answered one card at a time. */
  questions?: Array<{ id: string; question: string; options?: Array<{ label: string }> | null }>;
  index?: number;
  collected?: Record<string, { answers: string[] }>;
}

export interface QueuedInput {
  text: string;
  attachments?: Attachment[];
  relayTurnId?: string;
}

export interface CodexSession {
  sessionId: string;
  threadId?: string;
  /** Thread attached to the CURRENT app-server process. */
  loaded: boolean;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
  mode: Mode;
  modeSignal?: Mode;
  activeTurnId?: string;
  /** A turn/start is in flight (response not yet received). */
  starting: boolean;
  /** Abort requested before the Codex turn id was known. */
  abortPending: boolean;
  /** Recently settled Codex turn ids — late events for them are dropped. */
  settledTurns: string[];
  /** commandExecution item ids started by the current turn. Codex's
   *  turn/interrupt leaves running commands alive (verified 0.157.1), so
   *  abort terminates exactly these via thread/backgroundTerminals. */
  turnCommandItems: Set<string>;
  /** Kraki's view of the current turn: reply vs narration, error, user stop,
   *  idle once. A queued steer of the same relay turn continues it. */
  turn: TurnTracker;
  tools: Map<string, { toolName: string; args: Record<string, unknown> }>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  queue: QueuedInput[];
  usage?: SessionUsage;
}

export interface SessionSidecar {
  threadId?: string;
  cwd?: string;
  model?: string;
  effort?: ReasoningEffort;
}

export interface CodexAdapterOptions {
  /** Absolute path to the `codex` executable. */
  cliPath: string;
  /** Extra argv before `app-server` (tests use `node fake.js`). */
  cliArgs?: string[];
  attachmentStore?: import('../attachment-store.js').AttachmentStore;
  /** Override the Kraki sessions dir (tests). Defaults to <configDir>/sessions. */
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

/** A subagent thread spawned (directly or nested) by a session's thread. */
export interface CodexChildThread {
  sessionId: string;
  label: string;
  /** Synthetic trace step standing for this subagent (its dispatch). */
  dispatchId?: string;
  /** The dispatch step of the subagent that spawned this one (nesting). */
  parentDispatchId?: string;
  task?: string;
  tokens?: number;
  /** Open tool items of the child, by item id. */
  tools: Map<string, { toolName: string }>;
  /** The child's latest prose: narration once a step follows, else its report. */
  draft?: string;
  done?: boolean;
}
