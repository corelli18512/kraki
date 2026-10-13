/**
 * TurnTracker — the rules every agent adapter follows for one Kraki turn.
 *
 * One tracker per session. An adapter translates its agent's events into a few
 * calls here; the tracker decides what Kraki shows:
 *
 *   beginTurn()        a new user prompt opens a logical turn
 *   captureTurnId()    the agent started working on it (stamp later events)
 *   appendProse(text)  the agent said something (not yet known: step or reply?)
 *   proseSegment(text) a finished piece of prose (Pi delivers whole segments)
 *   toolStarted()      a tool runs → the prose before it was narration (a step)
 *   holdOpen()         turn stays open (background subagents) → prose is a step
 *   abort()            the user pressed Stop → end silently
 *   finish({ error })  the agent's run ended → reply or error, then idle, once
 *
 * The rules (Pi's behaviour is the reference):
 *  - Prose followed by a tool is NARRATION: it reconciles the live draft
 *    (onNarration) and becomes an `agent_narration` step (onNarrationTrace).
 *  - The last prose with no tool after it is the REPLY (onMessage). Its step is
 *    never recorded, so the reply doesn't show twice (last step + bubble).
 *  - A turn that ends on a tool has no reply: it is just its steps.
 *  - An error ends the turn as failed: the unfinished prose is dropped.
 *  - A user stop ends the turn silently: RelayClient owns that boundary
 *    (turn_status user_abort + idle aborted).
 *  - Idle is emitted exactly once per turn, stamped with the turn's id.
 *
 * Every callback carries `turnId` so RelayClient can drop late events from an
 * older turn: `relayTurnId` is what RelayClient assigned to the newest prompt;
 * `eventTurnId` is the turn the agent is actually working on (captured at the
 * agent's own start boundary, so a late event from the previous run keeps the
 * previous id).
 */

import type { AgentAdapter, TurnLifecycleEvent } from './base.js';

type Sink = Pick<AgentAdapter, 'onNarration' | 'onNarrationTrace' | 'onMessage' | 'onError' | 'onIdle'>;

export class TurnTracker {
  /** Turn id RelayClient assigned to the newest prompt (setTurnIdentity). */
  relayTurnId: string | undefined;
  /** Turn id the agent is working on; stamped on every callback. */
  eventTurnId: string | undefined;

  private settled = true;
  /** The agent started the open turn (its id is captured). */
  private started = false;
  private aborted = false;
  private error: string | undefined;
  /** Prose not yet classified (adapters that stream blocks accumulate here). */
  private buffer = '';
  /** Latest finished segment whose step is not yet recorded: it may still
   *  become the reply. Recorded when a newer segment or a tool follows. */
  private unrecordedStep = '';
  /** Latest finished segment; the reply if no tool follows it. */
  private lastSegment = '';
  private toolSinceLastSegment = false;

  constructor(private readonly sink: Sink, readonly sessionId: string) {}

  /** `{ turnId }` for callbacks; empty when no turn id is known (legacy). */
  event(): TurnLifecycleEvent {
    const turnId = this.eventTurnId ?? this.relayTurnId;
    return turnId ? { turnId } : {};
  }

  /** True when no turn is open (never begun, finished, or stopped). */
  get isSettled(): boolean { return this.settled; }
  /** True when the open turn was stopped by the user. */
  get isAborted(): boolean { return this.aborted; }
  /** Error held until the turn ends (see setError). */
  get pendingError(): string | undefined { return this.error; }

  /** A new prompt opens a turn. `captureNow`: the agent starts on it at once
   *  (no separate start event), so stamp events with the new id right away. */
  beginTurn(options: { captureNow?: boolean } = {}): void {
    this.settled = false;
    this.aborted = false;
    this.started = false;
    this.error = undefined;
    this.resetProse();
    if (options.captureNow) this.captureTurnId();
  }

  /** The agent started working on the newest prompt. */
  captureTurnId(): void {
    this.eventTurnId = this.relayTurnId;
    this.started = true;
  }

  /** True when a turn is open but the agent has not started it yet (events
   *  are still stamped with the previous run's id). */
  get awaitingStart(): boolean { return !this.settled && !this.started; }

  /** Prose the agent produced; classified at the next tool / turn end.
   *  Consecutive pieces are joined with `joiner`. */
  appendProse(text: string, joiner = '\n'): void {
    if (!text) return;
    this.buffer = this.buffer ? `${this.buffer}${joiner}${text}` : text;
  }

