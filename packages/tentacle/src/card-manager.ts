import type { CardActionState } from '@kraki/protocol';

/** A running tool step occupying (or eligible to occupy) the slot. */
type RunningTool = Extract<CardActionState, { type: 'tool_start' }>;
/** A finished tool step. */
type CompletedTool = Extract<CardActionState, { type: 'tool_complete' }>;
/** A prompt step (permission or question). */
type PromptAction = Extract<CardActionState, { type: 'permission' | 'question' }>;
type TerminalAction = Extract<CardActionState, { type: 'user_abort' | 'failed' }>;

/** Stable per-tool key: the tool call id, falling back to its headline when the
 *  adapter didn't supply one. */
function toolKey(a: RunningTool | CompletedTool): string {
  return a.payload.toolCallId ?? a.payload.headline;
}

/**
 * A partial card broadcast — the tentacle's {@link RelayClient.send} enriches
 * it with envelope fields (seq/timestamp/deviceId) and, for `agent_message_delta`,
 * runs it through the streaming-delta coalescer.
 */
export interface CardBroadcast {
  type: 'agent_message_delta' | 'card_action';
  sessionId: string;
  payload: unknown;
}

interface CardState {
  /** Full accumulated DRAFT text (authoritative for reconnect snapshots). The
   *  draft is the agent's live words, rendered as a clean in-flow spine bubble
   *  (NOT inside the status card) and graduated to a permanent bubble at turn
   *  end. Keep-last: each new narration segment (or a resummarize) replaces it. */
  draftText: string;
  /** When true, the NEXT streaming delta starts a fresh segment (reset). Set
   *  after a narration finalizes so the following prose (the next narration
   *  segment, or a finalize resummarize) REPLACES rather than appends. */
  resetNext: boolean;
  /** The SINGLE action slot. tool / tool_batch / permission / question all write
   *  here with equal footing (last-write-wins by time); there is no precedence. A
   *  resolved permission/question stays here (with decision/answer set) until a
   *  newer action replaces it or the card clears. */
  action: CardActionState | null;
  /** Tools currently in flight (started, not yet completed), keyed by id and kept
   *  in insertion order. The agent runs tools in PARALLEL, so this can hold
   *  several at once; it is the source of truth for the concurrency count (and
   *  for deciding, at turn end, whether the card still has live tool work). */
  runningTools: Map<string, RunningTool>;
  /** Signature of the last broadcast action, to suppress redundant sends. */
  lastActionKey: string;
}

/** How a permission/question was resolved (threaded through from the arm). */
export type PromptResolution =
  | { decision: 'approve' | 'deny' | 'always_allow' }
  | { answer: string };

/**
 * Owns the per-session status card + draft bubble the tentacle broadcasts to
 * all arms.
 *
 * Two independently-broadcast parts:
 *  - **draft** (`agent_message_delta`): the agent's streaming words — narration /
 *    progress / conclusion. Rendered by arms as a clean in-flow spine bubble
 *    (NOT inside the pinned card). Incremental deltas with a `reset` boundary;
 *    keep-last (each new segment resets). Graduates to a permanent
 *    `agent_message` bubble at turn end (arms clear the draft on that bubble).
 *  - **action** (`card_action`): a SINGLE slot shared by tool / permission /
 *    question on equal footing — last-write-wins by time, no precedence. This is
 *    the ONLY thing the pinned status card renders. A resolved permission/
 *    question keeps showing (read-only) until a newer action replaces it or the
 *    card clears.
 *
 * Arms render both verbatim and perform ZERO precedence logic. The finalized
 * narration + tool steps still ride the TRACE axis (`trace.jsonl`) for the lazy
 * "Steps" history; this class only governs the live draft + action slot.
 */
export class CardManager {
  private cards = new Map<string, CardState>();

  constructor(private readonly broadcast: (msg: CardBroadcast) => void) {}

  private get(sessionId: string): CardState {
    let c = this.cards.get(sessionId);
    if (!c) {
      c = { draftText: '', resetNext: false, action: null, runningTools: new Map(), lastActionKey: 'null' };
      this.cards.set(sessionId, c);
    }
    return c;
  }

