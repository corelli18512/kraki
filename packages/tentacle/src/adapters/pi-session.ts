/** Per-session state of the Pi adapter and its timing constants, system prompt and limits. */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SessionUsage } from '@kraki/protocol';
import { createLogger } from '../logger.js';
import { TurnTracker } from './turn-tracker.js';
import { KRAKI_MODES_PROMPT } from './permission-policy.js';
import { type Mode } from './pi-permissions.js';
import { PiRpcProcess } from './pi-rpc.js';

export const LEGACY_SHOW_HTML_MAX_BYTES = 10 * 1024 * 1024;

export const logger = createLogger('pi-adapter');

/** The subset of pi's `message_update.assistantMessageEvent` the adapter reads. */
export interface AssistantStreamEvent {
  type: string;
  delta?: string;
}
export const PROMPT_ACK_GRACE_MS = 30_000;
export const PROMPT_WATCHDOG_INTERVAL_MS = 5_000;
export const PROMPT_PROBE_FAILURE_LIMIT = 3;
export const PROMPT_IDLE_STALL_MS = 120_000;

export type ForeignDialogMethod = 'select' | 'input' | 'editor' | 'confirm';

/** How a background-subagent hold ended (logged with its duration). */
export type PiSubagentHoldEnd =
  | 'wake_run' | 'finished_without_wake' | 'no_progress_timeout'
  | 'new_turn' | 'abort' | 'process_exit' | 'respawn' | 'killed' | 'adapter_stop';

export interface PiSession {
  proc: PiRpcProcess;
  cwd: string;
  model: string;
  mode: Mode;
  thinking?: string;
  sessionFile?: string;
  usage: SessionUsage;
  lastActivity: number;
  /** Kraki's view of the current turn: prose segments (narration vs reply),
   *  the held provider error, idle once, and the turn id to stamp. */
  turn: TurnTracker;
  /** Fresh prompt ownership before agent_start. Only preflight maintenance may
   *  use this identity; late provider callbacks must keep eventTurnId. */
  promptPreflight?: { turnId?: string };
  /** Set before the process-exit callback publishes idle, so an in-flight
   *  prompt rejection cannot publish the same terminal idle a second time. */
  exitObserved: boolean;
  /** Outstanding per-call permission requests (permissionId → pi's UI request
   *  id). Cleared when answered or when the child is killed/respawned so the
   *  arm's card doesn't dangle. */
  pendingPerms: Map<string, string>;
  /** Outstanding ask_user questions (questionId → pi's UI request id). Mirrors
   *  pendingPerms — cleared on answer / kill / respawn. */
  pendingQuestions: Map<string, string>;
  /** Open dialogs of OTHER extensions (question id → dialog method). Shown as
   *  plain question cards; answered with plain values, never Kraki's envelope. */
  foreignDialogs?: Map<string, ForeignDialogMethod>;
  /** stopReason of the most recent assistant message_end this turn ('stop' |
   *  'error' | 'aborted' | 'toolUse' | …). 'error'/'aborted' mean the run did
   *  NOT produce a real answer → just idle. */
  lastStopReason: string | undefined;
  /** Pi emitted a non-retrying agent_end, so a following non-retry compaction
   *  may settle the conversational answer before agent_settled. */
  pendingMaintenanceIdle: boolean;
  /** Cancellation handle for a normal prompt whose RPC ACK is still waiting on
   *  Pi preflight (most notably auto-compaction). Pi's generic abort RPC does
   *  not cancel compaction or that queued prompt, so explicit user abort must
   *  retire this transport attempt and terminate the child before it can start
   *  later as a ghost turn. */
  promptAcceptanceAbort?: AbortController;
  /** True from sending an abort RPC until pi acknowledges that the agent is idle.
   *  Lets abortSession own the aborted turn's terminal boundary. */
  aborting: boolean;
  /** The run settled while background subagents (pi-subagents async runs)
   *  still work. Pi wakes the agent when they finish; the Kraki turn stays
   *  open for that answer. */
  awaitingSubagents?: boolean;
  /** Fallback settle when background runs finished but no wake run came. */
  subagentGrace?: ReturnType<typeof setTimeout>;
  /** Upper bound on the hold: settles when background runs show no progress
   *  (a changed status snapshot or a notification) for SUBAGENT_HOLD_IDLE_MS. */
  subagentHoldTimer?: ReturnType<typeof setTimeout>;
  /** When the current logical turn began (resetTurnTracking), for elapsedMs. */
  turnStartedAt?: number;
  /** Pi's current auto-retry attempt (auto_retry_start), until auto_retry_end. */
  retryAttempt?: number;
  /** When the running compaction began, for its end log. */
  compactionStartedAt?: number;
  /** The stall warning was logged for the current silence (reset by activity). */
  stallWarned?: boolean;
  /** When the current background-subagent hold began (for its end log). */
  subagentHoldSince?: number;
  /** The last pi-subagents status snapshot's runs, serialized: an identical
   *  repaint is not progress. */
  subagentSnapshotKey?: string;
}

/** A subagent's saved output file (pi-subagents notifications point at it),
 *  shown as the subagent's report. Only the extension's own artifact files
 *  (`…/subagent-artifacts/outputs/….md`), and only small ones. */
export function readSubagentOutput(path: string): string | undefined {
  try {
    if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) return undefined;
    if (!/[\\/]subagent-artifacts[\\/]outputs[\\/].+\.(md|txt)$/.test(path)) return undefined;
    if (statSync(path).size > 64 * 1024) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export const EVICTION_INTERVAL_MS = 5 * 60_000;
export const IDLE_TTL_MS = 30 * 60_000;
/** An open turn with no pi event for this long is logged as stalled (once
 *  per silence). Background-subagent holds have their own bound. */
export const TURN_STALL_WARN_MS = 15 * 60_000;

/** Describes the Kraki UI to the model so it narrates naturally instead of
 *  tagging its own messages. Appended to pi's system prompt on every spawn. */
export const KRAKI_SYSTEM_PROMPT =
  'You are operating inside Kraki, a remote-control harness. Communicate with the ' +
  'human by writing ordinary assistant prose — it IS your reply and is shown to ' +
  'them directly. You do NOT need any special tool to "send" a message; just ' +
  'write. Narrate preamble, thinking, and progress as prose while you work, and ' +
  'end your turn with a short, self-contained final answer. IMPORTANT: your LAST ' +
  'paragraph of prose is used verbatim as the final reply to the user, with no ' +
  'rewriting or summarization step in between — so make that last paragraph a ' +
  'complete, standalone answer on its own, not a segue or a teaser. Kraki takes ' +
  'care of ' +
  'settling that final message into the chat, so you never manage bubbles ' +
  'yourself. To get a decision or missing information from the human, call the ' +
  'ask_user tool (it blocks and returns their answer). To visually show the human ' +
  'an image (a screenshot, diagram, chart, or generated graphic they cannot ' +
  'already see), call the show_image tool with the file path. When you write a report for ' +
  'the human to read (analysis, design, investigation), save it as a text-first HTML file ' +
  'and call show_report before concluding so it remains accessible in the producing ' +
  'message. show_report is a report viewer, not a browser: for web pages, apps, or when ' +
  'the human asks to open something in a browser, use the shell (e.g. `open`).\n\n' + KRAKI_MODES_PROMPT;


export interface PromptWatchdogOptions {
  ackGraceMs: number;
  intervalMs: number;
  probeFailureLimit: number;
  idleStallMs: number;
}
