/**
 * Conversation spine → rendered rows. A direct port of the iOS/Mac client
 * (`TurnSpineProjection`, `ChatViewModel.presentingQuestions`,
 * `ChatViewModel.shouldRender`, `ChatMessage.frozenCard`) so the three
 * clients draw the same conversation from the same records.
 */
import type { Attachment, ContentRef } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';

// ── Loose accessors (records are protocol unions; payloads vary by type) ──

type Payload = Record<string, unknown>;

export function payloadOf(message: ChatMessage): Payload {
  return ((message as { payload?: unknown }).payload ?? {}) as Payload;
}

export function seqOf(message: ChatMessage): number {
  const seq = (message as { seq?: unknown }).seq;
  return typeof seq === 'number' ? seq : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function contentOf(message: ChatMessage): string {
  return str(payloadOf(message).content) ?? '';
}

export function draftOf(message: ChatMessage): string {
  return str(payloadOf(message).draft) ?? '';
}

export function attachmentsOf(message: ChatMessage): Attachment[] {
  const value = payloadOf(message).attachments;
  return Array.isArray(value) ? (value as Attachment[]) : [];
}

export function isSteer(message: ChatMessage): boolean {
  return payloadOf(message).delivery === 'steer';
}

export function answerToOf(message: ChatMessage): string | undefined {
  return str(payloadOf(message).answerTo);
}

// ── Questions ──

export interface QuestionSpec {
  id: string;
  text: string;
  choices: string[];
}

/** `agent_message.payload.question`: the agent asked the human. */
export function questionSpecOf(message: ChatMessage): QuestionSpec | undefined {
  if (message.type !== 'agent_message') return undefined;
  const q = payloadOf(message).question as { id?: unknown; text?: unknown; choices?: unknown } | undefined;
  if (!q || typeof q.id !== 'string') return undefined;
  const choices = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === 'string') : [];
  return { id: q.id, text: str(q.text) ?? '', choices };
}

export type QuestionState = 'open' | 'answered' | 'unanswered' | 'undetermined';

/** `user_abort` | `failed`, with the failure message if any. */
export interface TerminalOutcome {
  type: 'user_abort' | 'failed';
  message?: string;
}

export interface QuestionPresentation {
  state: QuestionState;
  /** The turn ended while this question was asked and nothing streamed after
   *  it: the outcome is drawn inside the question bubble. */
  outcome?: TerminalOutcome;
}

/** Terminal outcome of a `turn_status` (or legacy `interrupted_turn`). */
export function terminalOutcomeOf(message: ChatMessage): TerminalOutcome | undefined {
  const p = payloadOf(message);
  if (message.type === 'turn_status') {
    const action = p.action as { type?: unknown; payload?: { message?: unknown } } | undefined;
    if (action?.type !== 'user_abort' && action?.type !== 'failed') return undefined;
    const detail = str(action.payload?.message);
    return detail ? { type: action.type, message: detail } : { type: action.type };
  }
  if (message.type === 'interrupted_turn') {
    return p.reason === 'process_lost'
      ? { type: 'failed', message: 'Agent process was lost' }
      : { type: 'user_abort' };
  }
  return undefined;
}

/** A spine record plus what the client derives for drawing it. */
export interface SpineItem {
  message: ChatMessage;
  question?: QuestionPresentation;
}

/**
 * Present each question from what follows it on the spine:
 * - its answer (`answerTo` = its id, persisted or optimistic) → answered;
 * - other questions, answers to them, and transient `error` rows are neutral;
 * - anything else → unanswered. When that is the draft-less terminal status
 *   of the turn, its outcome is drawn inside the question bubble and the empty
 *   status row itself is not rendered (`shouldRender`);
 * - nothing yet: open at the conversation head, otherwise undetermined.
 */
export function presentQuestions(raw: ChatMessage[], pendingAnswerTo: string[], atHead: boolean): SpineItem[] {
  const items: SpineItem[] = raw.map((message) => ({ message }));
  if (!raw.some((m) => questionSpecOf(m))) return items;
  for (let index = 0; index < raw.length; index++) {
    const spec = questionSpecOf(raw[index]);
    if (!spec) continue;
    let presentation: QuestionPresentation | undefined;
    for (let later = index + 1; later < raw.length; later++) {
      const next = raw[later];
      if (answerToOf(next) === spec.id) { presentation = { state: 'answered' }; break; }
      if (questionSpecOf(next) || answerToOf(next) !== undefined || next.type === 'error') continue;
      const draftless = draftOf(next).trim() === '';
      const outcome = draftless ? terminalOutcomeOf(next) : undefined;
      presentation = outcome ? { state: 'unanswered', outcome } : { state: 'unanswered' };
      break;
    }
    if (!presentation) {
      presentation = pendingAnswerTo.includes(spec.id)
        ? { state: 'answered' }
        : { state: atHead ? 'open' : 'undetermined' };
    }
    items[index] = { message: raw[index], question: presentation };
  }
  return items;
}