  /** True while the slot holds a still-PENDING (unresolved) permission/question —
   *  a blocking human affordance that background tool activity must NOT clobber.
   *  A resolved prompt is fair game to be superseded by later tool activity. */
  private slotBlocksTool(c: CardState): boolean {
    const a = c.action;
    return (
      (a?.type === 'permission' && !a.payload.decision) ||
      (a?.type === 'question' && a.payload.answer === undefined)
    );
  }

  /** A slot tail that must be RETIRED the instant narration resumes: a COMPLETED
   *  tool (nothing still running) OR a RESOLVED prompt (a decided permission /
   *  answered question). Its presence in the slot means "the latest thing that
   *  happened was this action, and nothing has narrated since" — so a fresh
   *  narration segment supersedes it. A still-running tool or an UNRESOLVED
   *  prompt is genuinely live and is never retired here. */
  private isSettledTail(c: CardState): boolean {
    const a = c.action;
    return (
      ((a?.type === 'tool_start' || a?.type === 'tool_complete') && c.runningTools.size === 0) ||
      (a?.type === 'permission' && !!a.payload.decision) ||
      (a?.type === 'question' && a.payload.answer !== undefined)
    );
  }

  private actionKey(a: CardActionState | null): string {
    if (!a) return 'null';
    if (a.type === 'tool_start' || a.type === 'tool_complete') {
      return `${a.type}:${a.payload.toolCallId ?? a.payload.headline}`;
    }
    if (a.type === 'tool_batch') return `batch:${a.payload.running}`;
    if (a.type === 'permission') return `permission:${a.payload.id}:${a.payload.cancelled ? 'cancelled' : a.payload.decision ?? ''}`;
    if (a.type === 'question') return `question:${a.payload.id}:${a.payload.cancelled ? 'cancelled' : a.payload.answer !== undefined ? 'answered' : 'pending'}`;
    if (a.type === 'compaction') return `compaction:${a.payload.reason ?? 'unknown'}`;
    if (a.type === 'user_abort') return `user_abort:${a.payload.abortedAt}`;
    return `failed:${a.payload.failedAt}:${a.payload.code ?? ''}:${a.payload.message}`;
  }

  /** The action a session's live tools should occupy the slot with, derived from
   *  the concurrency: none → null, exactly one → that single running tool,
   *  two-or-more → a collapsed `tool_batch` carrying just the count. */
  private toolActionFor(c: CardState): CardActionState | null {
    const n = c.runningTools.size;
    if (n === 0) return null;
    if (n === 1) return c.runningTools.values().next().value ?? null;
    return { type: 'tool_batch', payload: { running: n } };
  }

  /** Broadcast the current action if it changed since last send. */
  private syncAction(sessionId: string, c: CardState): void {
    const key = this.actionKey(c.action);
    if (key === c.lastActionKey) return;
    c.lastActionKey = key;
    this.broadcast({ type: 'card_action', sessionId, payload: { action: c.action } });
  }

  // ── Draft bubble (text) part ──────────────────────────

  /** A streaming draft chunk — the agent's live words (narration/progress, or a
   *  finalize resummarize). Appends to the current segment, or replaces it when a
   *  new segment was flagged (resetNext) — keep-last, so a later segment (or the
   *  resummarize that follows the frozen final narration) supersedes an earlier
   *  one in the same draft bubble. Rides the draft-bubble transport (an in-flow
   *  spine bubble), NOT the pinned card. Tool activity runs in parallel via the
   *  action slot and does NOT disturb the draft. */
  onDelta(sessionId: string, content: string): void {
    if (!content) return;
    const c = this.get(sessionId);
    // Narration resumed → a SETTLED tail or stale compaction indicator is no
    // longer the latest activity. Running tools and unresolved prompts remain.
    if (this.isSettledTail(c) || c.action?.type === 'compaction') {
      c.action = null;
      this.syncAction(sessionId, c);
    }
    const reset = c.resetNext;
    if (reset) {
      c.draftText = content;
      c.resetNext = false;
    } else {
      c.draftText += content;
    }
    this.broadcast({ type: 'agent_message_delta', sessionId, payload: { content, reset } });
  }

