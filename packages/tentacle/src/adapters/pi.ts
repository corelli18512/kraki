/**
 * PiAdapter — bridges Kraki's tentacle to the pi coding agent
 * (`@earendil-works/pi-coding-agent`) via its `--mode rpc` JSON protocol.
 *
 * Design (pi-first, no backward-compat constraints):
 *  - **process-per-session**: every Kraki session owns one `pi --mode rpc`
 *    child. True isolation — one crash never touches another. Memory is
 *    bounded by killing idle children; pi re-resumes from its jsonl on the
 *    next message (lazy resume).
 *  - **permission**: the Kraki tools extension gates every tool call through
 *    the adapter, which applies Kraki's shared policy (permission-policy.ts)
 *    for the live mode — no respawn on a mode change.
 *  - native fork/tree via pi's `fork` / `get_tree` RPC commands.
 */

import { agentEnv } from '../agent-env.js';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cliSpawnArgs } from '../cli-launch.js';
import { PiSubagentTracker, type PiSubagentEmit } from './pi-subagent.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentAdapter, type CreateSessionConfig, type SessionInfo, type PermissionDecision, type QuestionAnswer, type QuestionResponseResult, type PermissionResponseResult, type SendMessageOptions } from './base.js';
import type { SessionContext } from '../session-manager.js';
import type { ModelDetail, SessionUsage, ReasoningEffort } from '@kraki/protocol';
import { getKrakiHome, getConfigDir } from '../config.js';
import { PI_KRAKI_TOOLS_SOURCE } from './pi-kraki-tools.js';
import { normalizeSessionMode } from '@kraki/protocol';
import { TurnTracker } from './turn-tracker.js';
import { DELEGATE_ANSWER, modeChangeSignal, type SessionMode } from './permission-policy.js';
import { TITLE_SYSTEM_PROMPT, buildTitlePrompt, cleanTitle, type TitleContext } from './title.js';
import { tmpdir } from 'node:os';
import { cloneFile } from '../fs-clone.js';
import { handleEvent, krakiAnswerEnvelope, PI_CONFIRM_CHOICES } from './pi-events.js';
import { fetchModels, ensureRawModels, clearModelRetry, getDefaultModel, fetchEfforts } from './pi-models.js';
import { effortToThinking, type PiModelRow, PI_LIST_MODELS_TIMEOUT_MS, PI_LIST_MODELS_RETRY_DELAYS_MS, FALLBACK_EFFORTS, defaultEffortFor } from './pi-catalog.js';
import { type Mode, MUTATING_DEFAULT_MODE, toolsForMode } from './pi-permissions.js';
import { PiRpcProcess } from './pi-rpc.js';
import { logger, PROMPT_ACK_GRACE_MS, PROMPT_WATCHDOG_INTERVAL_MS, PROMPT_PROBE_FAILURE_LIMIT, PROMPT_IDLE_STALL_MS, type PiSession, readSubagentOutput, EVICTION_INTERVAL_MS, IDLE_TTL_MS, KRAKI_SYSTEM_PROMPT, type PromptWatchdogOptions } from './pi-session.js';
export { effortToThinking, type PiListModelsError, summarizeCrash, runPiListModels, type PiCatalogModel, FALLBACK_EFFORTS, piThinkingLevelsFor, defaultEffortFor, queryPiCatalog } from './pi-catalog.js';
export { piToolKind, shouldAutoApprove, parsePiPermission } from './pi-permissions.js';
export { type PiRpcEvent, type PiRpcOptions } from './pi-rpc.js';
export { readSubagentOutput, KRAKI_SYSTEM_PROMPT } from './pi-session.js';

/** The prompt watchdog gave up while the prompt request may still be pending
 *  inside pi (no ACK and no rejection). */
class PromptWatchdogError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
//  Section 5 — adapter public methods
// ─────────────────────────────────────────────────────────────────────────────

export class PiAdapter extends AgentAdapter {
  cliPath: string;
  readonly modelListTimeoutMs: number;
  readonly modelListRetryDelaysMs: number[];
  readonly attachmentStore?: import('../attachment-store.js').AttachmentStore;
  private readonly promptWatchdog: PromptWatchdogOptions;
  sessions = new Map<string, PiSession>();
  /** Keep the start owner until maintenance ends, even across a queued turn. */
  private compactingSessions = new Map<string, { turnId?: string }>();
  /** Subagent progress per session (pi subagent extensions). */
  subagentTrackers = new Map<string, PiSubagentTracker>();
  private evictTimer: ReturnType<typeof setInterval> | null = null;
  /** Lazily-materialized path to the always-loaded Kraki tools extension. */
  private toolsExtPath: string | null = null;
  /** Edge-triggered mode-change signals, held at the ADAPTER level so they
   *  survive across turns: prepended as a one-shot marker to the next user
   *  message (the meta sidecar / kraki_get_mode stays the source of truth). */
  private pendingModeSignals = new Map<string, Mode>();

  constructor(opts: {
    cliPath: string;
    attachmentStore?: import('../attachment-store.js').AttachmentStore;
    /** Test-only timing override; production uses conservative defaults. */
    promptWatchdog?: Partial<PromptWatchdogOptions>;
    /** Test-only: `--list-models` timeout and retry backoff. */
    modelListTimeoutMs?: number;
    modelListRetryDelaysMs?: number[];
  }) {
    super();
    this.cliPath = opts.cliPath;
    this.modelListTimeoutMs = opts.modelListTimeoutMs ?? PI_LIST_MODELS_TIMEOUT_MS;
    this.modelListRetryDelaysMs = opts.modelListRetryDelaysMs ?? PI_LIST_MODELS_RETRY_DELAYS_MS;
    this.attachmentStore = opts.attachmentStore;
    this.promptWatchdog = {
      ackGraceMs: opts.promptWatchdog?.ackGraceMs ?? PROMPT_ACK_GRACE_MS,
      intervalMs: opts.promptWatchdog?.intervalMs ?? PROMPT_WATCHDOG_INTERVAL_MS,
      probeFailureLimit: opts.promptWatchdog?.probeFailureLimit ?? PROMPT_PROBE_FAILURE_LIMIT,
      idleStallMs: opts.promptWatchdog?.idleStallMs ?? PROMPT_IDLE_STALL_MS,
    };
  }