// ── Turn projection ──

const TRACE_TYPES = new Set(['tool_start', 'tool_complete', 'agent_narration', 'active']);

function isConclusionReply(message: ChatMessage): boolean {
  return message.type === 'agent_message' && !questionSpecOf(message);
}

function turnArtifactsOf(message: ChatMessage): ContentRef[] {
  if (message.type !== 'idle') return [];
  const value = payloadOf(message).turnArtifacts;
  return Array.isArray(value)
    ? (value as ContentRef[]).filter((a) => a && a.type === 'content_ref')
    : [];
}

function attaching(artifacts: ContentRef[], item: SpineItem): SpineItem {
  if (artifacts.length === 0) return item;
  const existing = attachmentsOf(item.message);
  const seen = new Set(existing.map((a) => (a.type === 'content_ref' ? `ref:${a.id}` : `img:${a.mimeType}:${a.data.length}`)));
  const merged = [...existing];
  for (const artifact of artifacts) {
    const key = `ref:${artifact.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(artifact);
  }
  return { ...item, message: { ...item.message, payload: { ...payloadOf(item.message), attachments: merged } } as ChatMessage };
}

/** The turn's last output fills a draft-less terminal status. A question is
 *  output too: when it is last, it carries the outcome itself. */
function normalizedTerminal(terminal: SpineItem, prefix: SpineItem[]): SpineItem {
  let fallback: ChatMessage | undefined;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const m = prefix[i].message;
    if (m.type !== 'agent_message') continue;
    if (questionSpecOf(m) || contentOf(m) || attachmentsOf(m).length) { fallback = m; break; }
  }
  if (!fallback || questionSpecOf(fallback)) return terminal;
  const ownDraft = draftOf(terminal.message);
  const needsDraft = !ownDraft && !!contentOf(fallback);
  const needsAttachments = attachmentsOf(terminal.message).length === 0 && attachmentsOf(fallback).length > 0;
  if (!needsDraft && !needsAttachments) return terminal;
  const payload = { ...payloadOf(terminal.message) };
  if (needsDraft) payload.draft = contentOf(fallback);
  if (needsAttachments) payload.attachments = attachmentsOf(fallback);
  return { ...terminal, message: { ...terminal.message, payload } as ChatMessage };
}

function keepOnlyFinalConclusionPerLogicalLifecycle(items: SpineItem[]): SpineItem[] {
  const retained = new Set<number>();
  let selected: number | undefined;
  let terminalOwnsTurn = false;
  let crossedIdle = false;
  let sawSteerAfterIdle = false;
  const retainSelected = () => { if (selected !== undefined) retained.add(selected); };

  items.forEach(({ message }, index) => {
    switch (message.type) {
      case 'user_message':
      case 'send_input':
        if (!isSteer(message)) {
          retainSelected();
          selected = undefined;
          terminalOwnsTurn = false;
          crossedIdle = false;
          sawSteerAfterIdle = false;
        } else if (crossedIdle) {
          sawSteerAfterIdle = true;
        }
        break;
      case 'agent_message':
        if (questionSpecOf(message)) break;
        if (crossedIdle) { retainSelected(); selected = undefined; terminalOwnsTurn = false; }
        if (!terminalOwnsTurn) selected = index;
        crossedIdle = false;
        sawSteerAfterIdle = false;
        break;
      case 'turn_status':
      case 'interrupted_turn':
        if (crossedIdle && sawSteerAfterIdle) { retainSelected(); selected = undefined; terminalOwnsTurn = false; }
        selected = index;
        terminalOwnsTurn = true;
        crossedIdle = false;
        sawSteerAfterIdle = false;
        break;
      case 'idle':
        crossedIdle = true;
        sawSteerAfterIdle = false;
        break;
      default:
        break;
    }
  });
  retainSelected();

  return items.filter(({ message }, index) => {
    const isConclusion = isConclusionReply(message)
      || message.type === 'turn_status' || message.type === 'interrupted_turn';
    return !isConclusion || retained.has(index);
  });
}

/** Project durable records into the bubbles a turn shows (iOS
 *  `TurnSpineProjection.project`). */
export function projectTurns(items: SpineItem[]): SpineItem[] {
  const projected: SpineItem[] = [];
  let segment: SpineItem[] = [];

  const flush = () => {
    if (segment.length === 0) return;
    let artifacts: ContentRef[] = [];
    for (let i = segment.length - 1; i >= 0; i--) {
      if (segment[i].message.type === 'idle') { artifacts = turnArtifactsOf(segment[i].message); break; }
    }
    let terminalIndex = -1;
    for (let i = segment.length - 1; i >= 0; i--) {
      const t = segment[i].message.type;
      if (t === 'turn_status' || t === 'interrupted_turn') { terminalIndex = i; break; }
    }
    if (terminalIndex >= 0) {
      const terminal = attaching(artifacts, normalizedTerminal(segment[terminalIndex], segment.slice(0, terminalIndex)));
      segment.forEach((item, index) => {
        const m = item.message;
        if (m.type === 'error') return;
        if (isConclusionReply(m)) return;
        projected.push(index === terminalIndex ? terminal : item);
      });
    } else {
      const visible = segment.filter((item) => item.message.type !== 'error');
      if (artifacts.length) {
        for (let i = visible.length - 1; i >= 0; i--) {
          const m = visible[i].message;
          if (isConclusionReply(m) || m.type === 'system_message') { visible[i] = attaching(artifacts, visible[i]); break; }
        }
      }
      projected.push(...visible);
    }
    segment = [];
  };

  for (const item of items) {
    if (TRACE_TYPES.has(item.message.type)) continue;
    segment.push(item);
    if (item.message.type === 'idle') flush();
  }
  flush();
  return keepOnlyFinalConclusionPerLogicalLifecycle(projected);
}

const RENDERABLE_TYPES = new Set([
  'user_message', 'send_input', 'agent_message', 'interrupted_turn', 'turn_status', 'system_message',
]);

/** Terminal metadata without a draft is not conversation content. */
export function shouldRender(item: SpineItem): boolean {
  const { message } = item;
  if (!RENDERABLE_TYPES.has(message.type)) return false;
  if (message.type === 'turn_status' || message.type === 'interrupted_turn') {
    return draftOf(message).trim() !== '';
  }
  return true;
}

/** The whole pipeline the chat list draws (spine + derived question state). */
export function spineRows(raw: ChatMessage[], pendingAnswerTo: string[], atHead: boolean): SpineItem[] {
  return projectTurns(presentQuestions(raw, pendingAnswerTo, atHead)).filter(shouldRender);
}

// ── Row identity + frozen card ──

/** Both lists cache a row's measured height by key, so a row whose drawing
 *  changes gets a new key. Only states that draw differently differ. */
export function rowKey(item: SpineItem): string {
  const base = `${seqOf(item.message)}`;
  const q = item.question;
  if (!q) return base;
  if (q.state === 'open') return `${base}#q-open`;
  if (q.outcome) return `${base}#q-${q.outcome.type}`;
  return base;
}

export type CardAction =
  | { type: 'question'; id: string; choices: string[] }
  | { type: 'user_abort' | 'failed'; message?: string };

export interface FrozenCard {
  text: string;
  action?: CardAction;
}

/** Body text + action slot of a row drawn as a frozen card (the same bubble
 *  as the live card): a terminal status (its draft + outcome), or a question
 *  (lead-in and **bold** question — identical in every state — plus choices
 *  while open, or the outcome of the turn that ended while it was asked). */
export function frozenCardOf(item: SpineItem): FrozenCard | undefined {
  const { message } = item;
  const spec = questionSpecOf(message);
  if (spec) {
    const parts: string[] = [];
    const lead = contentOf(message);
    if (lead) parts.push(lead);
    const bold = spec.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `**${l}**`).join('\n');
    if (bold) parts.push(bold);
    let action: CardAction | undefined;
    if (item.question?.state === 'open') action = { type: 'question', id: spec.id, choices: spec.choices };
    else if (item.question?.outcome) action = { ...item.question.outcome };
    return { text: parts.join('\n\n'), action };
  }
  if (message.type !== 'turn_status' && message.type !== 'interrupted_turn') return undefined;
  const outcome = terminalOutcomeOf(message);
  return { text: draftOf(message), action: outcome ? { ...outcome } : undefined };
}

/** Open questions (oldest first); the composer answers the newest one. */
export function openQuestions(raw: ChatMessage[], pendingAnswerTo: string[], atHead: boolean): QuestionSpec[] {
  if (!raw.some((m) => questionSpecOf(m))) return [];
  return presentQuestions(raw, pendingAnswerTo, atHead)
    .filter((item) => item.question?.state === 'open')
    .map((item) => questionSpecOf(item.message)!)
    .filter(Boolean);
}