  /** A narration segment finalized (message_end). `content` is the AUTHORITATIVE
   *  full prose for the segment — the same text that graduates to the permanent
   *  agent_message bubble at the turn's end. The live text_delta stream usually
   *  already rendered it, but pi can under-deliver (coalesced / dropped trailing
   *  tokens) so the accumulated draft ends SHORT of `content`. If we didn't
   *  reconcile, the draft would still be short when the concluding bubble lands
   *  — the bubble would visibly JUMP in size at the draft→spine handoff (the "not
   *  exactly the same" flash). So when the stream diverged, broadcast the full
   *  authoritative content as a reset now (message_end fires before agent_end, so
   *  the arm gets a paint cycle to catch up before the swap). When the stream
   *  already matches, skip the broadcast — no redundant re-render. Then flag the
   *  next delta to start a fresh segment (keep-last). */
  onNarrationFinal(sessionId: string, content: string): void {
    const c = this.get(sessionId);
    // A narration segment is the latest activity now → retire a settled tail or
    // stale compaction indicator (mirrors onDelta for no-stream edge cases).
    if (this.isSettledTail(c) || c.action?.type === 'compaction') {
      c.action = null;
      this.syncAction(sessionId, c);
    }
    if (content) {
      if (content !== c.draftText) {
        this.broadcast({ type: 'agent_message_delta', sessionId, payload: { content, reset: true } });
      }
      c.draftText = content;
    }
    c.resetNext = true;
  }

  /** The draft graduated to a permanent spine bubble (agent_message) — clear the
   *  server-side draft state so reconnect snapshots don't re-seed a stale draft.
   *  Deliberately does NOT broadcast an empty reset for the DRAFT: arms clear it
   *  in the same store update that lands the permanent bubble, so there is no
   *  frame gap (the old clear-then-re-add flash).
   *
   *  It DOES promptly retire the action slot when nothing live remains: a
   *  permanent reply means the turn is concluding, so a slot holding only a
   *  COMPLETED tool (or a resolved prompt) is stale — drop it now so the card
   *  vanishes together with the reply instead of lingering until the later
   *  `onIdle`/`clear`. A still-in-flight tool (parallel work) or an unresolved
   *  permission/question is left in place (the human/agent still needs it). */
  onBubble(sessionId: string): void {
    const c = this.get(sessionId);
    c.draftText = '';
    c.resetNext = false;
    const live = c.runningTools.size > 0 || this.slotBlocksTool(c);
    if (c.action && !live) {
      c.action = null;
      this.syncAction(sessionId, c);
    }
  }

  // ── Action part ───────────────────────────────────────

  /** Pi started compacting before prompt acceptance. Do not hide a blocking
   *  human affordance; otherwise compaction owns the transient action slot. */
  onCompactionStart(sessionId: string, reason?: 'manual' | 'threshold' | 'overflow'): void {
    const c = this.get(sessionId);
    if (this.slotBlocksTool(c)) return;
    c.action = { type: 'compaction', payload: { phase: 'running', ...(reason && { reason }) } };
    this.syncAction(sessionId, c);
  }

  /** Clear only if compaction still owns the slot. A newer tool/prompt action
   *  must survive a late native compaction_end or watchdog reconciliation. */
  onCompactionEnd(sessionId: string): void {
    const c = this.cards.get(sessionId);
    if (!c || c.action?.type !== 'compaction') return;
    c.action = null;
    this.syncAction(sessionId, c);
  }

  /** A tool started — track it as in-flight and (unless a pending prompt owns the
   *  slot) show the derived tool action: the single tool, or a `tool_batch` count
   *  when others are already running in parallel. */
  onToolStart(sessionId: string, action: RunningTool): void {
    const c = this.get(sessionId);
    c.runningTools.set(toolKey(action), action);
    if (this.slotBlocksTool(c)) return;
    c.action = this.toolActionFor(c);
    this.syncAction(sessionId, c);
  }

  /** A tool finished — drop it from the in-flight set. If OTHER tools are still
   *  running, keep showing the derived running view (remaining single / batch
   *  count); otherwise land this completed tool (success/failure) as the slot's
   *  last state. A still-pending prompt owns the slot and is left untouched; a
   *  RESOLVED prompt IS superseded (e.g. after approval the gated tool takes the
   *  slot rather than the slot staying stuck on the resolved permission). */
  onToolComplete(sessionId: string, action: CompletedTool): void {
    const c = this.get(sessionId);
    c.runningTools.delete(toolKey(action));
    if (this.slotBlocksTool(c)) return;
    c.action = c.runningTools.size > 0 ? this.toolActionFor(c) : action;
    this.syncAction(sessionId, c);
  }