  /** Write the embedded Kraki tools extension to a stable on-disk path and
   *  return it. The source is inlined in the tentacle SEA bundle, so it can't be
   *  referenced from a repo path at runtime — we materialize it once (rewriting
   *  on every daemon start so upgrades ship the current source). */
  private ensureToolsExtension(): string {
    if (this.toolsExtPath) return this.toolsExtPath;
    const dir = join(getConfigDir(), 'pi-extensions');
    const path = join(dir, 'kraki-tools.ts');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, PI_KRAKI_TOOLS_SOURCE, 'utf8');
      this.toolsExtPath = path;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'failed to materialize pi tools extension');
    }
    return path;
  }

  /** Co-located storage: pi's private transcript and the adapter recovery
   *  sidecar both live inside the Kraki session dir (sessions/<id>/), so the
   *  session is self-contained — nothing leaks into a global scratch area and a
   *  daemon restart can resume by convention instead of a separate pointer. */
  private storeDir(sessionId: string): string {
    return join(getConfigDir(), 'sessions', sessionId);
  }
  /** pi's private LLM-context store (pi writes it natively via `--session`). */
  private transcriptPath(sessionId: string): string {
    return join(this.storeDir(sessionId), 'pi.jsonl');
  }
  /** Adapter recovery sidecar: cwd (pi is project-scoped), model/mode/thinking,
   *  transcript path — the durable bits needed to re-spawn after a restart. */
  private sidecarPath(sessionId: string): string {
    return join(this.storeDir(sessionId), '.pi-adapter.json');
  }
  /** Pre-co-location sidecar location (global scratch dir). Read-only fallback
   *  so sessions created before this change still resume. */
  private legacySidecarPath(sessionId: string): string {
    return join(getKrakiHome(), 'pi-adapter', `${sessionId}.json`);
  }

  /** Persist the durable bits needed to re-spawn this session after a daemon
   *  restart, alongside pi's transcript in the session dir. */
  private persistMeta(sessionId: string, s: PiSession): void {
    try {
      mkdirSync(this.storeDir(sessionId), { recursive: true });
      writeFileSync(
        this.sidecarPath(sessionId),
        JSON.stringify({ cwd: s.cwd, model: s.model, mode: s.mode, thinking: s.thinking, sessionFile: s.sessionFile }),
        'utf8',
      );
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'persistMeta failed');
    }
  }

  private loadMeta(sessionId: string): Partial<Pick<PiSession, 'cwd' | 'model' | 'mode' | 'thinking' | 'sessionFile'>> | null {
    for (const p of [this.sidecarPath(sessionId), this.legacySidecarPath(sessionId)]) {
      if (!existsSync(p)) continue;
      try {
        const meta = JSON.parse(readFileSync(p, 'utf8'));
        // Sidecars may still carry the legacy wire name `execute`.
        if (meta && typeof meta === 'object' && 'mode' in meta) meta.mode = normalizeSessionMode(meta.mode);
        return meta;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** Record an explicit user model choice before resuming a dead pi process.
   *  pi restores the active model from the session tree before RPC starts, so a
   *  retired provider in the previous model_change can otherwise prevent the
   *  process from starting far enough to receive set_model. */
  private appendModelChange(sessionFile: string, provider: string, modelId: string): string | null {
    if (!existsSync(sessionFile)) return null;
    const original = readFileSync(sessionFile, 'utf8');
    const lines = original.split('\n').filter(line => line.trim().length > 0);
    let last: { id?: string } | undefined;
    try {
      last = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) as { id?: string } : undefined;
    } catch {
      last = undefined; // a torn last line: chain from nothing rather than throw
    }
    const entry = {
      type: 'model_change',
      id: randomUUID().replaceAll('-', '').slice(0, 8),
      parentId: last?.id ?? null,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    const separator = original.length > 0 && !original.endsWith('\n') ? '\n' : '';
    appendFileSync(sessionFile, `${separator}${JSON.stringify(entry)}\n`, 'utf8');
    return original;
  }

  async start(): Promise<void> {
    this.evictTimer = setInterval(() => this.sweepIdle(), EVICTION_INTERVAL_MS);
    logger.info('PiAdapter started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearModelRetry(this);
    if (this.evictTimer) clearInterval(this.evictTimer);
    for (const s of this.sessions.values()) {
      this.stopAwaitingSubagents(s);
      s.proc.kill();
    }
    this.sessions.clear();
    this.compactingSessions.clear();
  }

  private blankUsage(): SessionUsage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0, totalDurationMs: 0 };
  }

  private resolveModelId(model: string): [string, string] {
    const separator = model.indexOf('/');
    return separator < 0
      ? [getDefaultModel(this).split('/')[0], model]
      : [model.slice(0, separator), model.slice(separator + 1)];
  }

  private spawn(sessionId: string, cwd: string, model: string, mode: Mode, sessionFile?: string, thinking?: string): PiSession {
    const previous = this.sessions.get(sessionId);
    if (previous) this.stopAwaitingSubagents(previous);
    const [provider, modelId] = this.resolveModelId(model);
    // Export the meta sidecar path so the extension's kraki_get_mode reads the
    // live permission mode (the adapter, via persistMeta, is the source of truth).
    // The gate itself is loaded in every mode; the adapter decides silent-approve
    // vs card per shouldAutoApprove, so a mode change never respawns pi.
    const env = agentEnv({ KRAKI_META_FILE: this.sidecarPath(sessionId) });
    const proc = new PiRpcProcess({
      cliPath: this.cliPath,
      cwd,
      provider,
      model: modelId,
      tools: toolsForMode(mode),
      sessionFile,
      thinking,
      appendSystemPrompt: KRAKI_SYSTEM_PROMPT,
      extensionPath: this.ensureToolsExtension(),
      env,
    });
    const sess: PiSession = { proc, cwd, model, mode, thinking, sessionFile, usage: this.blankUsage(), lastActivity: Date.now(), turn: new TurnTracker(this, sessionId), exitObserved: false, pendingPerms: new Map(), pendingQuestions: new Map(), lastStopReason: undefined, pendingMaintenanceIdle: false, aborting: false };
    // A respawn (lazy resume) keeps the relay turn assigned before it: the
    // prompt that follows belongs to it. Only the id carries over — a late exit
    // event of the old process must not touch the new process's turn.
    sess.turn.relayTurnId = this.sessions.get(sessionId)?.turn.relayTurnId;
    // Events are handled strictly in order: handleEvent awaits (image resize
    // on tool_execution_end), and an unawaited dispatch let a later
    // message_end/agent_settled settle the turn before that tool_complete,
    // which the relay then dropped. Process exit queues behind them too.
    let events: Promise<void> = Promise.resolve();
    const enqueue = (work: () => void | Promise<void>) => {
      events = events.then(work).catch((err) => logger.error({ err, sessionId }, 'Pi event handling failed'));
    };
    // Queued events of a process that has since been replaced (lazy resume
    // while its queue was still draining) must not touch the replacement.
    proc.onEvent = (e) => enqueue(() => (this.sessions.get(sessionId) === sess ? handleEvent(this, sessionId, e) : undefined));
    proc.onExit = (code) => enqueue(() => this.handleProcessExit(sessionId, sess, code));
    proc.start();
    this.sessions.set(sessionId, sess);
    // Write the meta sidecar up front so KRAKI_META_FILE points at a real file
    // (kraki_get_mode reads it) before the first turn runs.
    this.persistMeta(sessionId, sess);
    return sess;
  }

  private handleProcessExit(sessionId: string, sess: PiSession, code: number | null = null): void {
    // Process gone (crash/kill) means agent_settled may never arrive.
    // Permissions cannot be reconstructed, but ask_user is durable at
    // RelayClient/CardManager: keep its id/card so the next answer can use a
    // recovery prompt after lazy resume.
    sess.exitObserved = true;
    this.stopAwaitingSubagents(sess);
    if (this.sessions.get(sessionId) !== sess) {
      // A replacement process already owns the session: this late exit must
      // not cancel its cards, evict it, or announce anything for it.
      sess.turn.settleSilently();
      return;
    }
    // Background runs of the dead process will never report to a new one.
    const retired = this.subagentTrackers.get(sessionId)?.retirePending() ?? [];
    this.emitSubagentSteps(sessionId, sess, retired);
    this.clearPendingPerms(sessionId);
    this.pendingModeSignals.delete(sessionId);
    if (!sess.turn.isSettled && !sess.aborting && sess.pendingQuestions.size > 0) {
      // Waiting on ask_user: the turn is not failed. Relay keeps the question
      // recoverable on eviction and turns the answer into a recovery prompt.
      sess.turn.settleSilently();
      this.onSessionEvicted?.(sessionId);
      return;
    }
    // A prompt still in preflight never reached agent_start: its failure
    // belongs to that prompt, not to the previous run.
    if (sess.promptPreflight && !sess.turn.isSettled) sess.turn.captureTurnId();
    // A concrete provider error must cross the adapter boundary before idle;
    // otherwise Relay would freeze the turn as successful on process death.
    let error = sess.turn.pendingError;
    if (!error && !sess.aborting && !sess.turn.isSettled) {
      // Pi died mid-turn (crash, killed, broken runtime). Without this the
      // turn ends silently and clients show an empty "no reply" turn.
      const reason = sess.proc.crashReason();
      const exit = code === null ? '' : ` (exit code ${code})`;
      logger.warn({ sessionId, code, reason }, 'pi exited during a turn');
      error = `Pi stopped unexpectedly${exit}${reason ? `: ${reason}` : ''}`;
    }
    sess.turn.clearError();
    if (sess.turn.isSettled) {
      if (error) this.emitError(sessionId, sess, error);
    } else {
      // Unfinished prose is never a reply when the process died.
      sess.turn.discardProse();
      sess.turn.finish({ error });
    }
    this.onSessionEvicted?.(sessionId);
  }

  /** Drop any outstanding permission cards for a session (child died / respawn)
   *  so the arm doesn't wait on a decision that can never reach pi. */
  private clearPendingPerms(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.pendingPerms.size === 0) return;
    for (const permId of s.pendingPerms.keys()) {
      this.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
    }
    s.pendingPerms.clear();
  }

  /** Drop any outstanding ask_user questions (child died / respawn) so the arm's
   *  question card doesn't dangle on a pi that can never answer it. */
  private clearPendingQuestions(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.pendingQuestions.size === 0) return;
    for (const questionId of s.pendingQuestions.keys()) {
      this.onQuestionAutoResolved?.(sessionId, questionId);
    }
    s.pendingQuestions.clear();
    s.foreignDialogs?.clear();
  }

  touch(id: string) {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = Date.now();
  }

  setCompacting(
    sessionId: string,
    active: boolean,
    event: Omit<import('./base.js').CompactionEvent, 'phase'> = {},
  ): void {
    if (active) {
      if (this.compactingSessions.has(sessionId)) return;
      const s = this.sessions.get(sessionId);
      // Pi may compact BEFORE agent_start (e.g. after a smaller-model switch).
      // eventTurnId still belongs to the previous run in that interval.
      const owner = s?.promptPreflight ?? this.lifecycleEvent(s);
      this.compactingSessions.set(sessionId, owner);
      this.onCompaction?.(sessionId, { phase: 'start', ...event, ...owner });
      return;
    }
    const owner = this.compactingSessions.get(sessionId);
    if (!this.compactingSessions.delete(sessionId)) return;
    this.onCompaction?.(sessionId, { phase: 'end', ...event, ...owner });
  }

  normalizeCompactionReason(value: unknown): import('./base.js').CompactionReason | undefined {
    return value === 'manual' || value === 'threshold' || value === 'overflow' ? value : undefined;
  }

  lifecycleEvent(s?: PiSession): { turnId?: string } {
    return s ? s.turn.event() : {};
  }

  private emitError(sessionId: string, s: PiSession, message: string): void {
    this.onError?.(sessionId, { message, ...this.lifecycleEvent(s) });
  }

  subagentTracker(sessionId: string): PiSubagentTracker {
    let t = this.subagentTrackers.get(sessionId);
    if (!t) { t = new PiSubagentTracker(readSubagentOutput); this.subagentTrackers.set(sessionId, t); }
    return t;
  }

  /** Forward subagent steps from the tracker to Kraki's trace. */
  emitSubagentSteps(sessionId: string, s: PiSession | undefined, emits: PiSubagentEmit[]): void {
    for (const em of emits) {
      const turn = this.lifecycleEvent(s);
      if (em.kind === 'narration') this.onNarrationTrace?.(sessionId, { ...turn, content: em.content, parentToolCallId: em.parentToolCallId });
      else if (em.kind === 'start') {
        this.onToolStart?.(sessionId, { ...turn, toolName: em.toolName, args: em.args, toolCallId: em.toolCallId, ...(em.parentToolCallId && { parentToolCallId: em.parentToolCallId }), ...(em.subagent && { subagent: em.subagent }) });
      } else {
        this.onToolComplete?.(sessionId, { ...turn, toolName: em.toolName, result: em.result, success: em.success, toolCallId: em.toolCallId, ...(em.parentToolCallId && { parentToolCallId: em.parentToolCallId }), ...(em.subagent && { subagent: em.subagent }) });
      }
    }
  }

  stopAwaitingSubagents(s: PiSession): void {
    s.awaitingSubagents = false;
    if (s.subagentGrace) clearTimeout(s.subagentGrace);
    s.subagentGrace = undefined;
    if (s.subagentHoldTimer) clearTimeout(s.subagentHoldTimer);
    s.subagentHoldTimer = undefined;
  }

  /** (Re)start the hold's inactivity bound: background runs that report
   *  nothing for SUBAGENT_HOLD_IDLE_MS are given up on and the turn settles. */
  private armSubagentHoldTimer(sessionId: string, s: PiSession): void {
    if (s.subagentHoldTimer) clearTimeout(s.subagentHoldTimer);
    s.subagentHoldTimer = setTimeout(() => {
      if (!s.awaitingSubagents || this.sessions.get(sessionId) !== s) return;
      logger.warn({ sessionId }, 'pi background subagents reported nothing for too long; settling');
      this.emitSubagentSteps(sessionId, s, this.subagentTrackers.get(sessionId)?.retirePending() ?? []);
      this.stopAwaitingSubagents(s);
      s.turn.finish();
    }, PiAdapter.SUBAGENT_HOLD_IDLE_MS);
  }

  /** At the run boundary: keep the Kraki turn open while background subagents
   *  still work (pi wakes the agent with their results). */
  holdForSubagents(sessionId: string, s: PiSession): boolean {
    const tracker = this.subagentTrackers.get(sessionId);
    if (!tracker || tracker.activeAsyncRuns() === 0) return false;
    // Prose so far ("started…") is an intermediate step, not the reply.
    s.turn.holdOpen();
    s.awaitingSubagents = true;
    this.armSubagentHoldTimer(sessionId, s);
    logger.info({ sessionId, running: tracker.activeAsyncRuns() }, 'pi turn held open for background subagents');
    return true;
  }

  /** Background runs may have finished: if no wake run follows, settle. */
  checkSubagentsDone(sessionId: string, s: PiSession): void {
    if (!s.awaitingSubagents) return;
    this.armSubagentHoldTimer(sessionId, s);
    if (this.subagentTrackers.get(sessionId)?.activeAsyncRuns()) return;
    if (s.subagentGrace) clearTimeout(s.subagentGrace);
    s.subagentGrace = setTimeout(() => {
      if (!s.awaitingSubagents || this.sessions.get(sessionId) !== s) return;
      logger.info({ sessionId }, 'pi background subagents finished without a wake run; settling');
      this.stopAwaitingSubagents(s);
      s.turn.finish();
    }, PiAdapter.SUBAGENT_CONTINUATION_GRACE_MS);
  }

  static SUBAGENT_CONTINUATION_GRACE_MS = 5_000;
  static SUBAGENT_HOLD_IDLE_MS = 30 * 60_000;

  /**
   * Settle the user-visible answer once Pi has confirmed a non-retrying run and
   * either maintenance has started or the fully-settled fallback is reached.
   * Compaction remains a separate maintenance callback and can continue after
   * this idle.
   */
  settleConversationalTurnAtAgentEnd(sessionId: string, s: PiSession, willRetry: boolean): void {
    // agent_end.willRetry covers transient retries, NOT every compaction
    // recovery. Only a completed answer may settle before agent_settled.
    if (willRetry || s.aborting || s.turn.isSettled || s.lastStopReason !== 'stop') return;
    if (this.subagentTrackers.get(sessionId)?.activeAsyncRuns()) return;
    if (!s.turn.hasReply) return;
    s.turn.finish();
  }

  setTurnIdentity(sessionId: string, turnId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.turn.relayTurnId = turnId;
    // A new prompt captures its identity at agent_start. Keep the previous
    // snapshot until that boundary so a late callback from the old run cannot
    // fall back to this newly assigned relayTurnId.
  }

  isTurnSettled(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && s.turn.isSettled;
  }

  /** A new logical turn (prompt, follow-up, or a steer after the last settled). */
  private resetTurnTracking(s: PiSession): void {
    this.stopAwaitingSubagents(s);
    s.turn.beginTurn();
    s.lastStopReason = undefined;
    s.pendingMaintenanceIdle = false;
    s.aborting = false;
  }

  /** A fresh prompt can produce maintenance events before its provider run.
   *  Snapshot its owner without relabeling late events from the previous run.
   *  Queued/handled/rejected commands retire the scope at ACK; agent_start may
   *  retire it earlier. A late ACK must not clear a newer submission's scope. */
  private async withPromptPreflight(s: PiSession, submit: () => Promise<unknown>): Promise<void> {
    const preflight = s.turn.relayTurnId ? { turnId: s.turn.relayTurnId } : {};
    s.promptPreflight = preflight;
    try {
      await submit();
    } finally {
      if (s.promptPreflight === preflight) s.promptPreflight = undefined;
    }
  }

  /** Wait for the ORIGINAL prompt's preflight ACK without ever resending it.
   *  After the normal 30s grace, bounded get_state probes distinguish healthy
   *  compaction/streaming from a dead RPC channel or a genuinely idle stall. */
  private async awaitPromptAcceptance(
    sessionId: string,
    s: PiSession,
    promptPayload: Record<string, unknown>,
  ): Promise<void> {
    const cancellation = new AbortController();
    s.promptAcceptanceAbort = cancellation;
    const ack = s.proc.request('prompt', promptPayload, { timeoutMs: null });
    // Attach exactly one terminal observer so returning early on authoritative
    // isStreaming cannot produce an unhandled rejection when the late ACK lands.
    const ackOutcome = ack.then(
      () => ({ kind: 'ack' as const }),
      (error: unknown) => ({ kind: 'error' as const, error: error as Error }),
    );
    const cancelled = new Promise<{ kind: 'cancelled' }>((resolve) => {
      cancellation.signal.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true });
    });
    let delayMs = this.promptWatchdog.ackGraceMs;
    let idleSince: number | null = null;
    let consecutiveProbeFailures = 0;

    try {
      while (true) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = new Promise<{ kind: 'tick' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'tick' }), delayMs);
        });
        const outcome = await Promise.race([ackOutcome, cancelled, tick]);
        if (timer) clearTimeout(timer);
        if (outcome.kind === 'cancelled') return;
        if (outcome.kind === 'ack') return;
        if (outcome.kind === 'error') throw outcome.error;
        if (!s.proc.alive) throw new Error('pi process exited before prompt acceptance');

        delayMs = this.promptWatchdog.intervalMs;
        try {
          const state = await s.proc.request<{
            isStreaming?: boolean;
            isCompacting?: boolean;
          }>('get_state');
          if (cancellation.signal.aborted) return;
          consecutiveProbeFailures = 0;

          if (state.isCompacting) {
            idleSince = null;
            // A deferred probe must not change maintenance for a dead or
            // replaced process. Preserve the original ACK/watchdog outcome.
            if (this.sessions.get(sessionId) === s && s.proc.alive) this.setCompacting(sessionId, true);
            logger.debug({ sessionId }, 'pi prompt ACK delayed by compaction; continuing to wait');
            continue;
          }

          // A missed native compaction_end must not leave stale UI once Pi reports
          // real streaming or a settled non-compacting state.
          if (this.sessions.get(sessionId) === s && s.proc.alive) this.setCompacting(sessionId, false);
          if (state.isStreaming) {
            logger.debug({ sessionId }, 'pi prompt accepted before ACK; watchdog reconciled active state');
            return;
          }

          idleSince ??= Date.now();
          if (Date.now() - idleSince >= this.promptWatchdog.idleStallMs) {
            throw new PromptWatchdogError('pi prompt was not acknowledged and pi reported neither streaming nor compaction');
          }
        } catch (err) {
          if (cancellation.signal.aborted) return;
          if (err instanceof PromptWatchdogError) throw err;
          const message = (err as Error).message;
          consecutiveProbeFailures += 1;
          logger.warn({ sessionId, err: message, consecutiveProbeFailures }, 'pi prompt watchdog state probe failed');
          if (!s.proc.alive || consecutiveProbeFailures >= this.promptWatchdog.probeFailureLimit) {
            throw new PromptWatchdogError(`pi prompt acknowledgement could not be reconciled: ${message}`);
          }
        }
      }
    } finally {
      if (s.promptAcceptanceAbort === cancellation) s.promptAcceptanceAbort = undefined;
    }
  }

  /** Pull authoritative cumulative usage from pi (get_session_stats) and map
   *  pi's field names (input/output/cacheRead/cacheWrite/cost) → Kraki SessionUsage. */
  async refreshUsage(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.proc.alive) return;
    try {
      const stats = await s.proc.request<{
        tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
        cost?: number;
      }>('get_session_stats');
      const t = stats.tokens;
      s.usage = {
        inputTokens: t?.input ?? 0,
        outputTokens: t?.output ?? 0,
        cacheReadTokens: t?.cacheRead ?? 0,
        cacheWriteTokens: t?.cacheWrite ?? 0,
        totalCost: stats.cost ?? 0,
        totalDurationMs: s.usage.totalDurationMs,
      };
      this.onUsageUpdate?.(sessionId, s.usage);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'get_session_stats failed');
    }
  }

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config.sessionId ?? randomUUID();
    const model = config.model ?? getDefaultModel(this);
    const thinking = effortToThinking(config.reasoningEffort);
    // Co-locate pi's transcript inside the Kraki session dir. Passing the exact
    // path via `--session` makes pi write there natively (verified: pi reports
    // it as sessionFile and writes lazily on the first turn).
    const transcript = this.transcriptPath(sessionId);
    mkdirSync(this.storeDir(sessionId), { recursive: true });
    const sess = this.spawn(sessionId, config.cwd ?? process.cwd(), model, MUTATING_DEFAULT_MODE, transcript, thinking);
    this.persistMeta(sessionId, sess);
    this.onSessionCreated?.({
      sessionId,
      agent: 'pi',
      model,
      reasoningEffort: config.reasoningEffort,
    });
    return { sessionId };
  }

  async resumeSession(sessionId: string, _ctx?: SessionContext): Promise<{ sessionId: string }> {
    const existing = this.sessions.get(sessionId);
    if (existing?.proc.alive) return { sessionId };
    // A fresh spawn adopts the persisted mode, so drop any stale mode signal.
    this.pendingModeSignals.delete(sessionId);
    // In-memory entry survives idle-eviction (sweepIdle keeps the map entry),
    // but a daemon restart wipes the map. Fall back to the on-disk sidecar so
    // the conversation (cwd + jsonl) is restored instead of starting blank.
    const meta = existing ?? this.loadMeta(sessionId);
    // Prefer the co-located transcript (new sessions). For sessions created
    // before co-location, the sidecar's recorded sessionFile (under ~/.pi)
    // still points at the original jsonl — keep using it so history survives.
    const coLocated = this.transcriptPath(sessionId);
    const sessionFile = existsSync(coLocated) ? coLocated : (meta?.sessionFile ?? coLocated);
    const sess = this.spawn(
      sessionId,
      meta?.cwd ?? process.cwd(),
      meta?.model ?? getDefaultModel(this),
      meta?.mode ?? MUTATING_DEFAULT_MODE,
      sessionFile,
      meta?.thinking,
    );
    // Await get_state so the prompt that follows isn't fired before pi has
    // replayed the on-disk conversation into the live context (otherwise the
    // model answers with no memory). Also refreshes the live jsonl path.
    try {
      const state = await sess.proc.request<{ sessionFile?: string }>('get_state');
      if (state.sessionFile) sess.sessionFile = state.sessionFile;
    } catch (err) {
      if (this.sessions.get(sessionId) === sess) this.sessions.delete(sessionId);
      sess.proc.kill();
      throw new Error(`failed to resume pi session ${sessionId}: ${(err as Error).message}`);
    }
    // Re-persist (refreshes the sidecar if it was just reconstructed from disk).
    this.persistMeta(sessionId, sess);
    return { sessionId };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    // If the session was idle-evicted (proc killed but map entry retained) or
    // the daemon restarted, resume before sending — the proc's stdin is gone.
    const existing = this.sessions.get(sessionId);
    const s = existing?.proc.alive
      ? existing
      : (await this.resumeSession(sessionId), this.sessions.get(sessionId));
    if (!s) throw new Error(`pi session ${sessionId} not found`);
    this.touch(sessionId);
    // Edge-triggered mode signal: if the mode changed since the last message,
    // prepend a one-shot marker so the model knows its new permission envelope.
    // The meta sidecar (kraki_get_mode) stays the source of truth; this is just
    // an inline heads-up (mirrors the claude/copilot adapters).
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `${modeChangeSignal(pendingMode as SessionMode)}\n\n${text}`;
    }
    const images = (attachments ?? [])
      .filter((a): a is import('@kraki/protocol').ImageAttachment => a.type === 'image')
      .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
    const promptPayload: Record<string, unknown> = { message: text, ...(images.length > 0 && { images }) };

    if (options?.delivery === 'steer') {
      // A steer is only an interjection while this logical turn is active. Once
      // Pi has settled it, explicitly convert the late steer into a fresh prompt
      // so it cannot inherit the previous turn's narration/finalization state.
      if (s.turn.isSettled) {
        this.resetTurnTracking(s);
        try {
          await this.withPromptPreflight(s, () => s.proc.request('prompt', promptPayload, { timeoutMs: null }));
        } catch (err) {
          this.failSubmission(sessionId, s, err as Error);
          throw err;
        }
      } else {
        // While active, Pi queues the interjection before the next LLM call and
        // it remains part of the current logical turn.
        await s.proc.request('prompt', { ...promptPayload, streamingBehavior: 'steer' }, { timeoutMs: null });
        // The run settled while Pi was accepting the steer: Pi runs the steer
        // as a new run. Reopen the turn so that run's reply and idle are
        // reported (a stopped turn stays closed).
        if (s.turn.isSettled && !s.turn.isAborted) this.resetTurnTracking(s);
      }
      return;
    }

    if (options?.delivery === 'follow_up') {
      // The previous conversational turn is already idle while Pi's native
      // threshold/manual maintenance is still inside the same agent lifecycle.
      // Queue this canonical new turn with Pi's official follow-up behavior: it
      // ACKs immediately, survives compaction, and starts after maintenance.
      this.resetTurnTracking(s);
      try {
        await this.withPromptPreflight(s, () => s.proc.request('prompt', { ...promptPayload, streamingBehavior: 'followUp' }, { timeoutMs: null }));
      } catch (err) {
        this.failSubmission(sessionId, s, err as Error);
        throw err;
      }
      return;
    }

    // A normal prompt opens a fresh logical turn: reset per-turn reply tracking.
    this.resetTurnTracking(s);
    // Submit exactly once. Pi only ACKs after prompt preflight, which may spend
    // minutes compacting even though the frame was delivered successfully. The
    // state-aware watchdog preserves the original request and never translates a
    // slow ACK into a false error/idle or duplicate prompt.
    try {
      await this.withPromptPreflight(s, () => this.awaitPromptAcceptance(sessionId, s, promptPayload));
    } catch (err) {
      let failure = err as Error;
      const message = failure.message;
      // pi can get into a state where the adapter has emitted idle (agent_end
      // was received) but pi's internal RPC layer still thinks it's processing.
      // A genuinely live human prompt must never enter this path — RelayClient
      // answers it directly, and this guard prevents a stale caller from aborting
      // it. For a phantom run, await abort + authoritative idle reconciliation
      // before retrying exactly once.
      if (message.includes('already processing') || message.includes('still processing')) {
        if (s.pendingQuestions.size > 0 || s.pendingPerms.size > 0) {
          throw new Error('Pi is waiting for a human response; the message was not sent as a new prompt.');
        }
        logger.warn({ sessionId }, 'pi stuck in processing state — awaiting abort before retry');
        try {
          s.aborting = true;
          try {
            await s.proc.request('abort');
            const state = await s.proc.request<{ isStreaming?: boolean; isCompacting?: boolean }>('get_state');
            if (state.isStreaming || state.isCompacting) {
              throw new Error('Pi remained busy after abort acknowledgement');
            }
          } finally {
            s.aborting = false;
          }
          // The explicit rejection proves the first prompt was NOT accepted. Only
          // this path may retry, after authoritative abort + idle reconciliation.
          await this.withPromptPreflight(s, () => this.awaitPromptAcceptance(sessionId, s, promptPayload));
          return;
        } catch (retryErr) {
          failure = retryErr as Error;
        }
      }
      logger.warn({ sessionId, err: failure.message }, 'pi prompt request failed');
      this.failSubmission(sessionId, s, failure);
      if (failure instanceof PromptWatchdogError && s.proc.alive) {
        // The prompt is still pending inside pi and could run later, after the
        // turn was announced as failed. Retire this process (as Stop does);
        // the next input lazy-resumes the on-disk transcript.
        this.compactingSessions.delete(sessionId);
        s.proc.kill();
      }
      // RelayClient records this as rejected, making a replay with the same
      // clientId retry the already-persisted transcript row. Do not turn an
      // unacknowledged adapter request into a falsely delivered input.
      throw failure;
    }
  }

  /** A submission that opened a new logical turn failed before pi started it:
   *  report the error and idle on that turn (not the previous run's id). */
  private failSubmission(sessionId: string, s: PiSession, err: Error): void {
    // Unexpected process exit owns its terminal idle in proc.onExit. Other
    // transport/watchdog failures still need to release the active UI here.
    if (s.exitObserved || s.turn.isSettled) {
      this.emitError(sessionId, s, err.message);
      return;
    }
    // Stamp the failure with this submission's turn; late events of the
    // previous run keep that run's id afterwards.
    const previousRun = s.turn.eventTurnId;
    s.turn.captureTurnId();
    s.turn.discardProse();
    s.turn.finish({ error: err.message });
    s.turn.eventTurnId = previousRun;
  }

  async abortSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.proc.alive) return;

    // Stop means stop the delegated background work too: a run finishing later
    // would wake the agent into a turn nobody is listening to.
    const tracker = this.subagentTrackers.get(sessionId);
    const backgroundRuns = tracker?.pendingAsyncRunIds() ?? [];
    this.stopAwaitingSubagents(s);
    // They will not report back into this turn: stop counting them as active,
    // or every later turn would be held for them.
    this.emitSubagentSteps(sessionId, s, tracker?.retirePending() ?? []);
    for (const runId of backgroundRuns) {
      s.proc.request('prompt', { message: `/subagents-stop ${runId}` }, { timeoutMs: 10_000 })
        .catch((err) => logger.debug({ sessionId, runId, err: (err as Error).message }, 'pi: could not stop background subagent'));
    }

    // Pi emits agent_end before resolving this RPC. Keep that event from
    // entering the normal finalize flow, which would start a new model turn
    // immediately after the user aborted the previous one.
    s.aborting = true;
    try {
      // Clear only inputs already handed to this Pi run. Relay retains their
      // canonical history and marks the active input ledger aborted/settled;
      // future inputs waiting in Relay's own chain are not touched. Otherwise
      // Pi can retain a follow-up after the UI has announced this turn aborted.
      // An older Pi without clear_queue answers "Unknown command": it has no
      // queue to clear, so Stop must still abort. Any other failure keeps the
      // turn open (the queue may still hold a continuation).
      try {
        const cleared = await s.proc.request<{ steering?: string[]; followUp?: string[] }>('clear_queue');
        logger.debug({ sessionId, steering: cleared?.steering?.length ?? 0, followUp: cleared?.followUp?.length ?? 0 }, 'cleared Pi queue before explicit abort');
      } catch (err) {
        if (!/unknown command/i.test((err as Error).message)) throw err;
        logger.warn({ sessionId }, 'pi: this Pi has no clear_queue; aborting without it');
      }
      // Release dialogs only after clearing the queue, so resolving the last
      // tool cannot begin a queued continuation in the cancellation window.
      // Relay has already captured the visible card and retains abort history.
      for (const questionId of s.pendingQuestions.keys()) {
        s.proc.sendRaw({ type: 'extension_ui_response', id: questionId, cancelled: true });
      }
      s.pendingQuestions.clear();
      s.foreignDialogs?.clear();
      for (const permissionId of s.pendingPerms.keys()) {
        s.proc.sendRaw({ type: 'extension_ui_response', id: permissionId, confirmed: false });
      }
      s.pendingPerms.clear();
      // Pi resolves this RPC only after AgentSession.abort() has cancelled the
      // active tool process group and waitForIdle() has completed. Relay-client
      // must not announce `idle` before that acknowledgement arrives.
      await s.proc.request('abort');
      // RelayClient owns the visible aborted idle boundary, but the adapter must
      // still record that this logical turn is terminal. Otherwise the stricter
      // idle-eviction gate would retain an acknowledged-aborted Pi forever.
      s.turn.settleSilently();

      const pendingAcceptance = s.promptAcceptanceAbort;
      if (pendingAcceptance) {
        // Retire any still-unacknowledged preflight command as well as the
        // active run. Pi 0.87 cancels compaction on abort, but an unresolved
        // prompt command must never execute after Relay announces cancellation.
        // The next input lazy-resumes the intact on-disk transcript.
        pendingAcceptance.abort();
        this.compactingSessions.delete(sessionId);
        s.proc.kill();
      }
    } finally {
      s.aborting = false;
    }
  }

  async respondToPermission(sessionId: string, permissionId: string, decision: PermissionDecision, reason?: string): Promise<PermissionResponseResult> {
    const s = this.sessions.get(sessionId);
    if (!s) { logger.warn({ sessionId }, 'respondToPermission: session not found'); return 'session_gone'; }
    if (!s.pendingPerms.delete(permissionId)) {
      logger.warn({ sessionId, permissionId }, 'respondToPermission: no pending permission');
      return 'not_found';
    }
    const confirmed = decision === 'approve';
    s.proc.sendRaw({ type: 'extension_ui_response', id: permissionId, confirmed });
    // pi's confirm channel is boolean; relay the reason as a steer into the
    // active run so the model learns why the tool was blocked.
    if (!confirmed && reason && s.proc.alive) {
      s.proc.request('prompt', { message: `The user denied that request: ${reason}`, streamingBehavior: 'steer' }, { timeoutMs: null })
        .catch((err) => logger.debug({ sessionId, err: (err as Error).message }, 'pi deny-reason steer failed'));
    }
    logger.debug({ sessionId, permissionId, confirmed }, 'pi permission answered');
    return 'accepted';
  }

  async respondToQuestion(sessionId: string, questionId: string, answer: QuestionAnswer | string, _wasFreeform: boolean): Promise<QuestionResponseResult> {
    const s = this.sessions.get(sessionId);
    if (!s) {
      logger.warn({ sessionId }, 'respondToQuestion: session not found');
      return 'session_gone';
    }
    if (!s.pendingQuestions.has(questionId)) {
      logger.warn({ sessionId, questionId }, 'respondToQuestion: no pending question');
      return 'not_found';
    }
    if (!s.proc.alive) return 'session_gone';

    const answerValue = typeof answer === 'string' ? { text: answer } : answer;
    const foreign = s.foreignDialogs?.get(questionId);
    if (foreign) {
      // Another extension's dialog takes a plain value: it has no channel for
      // images (same open question as image answers on text-only agents).
      s.foreignDialogs?.delete(questionId);
      s.pendingQuestions.delete(questionId);
      s.proc.sendRaw(foreign === 'confirm'
        ? { type: 'extension_ui_response', id: questionId, confirmed: answerValue.text.trim().toLowerCase() === PI_CONFIRM_CHOICES[0].toLowerCase() }
        : { type: 'extension_ui_response', id: questionId, value: answerValue.text });
      logger.debug({ sessionId, questionId, method: foreign }, 'pi extension dialog answered');
      return 'accepted';
    }
    const images = (answerValue.attachments ?? [])
      .filter((a): a is import('@kraki/protocol').ImageAttachment => a.type === 'image')
      .map(a => ({ type: 'image' as const, data: a.data, mimeType: a.mimeType }));
    s.proc.sendRaw({ type: 'extension_ui_response', id: questionId, value: krakiAnswerEnvelope(answerValue.text, images) });
    s.pendingQuestions.delete(questionId);
    logger.debug({ sessionId, questionId, images: images.length }, 'pi question answered');
    return 'accepted';
  }

  async killSession(sessionId: string): Promise<void> {
    this.clearPendingPerms(sessionId);
    this.clearPendingQuestions(sessionId);
    this.pendingModeSignals.delete(sessionId);
    const killed = this.sessions.get(sessionId);
    if (killed) this.stopAwaitingSubagents(killed);
    this.subagentTrackers.delete(sessionId);
    killed?.proc.kill();
    this.sessions.delete(sessionId);
    // Remove the adapter recovery sidecar (both co-located and legacy). pi's
    // transcript lives in the session dir and is reaped with it by the manager.
    try { rmSync(this.sidecarPath(sessionId), { force: true }); } catch { /* ignore */ }
    try { rmSync(this.legacySidecarPath(sessionId), { force: true }); } catch { /* ignore */ }
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const src = this.sessions.get(sourceSessionId) ?? this.loadMeta(sourceSessionId);
    // A fork must diverge: give it its own co-located transcript seeded with the
    // source history, so the two sessions don't append to the same jsonl.
    const srcFile = (this.sessions.get(sourceSessionId)?.sessionFile)
      ?? (existsSync(this.transcriptPath(sourceSessionId)) ? this.transcriptPath(sourceSessionId) : (src as { sessionFile?: string })?.sessionFile);
    const forkFile = this.transcriptPath(newSessionId);
    mkdirSync(this.storeDir(newSessionId), { recursive: true });
    if (srcFile && existsSync(srcFile)) {
      // Clone (copy-on-write): transcripts reach hundreds of MB.
      try { cloneFile(srcFile, forkFile); } catch (err) { logger.debug({ err: (err as Error).message }, 'fork copy failed'); }
    }
    const next = this.spawn(newSessionId, src?.cwd ?? process.cwd(), src?.model ?? getDefaultModel(this), src?.mode ?? MUTATING_DEFAULT_MODE, forkFile, src?.thinking);
    this.persistMeta(newSessionId, next);
    return { sessionId: newSessionId };
  }

  setSessionMode(sessionId: string, mode: Mode): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.mode === mode) return;
    s.mode = mode;
    // No respawn: the gate is loaded in every mode and the adapter applies the
    // policy per-call, so the mode change takes effect immediately WITHOUT
    // killing the in-flight turn. Persist the new mode so it survives a daemon
    // restart AND so the extension's kraki_get_mode (KRAKI_META_FILE) reads it live.
    this.persistMeta(sessionId, s);
    // Edge-triggered: prepend a one-shot marker to the next user message.
    this.pendingModeSignals.set(sessionId, mode);
    // Switching into an automatic mode must also release permissions that are
    // already waiting on the human. Use the existing UI response rather than a
    // Pi steer: steer creates an independent agent lifecycle whose agent_end can
    // incorrectly settle the real user turn.
    if (mode === 'auto' || mode === 'delegate') {
      for (const permissionId of s.pendingPerms.keys()) {
        s.proc.sendRaw({ type: 'extension_ui_response', id: permissionId, confirmed: true });
        s.pendingPerms.delete(permissionId);
        this.onPermissionAutoResolved?.(sessionId, permissionId, 'approved');
      }
    }
    // Delegate also answers the agent's own open questions (not other
    // extensions' dialogs, which still need the human).
    if (mode === 'delegate') {
      for (const questionId of s.pendingQuestions.keys()) {
        if (s.foreignDialogs?.has(questionId)) continue;
        s.proc.sendRaw({ type: 'extension_ui_response', id: questionId, value: krakiAnswerEnvelope(DELEGATE_ANSWER) });
        s.pendingQuestions.delete(questionId);
        this.onQuestionAutoResolved?.(sessionId, questionId);
      }
    }
    logger.debug({ sessionId, mode }, 'pi session mode changed');
  }

  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void> {
    const [provider, modelId] = this.resolveModelId(model);
    const thinking = effortToThinking(reasoningEffort);
    let s = this.sessions.get(sessionId);

    if (!s?.proc.alive) {
      const meta = s ?? this.loadMeta(sessionId);
      if (!meta) throw new Error(`pi session ${sessionId} not found`);
      const coLocated = this.transcriptPath(sessionId);
      const sessionFile = existsSync(coLocated) ? coLocated : (meta.sessionFile ?? coLocated);
      const originalTranscript = this.appendModelChange(sessionFile, provider, modelId);
      const previous = s;
      s = this.spawn(
        sessionId,
        meta.cwd ?? process.cwd(),
        model,
        meta.mode ?? MUTATING_DEFAULT_MODE,
        sessionFile,
        thinking ?? meta.thinking,
      );
      try {
        const state = await s.proc.request<{ sessionFile?: string }>('get_state');
        if (state.sessionFile) s.sessionFile = state.sessionFile;
      } catch (err) {
        if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
        s.proc.kill();
        if (originalTranscript !== null) writeFileSync(sessionFile, originalTranscript, 'utf8');
        if (previous) {
          this.sessions.set(sessionId, previous);
          this.persistMeta(sessionId, previous);
        } else {
          writeFileSync(this.sidecarPath(sessionId), JSON.stringify(meta), 'utf8');
        }
        throw new Error(`failed to change model for pi session ${sessionId}: ${(err as Error).message}`);
      }
    } else {
      await s.proc.request('set_model', { provider, modelId });
    }

    s.model = model;
    this.persistMeta(sessionId, s);
    if (thinking) {
      try {
        await s.proc.request('set_thinking_level', { level: thinking });
        s.thinking = thinking;
        this.persistMeta(sessionId, s);
      } catch (err) {
        logger.warn({ err: (err as Error).message, sessionId, thinking }, 'pi thinking level change failed');
      }
    }
  }

  /** Title side-call: one-shot `pi --print` on the session's own provider and
   *  model, with tools, extensions, skills, prompt templates, context files and
   *  thinking all off and no session file. It never touches the session's pi
   *  process or transcript, so it is safe while a turn is running. */
  async generateTitle(sessionId: string, context: TitleContext): Promise<string | null> {
    const model = context.model
      ?? this.sessions.get(sessionId)?.model
      ?? this.loadMeta(sessionId)?.model
      ?? getDefaultModel(this);
    const [provider, modelId] = this.resolveModelId(model);
    const args = [
      '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--thinking', 'off',
      '--provider', provider, '--model', modelId,
      '--system-prompt', TITLE_SYSTEM_PROMPT,
      buildTitlePrompt(context),
    ];
    return new Promise<string | null>((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (value: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const child = spawn(...cliSpawnArgs(this.cliPath, args), { cwd: tmpdir(), env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const timer = setTimeout(() => { child.kill(); logger.warn({ sessionId }, 'pi title generation timed out'); finish(null); }, 45_000);
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('error', (e) => { logger.warn({ sessionId, err: e.message }, 'pi title spawn failed'); finish(null); });
      child.on('exit', (code) => {
        if (code !== 0) logger.warn({ sessionId, code, stderr: err.slice(-300) }, 'pi title generation failed');
        finish(code === 0 ? cleanTitle(out) : null);
      });
    });
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      id, state: s.proc.alive ? 'active' : 'idle', model: s.model, cwd: s.cwd,
    }));
  }

  /** Raw `--list-models` catalog. Only a successful read is cached: a failed
   *  read (e.g. pi is slow right after login while the machine is busy) must
   *  not leave the agent with no models until the daemon restarts. */
  cachedModels: PiModelRow[] | null = null;
  modelsLoad: Promise<PiModelRow[] | null> | null = null;
  modelRetryTimer: ReturnType<typeof setTimeout> | null = null;
  modelRetryAttempt = 0;
  modelListFailed = false;
  lastModelListError: string | undefined;

  override modelListError(): string | undefined {
    return this.modelListFailed ? this.lastModelListError : undefined;
  }
  stopped = false;
  modelScope: string[] | undefined;
  scopeLoaded = false;

  async listModels(): Promise<string[]> {
    await ensureRawModels(this);
    return fetchModels(this).map(m => `${m.provider}/${m.model}`);
  }

  cachedEfforts: Map<string, ReasoningEffort[]> | null = null;

  async listModelDetails(): Promise<ModelDetail[]> {
    await ensureRawModels(this);
    const byModel = await fetchEfforts(this);
    return fetchModels(this).map(m => {
      const id = `${m.provider}/${m.model}`;
      const efforts = byModel.get(id) ?? (m.reasoning ? FALLBACK_EFFORTS : []);
      return {
        id,
        name: `${m.provider.charAt(0).toUpperCase() + m.provider.slice(1)} ${m.model}`,
        supportsReasoningEffort: m.reasoning && efforts.length > 0,
        supportedReasoningEfforts: efforts.length > 0 ? efforts : undefined,
        defaultReasoningEffort: defaultEffortFor(efforts),
        contextWindow: m.contextWindow,
      };
    });
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.sessions.get(sessionId)?.usage ?? null;
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (
        s.proc.alive
        && s.turn.isSettled
        && !this.compactingSessions.has(id)
        && s.pendingQuestions.size === 0
        && s.pendingPerms.size === 0
        && !s.aborting
        && now - s.lastActivity > IDLE_TTL_MS
      ) {
        logger.info({ id }, 'Evicting idle pi session');
        s.proc.kill();
        this.onSessionEvicted?.(id);
      }
    }
  }
}
