/** Claude adapter state: SDK types, per-session entry, pending permissions/questions, the input channel. */

import { type CreateSessionConfig } from './base.js';
import { createLogger } from '../logger.js';
import { TurnTracker } from './turn-tracker.js';

export const logger = createLogger('claude-adapter');

// ── Lazy SDK import types ───────────────────────────────
// We import the SDK dynamically so the module can be loaded even when
// @anthropic-ai/claude-agent-sdk is not installed — the adapter simply
// throws at start() in that case.

export type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage;
export type SDKAssistantMessage = import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage;
export type SDKResultMessage = import('@anthropic-ai/claude-agent-sdk').SDKResultMessage;
export type SDKSystemMessage = import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage;
export type SDKPartialAssistantMessage = import('@anthropic-ai/claude-agent-sdk').SDKPartialAssistantMessage;
export type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
export type Options = import('@anthropic-ai/claude-agent-sdk').Options;
export type PermissionMode = import('@anthropic-ai/claude-agent-sdk').PermissionMode;
export type Query = import('@anthropic-ai/claude-agent-sdk').Query;

/** Re-export the SDK's discriminated union for canUseTool return values. */
export type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult;

// ── Types for internal bookkeeping ──────────────────────

export interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  toolKind: string;
  /** The tool call's original input. `updatedInput` REPLACES the tool's
   *  arguments, so an approval must hand the original input back. */
  input: Record<string, unknown>;
}

/** One AskUserQuestion entry from the SDK's `questions` array. */
export interface AskUserQuestionItem {
  question: string;
  options?: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean;
  header?: string;
}

export interface PendingQuestion {
  resolve: (result: PermissionResult) => void;
  questionId: string;
  /** Original questions payload from the SDK, echoed back in the answer.
   *  The SDK's AskUserQuestion `answers` map is keyed by each question's
   *  `question` text, so we need this to build the answer. */
  questions?: AskUserQuestionItem[];
  /** Index (into `questions`) of the question THIS card represents. The SDK
   *  may ask 1–4 questions per call; kraki surfaces them to the user one card
   *  at a time and advances on each answer. */
  qIndex?: number;
  /** Answers collected so far across the serial cards of one AskUserQuestion
   *  call, keyed by question text. Shared (mutated) across the chain. */
  collected?: Record<string, string>;
}

/** A message pushed into the streaming input channel. */
export interface InputChannel {
  push(msg: SDKUserMessage): void;
  end(): void;
}

export interface NormalizedClaudeError {
  message: string;
  status?: number;
  requestId?: string;
  quality: number;
}

/** Everything we track per session. */
export interface SessionEntry {
  query: Query | null;
  abortController: AbortController;
  inputChannel: InputChannel;
  inputIterable: AsyncIterable<SDKUserMessage>;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  sessionId: string;
  model?: string;
  consumerLoop: Promise<void>;
  /** Deferred config — used to lazily spawn query() on first sendMessage */
  deferredConfig?: CreateSessionConfig & { resume?: string; fork?: boolean };
  /** Kraki's view of the current turn: prose (narration vs reply), user stop,
   *  idle once. Created with the Kraki session id. */
  turn: TurnTracker;
  /** Best error seen this turn (Claude reports several; keep the most useful). */
  pendingError?: NormalizedClaudeError;
  /** Results still owed by user-stopped turns whose SDK result had not
   *  arrived when the next prompt was sent. The SDK processes input in order,
   *  so the next N results (and prose before them) belong to those turns. */
  staleResults?: number;
  /** Claude Code reported status=compacting and no end has been seen yet. */
  compacting?: boolean;
  /** Subagent tasks (Agent/Task tool) still running, by SDK task id. Claude
   *  Code runs them in the background by default and, when one finishes,
   *  wakes the parent with a new provider turn on its own. */
  runningSubagents?: Set<string>;
  /** Subagent task id (= canUseTool agentID) → its task description. */
  subagentLabels?: Map<string, string>;
  /** Agent/Task tool calls that dispatched a subagent, by tool_use id. */
  dispatches?: Map<string, ClaudeDispatch>;
  /** Subagent task id → dispatching tool_use id. */
  taskDispatch?: Map<string, string>;
  /** Each subagent's latest prose, held until a further step shows it was
   *  narration — its final words are its report (the dispatch's result). */
  subagentDrafts?: Map<string, string>;
  /** The parent's provider turn ended while subagents were still running;
   *  the Kraki turn stays open for the continuation Claude Code starts. */
  awaitingSubagents?: boolean;
  /** Fallback settle when subagents finished but no continuation came. */
  subagentSettleTimer?: ReturnType<typeof setTimeout>;
  /** The Kraki turn has been held open at least once for subagents; it stays
   *  set across Claude Code's continuation turns until the turn settles. */
  subagentPhase?: boolean;
  /** Subagent completions seen during the phase whose continuation turn has
   *  not finished yet (Claude Code wakes the parent once per completion). */
  owedContinuations?: number;
  reasoningEffort?: string;
}

/** One Agent/Task tool call and the subagent it started. */
export interface ClaudeDispatch {
  info: import('@kraki/protocol').SubagentInfo;
  /** The SDK task running it (background agents report through it). */
  taskId?: string;
  /** The tool already returned a background launch receipt. */
  receipt?: boolean;
  /** Its terminal tool_complete was emitted. */
  done?: boolean;
  /** Report text from task_notification (background agents). */
  summary?: string;
}

/** Tools that dispatch a Claude Code subagent. */
export const CLAUDE_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

// ── Helpers ─────────────────────────────────────────────

export function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a streaming input channel (AsyncIterable<SDKUserMessage>).
 * Messages pushed via `push()` are yielded by the async iterator.
 * Call `end()` to close the channel.
 */
export function createInputChannel(): { iterable: AsyncIterable<SDKUserMessage>; channel: InputChannel } {
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  const queue: SDKUserMessage[] = [];
  let done = false;

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
          }
          return new Promise<IteratorResult<SDKUserMessage>>((r) => { resolve = r; });
        },
      };
    },
  };

  const channel: InputChannel = {
    push(msg: SDKUserMessage) {
      if (done) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as unknown as SDKUserMessage, done: true });
      }
    },
  };

  return { iterable, channel };
}