  onPrompt(sessionId: string, action: PromptAction): void {
    const c = this.get(sessionId);
    c.action = action;
    this.syncAction(sessionId, c);
  }

  /** Resolve a permission or question. If it still occupies the slot, update it
   *  IN PLACE to a resolved (read-only) state showing the decision/answer and
   *  keep it displayed — no fallback to any prior tool. An auto-resolve without
   *  a resolution marks questions cancelled instead of making the user's
   *  pending decision disappear. */
  resolvePrompt(sessionId: string, id: string, resolution?: PromptResolution): void {
    const c = this.cards.get(sessionId);
    const a = c?.action;
    if (!c || !a || (a.type !== 'permission' && a.type !== 'question') || a.payload.id !== id) return;
    if (a.type === 'permission' && resolution && 'decision' in resolution) {
      c.action = { ...a, payload: { ...a.payload, decision: resolution.decision } };
    } else if (a.type === 'question' && resolution && 'answer' in resolution) {
      c.action = { ...a, payload: { ...a.payload, answer: resolution.answer, cancelled: undefined } };
    } else if (a.type === 'question') {
      c.action = { ...a, payload: { ...a.payload, cancelled: true } };
    } else {
      c.action = null;
    }
    this.syncAction(sessionId, c);
  }

  /** Replace the live action with a terminal turn outcome and return everything
   *  that was still unfinished so RelayClient can close those TRACE steps. */
  terminate(sessionId: string, action: TerminalAction): {
    draft: string;
    previousAction: CardActionState | null;
    runningTools: RunningTool[];
  } {
    const c = this.get(sessionId);
    const snapshot = {
      draft: c.draftText,
      previousAction: c.action,
      runningTools: [...c.runningTools.values()],
    };
    c.runningTools.clear();
    c.action = action;
    this.syncAction(sessionId, c);
    return snapshot;
  }

  /** Authoritative full state used for durable pending and terminal history. */
  state(sessionId: string): { draft: string; action: CardActionState | null } {
    const c = this.cards.get(sessionId);
    return { draft: c?.draftText ?? '', action: c?.action ?? null };
  }

  /** Rehydrate a durable pending card after a daemon/process restart. */
  restore(sessionId: string, snapshot: { draft: string; action: CardActionState | null }): void {
    const c = this.get(sessionId);
    c.draftText = snapshot.draft;
    c.resetNext = false;
    c.action = snapshot.action;
    c.runningTools.clear();
    c.lastActionKey = this.actionKey(snapshot.action);
  }

  // ── Lifecycle ─────────────────────────────────────────

  /** Turn ended (idle/abort) — wipe the card and broadcast the cleared state. */
  clear(sessionId: string): void {
    this.cards.set(sessionId, {
      draftText: '', resetNext: false, action: null, runningTools: new Map(), lastActionKey: 'null',
    });
    this.broadcast({ type: 'agent_message_delta', sessionId, payload: { content: '', reset: true } });
    this.broadcast({ type: 'card_action', sessionId, payload: { action: null } });
  }

  /** Session gone — drop state without broadcasting (arms render `ended`). */
  delete(sessionId: string): void {
    this.cards.delete(sessionId);
  }

  /** The two messages that seed a (re)joining client's card. */
  snapshot(sessionId: string): CardBroadcast[] {
    const c = this.cards.get(sessionId);
    return [
      { type: 'agent_message_delta', sessionId, payload: { content: c?.draftText ?? '', reset: true } },
      { type: 'card_action', sessionId, payload: { action: c?.action ?? null } },
    ];
  }

  /** Session ids that currently carry meaningful card state (live draft or an
   *  active action) — the set worth pushing to a freshly-joined consumer so a
   *  mid-turn reconnect re-seeds without a client round-trip. */
  activeSessions(): string[] {
    const out: string[] = [];
    for (const [sid, c] of this.cards) {
      if (c.draftText || c.action) out.push(sid);
    }
    return out;
  }
}