  /** A finished piece of prose. It reconciles the live draft now; its step is
   *  recorded once a newer segment or a tool shows it was narration. */
  proseSegment(text: string): void {
    const prose = text.trim();
    if (!prose) return;
    this.sink.onNarration?.(this.sessionId, { content: prose, ...this.event() });
    this.recordUnrecordedStep();
    this.unrecordedStep = prose;
    this.lastSegment = prose;
    this.toolSinceLastSegment = false;
  }

  /** A tool started: the prose before it was narration. Call BEFORE emitting
   *  the tool's own start, so steps stay in order. */
  toolStarted(): void {
    this.takeBuffer();
    this.recordUnrecordedStep();
    this.toolSinceLastSegment = true;
  }

  /** The agent's run ended but the turn stays open (background subagents will
   *  wake it): prose so far ("started the subagents…") is a step, not the reply. */
  holdOpen(): void {
    this.takeBuffer();
    this.recordUnrecordedStep();
    this.lastSegment = '';
    this.toolSinceLastSegment = false;
  }

  /** Hold an error until the turn ends; it replaces the reply. */
  setError(message: string): void { this.error = message; }
  clearError(): void { this.error = undefined; }

  /** Drop prose the agent produced but that must not be shown (e.g. a late
   *  result of a stopped turn). */
  discardProse(): void { this.resetProse(); }

  /** The user stopped the open turn. Returns false when no turn was open.
   *  The turn stays unsettled until `finish` / `settleSilently` — the agent's
   *  own end event for it is still expected. */
  abort(): boolean {
    if (this.settled) return false;
    this.aborted = true;
    this.error = undefined;
    this.resetProse();
    return true;
  }

  /** End the turn: report the reply (or the error), then idle. Runs once per
   *  turn; returns false if the turn had already ended. `idle: false` ends the
   *  reply part without idle (the agent continues the same Kraki turn). */
  finish(options: { error?: string; idle?: boolean } = {}): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.concludeReply(options.error);
    if (!this.aborted && options.idle !== false) this.emitIdle();
    return true;
  }

  /** End the turn with no reply, error or idle (a user stop whose terminal
   *  boundary RelayClient owns, or a turn superseded without output). */
  settleSilently(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.error = undefined;
    this.resetProse();
    return true;
  }

  /** Report the reply or error of the open turn without ending it. Used where
   *  the agent's run ends but Kraki settles later (see adapters). */
  concludeReply(errorOverride?: string): void {
    const error = errorOverride ?? this.error;
    this.error = undefined;
    if (this.aborted) { this.resetProse(); return; }
    if (error) {
      this.resetProse(); // unfinished prose is not shown, not even as a draft
      this.sink.onError?.(this.sessionId, { message: error, ...this.event() });
      return;
    }
    this.takeBuffer();
    if (!this.toolSinceLastSegment && this.lastSegment) {
      const reply = this.lastSegment;
      this.unrecordedStep = ''; // it IS the reply; never also a step
      this.resetProse();
      this.sink.onMessage?.(this.sessionId, { content: reply, ...this.event() });
      return;
    }
    this.recordUnrecordedStep();
    this.resetProse();
  }

  /** Idle for the current turn id (no settle bookkeeping). */
  emitIdle(): void {
    const event = this.event();
    if (event.turnId) this.sink.onIdle?.(this.sessionId, event);
    else this.sink.onIdle?.(this.sessionId);
  }

  /** True when the last thing the agent did was a tool (no prose after it). */
  get endedOnTool(): boolean { return this.toolSinceLastSegment; }
  /** True when finishing now would show a reply (prose with no tool after it). */
  get hasReply(): boolean {
    if (this.buffer.trim()) return true; // buffered prose would become the last segment
    return !this.toolSinceLastSegment && !!this.lastSegment;
  }

  private takeBuffer(): void {
    const text = this.buffer;
    this.buffer = '';
    this.proseSegment(text);
  }

  private recordUnrecordedStep(): void {
    if (!this.unrecordedStep) return;
    const content = this.unrecordedStep;
    this.unrecordedStep = '';
    this.sink.onNarrationTrace?.(this.sessionId, { content, ...this.event() });
  }

  private resetProse(): void {
    this.buffer = '';
    this.unrecordedStep = '';
    this.lastSegment = '';
    this.toolSinceLastSegment = false;
  }
}
