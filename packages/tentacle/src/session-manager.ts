/**
 * Tentacle session manager.
 *
 * Owns session lifecycle: create, resume, crash recovery, context persistence.
 * The head doesn't know about runs or context — it just sees sessionIds.
 * This is the tentacle's local intelligence layer.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync, openSync, readSync, closeSync, cpSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config.js';
import type { CardActionState, ContentRef } from '@kraki/protocol';

const PREVIEW_MAX = 80;

/** Replace lone UTF-16 surrogates before serializing text for strict JSON consumers. */
function toWellFormedText(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[i] + text[++i];
      } else {
        result += '\ufffd';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      result += '\ufffd';
    } else {
      result += text[i];
    }
  }
  return result;
}

/** Truncate by Unicode code point, never through the middle of an emoji. */
function truncateText(text: string, maxCodePoints: number): string {
  return Array.from(toWellFormedText(text)).slice(0, maxCodePoints).join('');
}

/** Strip common markdown syntax for clean preview display. */
function stripMarkdownForPreview(text: string): string {
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateText(stripped, PREVIEW_MAX);
}

// ── Types ───────────────────────────────────────────────

/** A single logged message in a session's message log. */
export interface LoggedMessage {
  seq: number;
  type: string;
  payload: string;
  ts: string;
}

/**
 * One line in a session's `trace.jsonl` — a tool_start/tool_complete broadcast
 * mirrored off the spine. Tagged with the turn's start seq (the user_message
 * that began the turn) so a turn's steps can be pulled by its bubble seq.
 * `payload` is the full enriched wire message (same JSON that was broadcast).
 */
export interface TraceLine {
  turnStartSeq: number;
  type: string;
  payload: string;
  ts: string;
}

// ── Types ───────────────────────────────────────────────

export interface SessionContext {
  summary: string;
  keyFiles: string[];
  lastUserMessage: string;
  pendingAction?: string;
  updatedAt: string;
}

export type SessionMode = 'safe' | 'discuss' | 'execute' | 'delegate';

export interface SessionMeta {
  id: string;
  agent: string;
  model?: string;
  title?: string;
  autoTitle?: string;
  state: 'active' | 'idle' | 'ended' | 'disconnected';
  mode: SessionMode;
  pinned?: boolean;
  currentRunId: string;
  totalRuns: number;
  lastSeq: number;
  readSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Cumulative token usage (persisted across restarts) */
  usage?: import('@kraki/protocol').SessionUsage;
  /** Origin of this session — set for imported sessions */
  source?: import('@kraki/protocol').LocalSessionSource | 'imported';
  /** True once the one-shot legacy-inline-image migration has run.
   *  See `stripLegacyInlineImages` — pre-MCP versions of Kraki stored
   *  image bytes inline inside tool_complete entries in messages.jsonl,
   *  which inflated replay batches above the relay's 10MB frame cap and
   *  caused the daemon's WS to drop. The migration strips those bytes
   *  in place (the bytes weren't recoverable via the new ref path anyway,
   *  since they came from `view`-on-an-image, not show_image). */
  inlineImagesStripped?: boolean;
  /** Seq numbers of idle messages — used for turn-aligned pagination. */
  idleSeqs?: number[];
  /** Spine seq of the user_message that began the current turn. Trace
   *  entries (tool_start/tool_complete) are tagged with this so a turn's
   *  steps can be pulled by its concluding bubble seq. Mid-turn spine
   *  messages (permission/question) do NOT move it. */
  currentTurnStartSeq?: number;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
}

/** Durable human-blocking state kept outside the model transcript. */
export interface PendingHumanAction {
  version: 1;
  kind: 'question';
  questionId: string;
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  draft: string;
  action: CardActionState;
  createdAt: string;
}

// ── Session Manager ─────────────────────────────────────

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(getConfigDir(), 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.migrateGlobalLog();
    this.stripAllLegacyInlineImages();
    this.clampOverflowReadSeq();
  }

  /**
   * One-shot migration: clamp every session's `readSeq` to at most
   * its `lastSeq`. Pre-fix, arms could send `mark_read` with an
   * arbitrary seq (web's `getLastSeq` fallback walked the in-memory
   * message store and sometimes returned a value that wasn't really
   * a session-message seq) — and `markRead` here trusted it
   * blindly. This left ~35 % of sessions with readSeq > lastSeq (one
   * sample: lastSeq=472, readSeq=27,265 — 57× overshoot), which
   * broke unread badges and triggered noisy `session_read` echoes
   * across all peer arms.
   *
   * Idempotent: only rewrites meta files where readSeq actually
   * exceeds lastSeq.
   */
  private clampOverflowReadSeq(): void {
    if (!existsSync(this.sessionsDir)) return;
    let dirs: string[];
    try {
      dirs = readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const dir of dirs) {
      const meta = this.readMeta(dir);
      if (!meta) continue;
      const ls = meta.lastSeq ?? 0;
      const rs = meta.readSeq ?? 0;
      if (rs > ls) {
        meta.readSeq = ls;
        meta.updatedAt = new Date().toISOString();
        try {
          this.writeMeta(dir, meta);
        } catch {
          // Best-effort — failures never crash startup
        }
      }
    }
  }

  /**
   * Migrate from global message-log.jsonl to per-session message logs.
   * Runs once on startup — if the old file exists, splits it by sessionId.
   */
  private migrateGlobalLog(): void {
    const configDir = this.sessionsDir.replace(/\/sessions$/, '');
    const oldLogPath = join(configDir, 'message-log.jsonl');
    if (!existsSync(oldLogPath)) return;

    let content: string;
    try {
      content = readFileSync(oldLogPath, 'utf8');
    } catch {
      return;
    }

    const bySession = new Map<string, Array<{ seq: number; type: string; payload: string; ts: string }>>();
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const sid = msg.sessionId;
        if (!sid) continue;
        if (!bySession.has(sid)) bySession.set(sid, []);
        bySession.get(sid)!.push({ seq: msg.seq, type: msg.type, payload: msg.payload, ts: msg.ts });
      } catch { /* skip */ }
    }

    for (const [sid, messages] of bySession) {
      const sessionDir = this.sessionDir(sid);
      const logPath = join(sessionDir, 'messages.jsonl');
      if (existsSync(logPath)) continue; // already migrated or has its own log

      if (!existsSync(sessionDir)) {
        mkdirSync(join(sessionDir, 'runs'), { recursive: true });
      }

      const logContent = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
      writeFileSync(logPath, logContent, 'utf8');

      // Update lastSeq in meta if it exists
      const meta = this.readMeta(sid);
      if (meta) {
        const maxSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
        if (maxSeq > (meta.lastSeq ?? 0)) {
          meta.lastSeq = maxSeq;
          this.writeMeta(sid, meta);
        }
      }
    }

    // Remove old global log
    try {
      rmSync(oldLogPath);
    } catch { /* ignore */ }
  }

  /**
   * One-shot migration: for every session, strip inline image attachments
   * from tool_complete entries in messages.jsonl. Pre-MCP versions of
   * Kraki carried image bytes inline; after this migration, image bytes
   * only flow via the `kraki-show_image` ref + chunked attachment_data
   * pipeline. Bytes for pre-existing `view`-on-image entries are NOT
   * preserved — they were never the agent's intentional output anyway.
   *
   * The migration is per-session, idempotent, and atomic per file.
   */
  private stripAllLegacyInlineImages(): void {
    if (!existsSync(this.sessionsDir)) return;
    let dirs: string[];
    try {
      dirs = readdirSync(this.sessionsDir);
    } catch {
      return;
    }
    for (const dir of dirs) {
      const meta = this.readMeta(dir);
      if (!meta || meta.inlineImagesStripped) continue;
      try {
        this.stripLegacyInlineImagesForSession(dir);
        meta.inlineImagesStripped = true;
        this.writeMeta(dir, meta);
      } catch {
        // Best-effort — failures are logged below but never crash startup
      }
    }
  }

  private stripLegacyInlineImagesForSession(sessionId: string): void {
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) return;

    let content: string;
    try {
      content = readFileSync(logPath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    let modified = false;
    const rewritten = lines.map((line) => {
      if (!line) return line;
      let entry: { seq: number; type: string; payload: string; ts: string };
      try {
        entry = JSON.parse(line) as { seq: number; type: string; payload: string; ts: string };
      } catch {
        return line;
      }
      if (entry.type !== 'tool_complete' && entry.type !== 'agent_message' && entry.type !== 'user_message') {
        return line;
      }
      let inner: Record<string, unknown>;
      try {
        inner = JSON.parse(entry.payload) as Record<string, unknown>;
      } catch {
        return line;
      }
      const payload = inner.payload as Record<string, unknown> | undefined;
      const attachments = payload?.attachments;
      if (!Array.isArray(attachments) || attachments.length === 0) return line;

      // Drop any attachment that carries inline `data` (legacy shape). Refs
      // (type === 'content_ref') are kept untouched.
      let droppedAny = false;
      const filtered = attachments.filter((a) => {
        if (a && typeof a === 'object' && (a as Record<string, unknown>).type === 'image' && typeof (a as Record<string, unknown>).data === 'string') {
          droppedAny = true;
          return false;
        }
        return true;
      });

      if (!droppedAny) return line;

      if (filtered.length > 0) {
        payload!.attachments = filtered;
      } else {
        delete payload!.attachments;
      }
      entry.payload = JSON.stringify(inner);
      modified = true;
      return JSON.stringify(entry);
    });

    if (!modified) return;

    // Atomic rewrite via tmp file + rename
    const tmpPath = `${logPath}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, rewritten.join('\n'));
    renameSync(tmpPath, logPath);
  }

  /**
   * Create a new session. Returns the session ID.
   */
  createSession(agent: string, model?: string, sessionId?: string): { sessionId: string; runId: string } {
    const id = sessionId ?? `sess_${randomUUID().slice(0, 12)}`;
    const runId = 'run_001';
    const sessionDir = this.sessionDir(id);
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });

    const meta: SessionMeta = {
      id,
      agent,
      model,
      state: 'active',
      mode: 'discuss',
      currentRunId: runId,
      totalRuns: 1,
      lastSeq: 0,
      readSeq: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const run: RunRecord = {
      id: runId,
      startedAt: new Date().toISOString(),
    };

    this.writeMeta(id, meta);
    this.writeRun(id, run);
    this.writeContext(id, {
      summary: '',
      keyFiles: [],
      lastUserMessage: '',
      updatedAt: new Date().toISOString(),
    });

    return { sessionId: id, runId };
  }

  /**
   * Resume a session after crash/restart. Creates a new run.
   * Returns context for the agent to recover.
   */
  resumeSession(sessionId: string): { runId: string; context: SessionContext } | null {
    const meta = this.readMeta(sessionId);
    if (!meta) return null;

    const context = this.readContext(sessionId) ?? {
      summary: '',
      keyFiles: [],
      lastUserMessage: '',
      updatedAt: new Date().toISOString(),
    };

    const runNum = meta.totalRuns + 1;
    const runId = `run_${String(runNum).padStart(3, '0')}`;

    // End previous run
    const prevRun = this.readRun(sessionId, meta.currentRunId);
    if (prevRun && !prevRun.endedAt) {
      prevRun.endedAt = new Date().toISOString();
      prevRun.endReason = 'crashed';
      this.writeRun(sessionId, prevRun);
    }

    // Start new run
    const newRun: RunRecord = {
      id: runId,
      startedAt: new Date().toISOString(),
    };
    this.writeRun(sessionId, newRun);

    // Update meta
    meta.state = 'active';
    meta.currentRunId = runId;
    meta.totalRuns = runNum;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);

    return { runId, context };
  }

  /**
   * Mark a session as ended normally.
   */
  endSession(sessionId: string, reason: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;

    meta.state = 'ended';
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);

    const run = this.readRun(sessionId, meta.currentRunId);
    if (run && !run.endedAt) {
      run.endedAt = new Date().toISOString();
      run.endReason = reason;
      this.writeRun(sessionId, run);
    }
  }

  /**
   * Mark a session as idle (turn completed, awaiting next input).
   * Unlike endSession, does not close the current run.
   */
  markIdle(sessionId: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta || meta.state === 'idle') return;

    meta.state = 'idle';
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Mark a session as active (new input received, turn starting).
   */
  markActive(sessionId: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta || meta.state === 'active' || meta.state === 'ended') return;

    meta.state = 'active';
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Delete a session permanently. Removes all files for this session.
   */
  deleteSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
  }

  /**
   * Fork a session: copy meta, context, and messages with a new ID.
   * Returns the new session ID and run ID.
   */
  forkSession(sourceSessionId: string): { sessionId: string; runId: string } | null {
    const sourceMeta = this.readMeta(sourceSessionId);
    if (!sourceMeta) return null;

    const newId = `${sourceSessionId.split('-')[0]}-${randomUUID().slice(0, 8)}`;
    const runId = 'run_001';
    const newDir = this.sessionDir(newId);
    mkdirSync(join(newDir, 'runs'), { recursive: true });

    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: newId,
      agent: sourceMeta.agent,
      model: sourceMeta.model,
      title: sourceMeta.title ? `Fork of ${sourceMeta.title}` : undefined,
      autoTitle: sourceMeta.autoTitle,
      state: 'active',
      mode: 'discuss',
      currentRunId: runId,
      totalRuns: 1,
      lastSeq: sourceMeta.lastSeq ?? 0,
      readSeq: sourceMeta.lastSeq ?? 0,
      createdAt: now,
      updatedAt: now,
    };

    this.writeMeta(newId, meta);
    this.writeRun(newId, { id: runId, startedAt: now });

    // Copy context
    const context = this.readContext(sourceSessionId);
    if (context) {
      this.writeContext(newId, { ...context, updatedAt: now });
    }

    // Copy message log
    const srcLog = join(this.sessionDir(sourceSessionId), 'messages.jsonl');
    const dstLog = join(newDir, 'messages.jsonl');
    if (existsSync(srcLog)) {
      cpSync(srcLog, dstLog);
    }

    return { sessionId: newId, runId };
  }

  /**
   * Mark a session as disconnected (agent process died unexpectedly).
   */
  markDisconnected(sessionId: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;

    meta.state = 'disconnected';
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Update session context (rolling summary for recovery).
   */
  updateContext(sessionId: string, context: Partial<SessionContext>): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return; // Session doesn't exist — no-op

    const existing = this.readContext(sessionId) ?? {
      summary: '',
      keyFiles: [],
      lastUserMessage: '',
      updatedAt: new Date().toISOString(),
    };

    const updated: SessionContext = {
      ...existing,
      ...context,
      updatedAt: new Date().toISOString(),
    };

    this.writeContext(sessionId, updated);
  }

  /**
   * Update session title (e.g., auto-generated by agent).
   */
  setTitle(sessionId: string, title: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.title = title || undefined;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Set LLM-generated auto-title.
   */
  setAutoTitle(sessionId: string, autoTitle: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.autoTitle = autoTitle;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Set session permission mode.
   */
  setMode(sessionId: string, mode: SessionMode): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.mode = mode;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Set session pin state.
   */
  setPin(sessionId: string, pinned: boolean): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.pinned = pinned || undefined;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Set session model.
   */
  setModel(sessionId: string, model: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.model = model;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Update cumulative token usage for a session.
   */
  setUsage(sessionId: string, usage: import('@kraki/protocol').SessionUsage): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.usage = usage;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Get sessions that need resume after a daemon restart (active, idle, or
   * disconnected). Returned in no particular order.
   *
   * Note: resume is lazy — `resumeDisconnectedSessions` in `RelayClient` only
   * logs this list on startup; actual SDK resume happens per-session in
   * `ensureSessionResumed` when the user first interacts with each one. So
   * there is no cap here — eligibility is just "isn't ended/removed".
   */
  getResumableSessions(): SessionMeta[] {
    const sessions: SessionMeta[] = [];
    if (!existsSync(this.sessionsDir)) return sessions;

    for (const dir of readdirSync(this.sessionsDir)) {
      const meta = this.readMeta(dir);
      if (meta && (meta.state === 'active' || meta.state === 'idle' || meta.state === 'disconnected')) {
        sessions.push(meta);
      }
    }
    return sessions;
  }

  /**
   * Get session context for a session.
   */
  getContext(sessionId: string): SessionContext | null {
    return this.readContext(sessionId);
  }

  /**
   * Get session metadata.
   */
  getMeta(sessionId: string): SessionMeta | null {
    return this.readMeta(sessionId);
  }

  /**
   * Whether a session exists and is not in a terminal state.
   * Used by the Kraki MCP server to validate `tools/call` requests whose
   * URL path carries a sessionId — calls for unknown/ended sessions are
   * rejected so the agent can't address arbitrary sessionIds.
   */
  isSessionActive(sessionId: string): boolean {
    const meta = this.readMeta(sessionId);
    if (!meta) return false;
    return meta.state !== 'ended';
  }

  /** Public accessor: absolute path to a session's directory. */
  getSessionDir(sessionId: string): string {
    return this.sessionDir(sessionId);
  }

  /** Public accessor: absolute path to the sessions root. */
  getSessionsRoot(): string {
    return this.sessionsDir;
  }

  /**
   * Bulk-update session metadata fields. Reads from disk, merges, writes back.
   */
  updateMeta(sessionId: string, updates: Partial<Pick<SessionMeta, 'model' | 'title' | 'autoTitle' | 'source' | 'createdAt' | 'state' | 'mode' | 'pinned'>>): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    if (updates.model !== undefined) meta.model = updates.model;
    if (updates.title !== undefined) meta.title = updates.title || undefined;
    if (updates.autoTitle !== undefined) meta.autoTitle = updates.autoTitle;
    if (updates.source !== undefined) meta.source = updates.source;
    if (updates.createdAt !== undefined) meta.createdAt = updates.createdAt;
    if (updates.state !== undefined) meta.state = updates.state;
    if (updates.mode !== undefined) meta.mode = updates.mode;
    if (updates.pinned !== undefined) meta.pinned = updates.pinned || undefined;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  // ── Durable human-action state ─────────────────────────

  private pendingActionPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'pending-human-action.json');
  }

  savePendingHumanAction(sessionId: string, pending: PendingHumanAction): void {
    const path = this.pendingActionPath(sessionId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(pending), 'utf8');
    renameSync(tmp, path);
  }

  getPendingHumanAction(sessionId: string): PendingHumanAction | null {
    const path = this.pendingActionPath(sessionId);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as PendingHumanAction;
      if (value?.version !== 1 || value.kind !== 'question' || !value.questionId) return null;
      return value;
    } catch {
      return null;
    }
  }

  clearPendingHumanAction(sessionId: string): void {
    rmSync(this.pendingActionPath(sessionId), { force: true });
  }

  // ── Message log ────────────────────────────────────────

  /**
   * Append a message to a session's log. Assigns the next per-session seq.
   * Returns the assigned seq number.
   */
  appendMessage(sessionId: string, type: string, payload: string): number {
    const meta = this.readMeta(sessionId);
    if (!meta) return 0;

    const seq = (meta.lastSeq ?? 0) + 1;
    const entry: LoggedMessage = { seq, type, payload, ts: new Date().toISOString() };
    const line = JSON.stringify(entry) + '\n';
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    appendFileSync(logPath, line, 'utf8');

    if (type === 'idle') {
      if (!meta.idleSeqs) meta.idleSeqs = [];
      meta.idleSeqs.push(seq);
    }

    // A user_message begins a new turn — remember its seq so trace entries
    // recorded until the next user_message can be tagged to this turn.
    if (type === 'user_message') {
      meta.currentTurnStartSeq = seq;
    }

    meta.lastSeq = seq;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);

    return seq;
  }

  /**
   * Batch-append messages to a session's log in a single write.
   * Much faster than calling appendMessage() N times.
   * Returns the final seq number.
   */
  appendMessagesBatch(sessionId: string, messages: Array<{ type: string; payload: string; ts?: string }>): number {
    const meta = this.readMeta(sessionId);
    if (!meta || messages.length === 0) return meta?.lastSeq ?? 0;

    let seq = meta.lastSeq ?? 0;
    const now = new Date().toISOString();
    const lines: string[] = [];

    for (const m of messages) {
      seq++;
      const entry: LoggedMessage = { seq, type: m.type, payload: m.payload, ts: m.ts ?? now };
      lines.push(JSON.stringify(entry));
    }

    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');

    for (let i = 0; i < messages.length; i++) {
      if (messages[i].type === 'idle') {
        if (!meta.idleSeqs) meta.idleSeqs = [];
        meta.idleSeqs.push(seq - messages.length + i + 1);
      }
      if (messages[i].type === 'user_message') {
        meta.currentTurnStartSeq = seq - messages.length + i + 1;
      }
    }

    meta.lastSeq = seq;
    meta.updatedAt = now;
    this.writeMeta(sessionId, meta);

    return seq;
  }

  /**
   * Get messages for a session with seq > afterSeq.
   */
  getMessagesAfterSeq(sessionId: string, afterSeq: number, limit?: number): LoggedMessage[] {
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) return [];

    let content: string;
    try {
      content = readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }

    const messages: LoggedMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as LoggedMessage;
        if (msg.seq > afterSeq) {
          messages.push(msg);
          if (limit && messages.length >= limit) break;
        }
      } catch {
        // Skip corrupted lines
      }
    }
    return messages;
  }

  // ── Turn trace (TRACE axis) ─────────────────────────────

  /**
   * Mirror a tool_start/tool_complete broadcast to the session's `trace.jsonl`.
   * These are NOT on the spine (no per-session seq); they are tagged with the
   * current turn's start seq so {@link readTurnTrace} can slice them per turn.
   */
  appendTrace(sessionId: string, type: string, payload: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    const entry: TraceLine = {
      turnStartSeq: meta.currentTurnStartSeq ?? 0,
      type,
      payload,
      ts: new Date().toISOString(),
    };
    const tracePath = join(this.sessionDir(sessionId), 'trace.jsonl');
    appendFileSync(tracePath, JSON.stringify(entry) + '\n', 'utf8');
  }

  /**
   * Read one turn's tool trace, keyed by the concluding bubble's spine seq.
   *
   * The turn is resolved as "the greatest user_message seq <= bubbleSeq" —
   * the user_message that began the turn — and all trace entries tagged with
   * that start seq are returned in recorded order. `complete` is true once the
   * turn has gone idle (an idle exists at/after the bubble); while still
   * running it is false and the live client keeps appending from broadcasts.
   */
  readTurnTrace(sessionId: string, bubbleSeq: number): { entries: unknown[]; complete: boolean; turnStartSeq: number } {
    const meta = this.readMeta(sessionId);
    if (!meta) return { entries: [], complete: false, turnStartSeq: 0 };

    // Resolve the turn start: greatest user_message seq <= bubbleSeq.
    let turnStartSeq = 0;
    for (const m of this.getMessagesAfterSeq(sessionId, 0)) {
      if (m.type === 'user_message' && m.seq <= bubbleSeq && m.seq > turnStartSeq) {
        turnStartSeq = m.seq;
      }
    }

    const complete = (meta.idleSeqs ?? []).some(s => s >= bubbleSeq);

    return {
      entries: this.readTraceEntriesForTurnStart(sessionId, turnStartSeq),
      complete,
      turnStartSeq,
    };
  }

  /**
   * Read durable user-visible artifact refs produced in the current turn.
   * Persisted TRACE is the authority so a Tentacle restart between tool
   * completion and idle does not lose the refs.
   */
  readCurrentTurnArtifacts(sessionId: string): ContentRef[] {
    const meta = this.readMeta(sessionId);
    const turnStartSeq = meta?.currentTurnStartSeq ?? 0;
    if (turnStartSeq <= 0) return [];
    if ((meta?.idleSeqs ?? []).some((idleSeq) => idleSeq > turnStartSeq)) return [];

    const entries = this.readTraceEntriesForTurnStart(sessionId, turnStartSeq);
    const seen = new Set<string>();
    const artifacts: ContentRef[] = [];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const message = entry as { type?: unknown; payload?: unknown };
      if (message.type !== 'tool_complete' || !message.payload || typeof message.payload !== 'object') continue;
      const payload = message.payload as {
        toolName?: unknown;
        success?: unknown;
        termination?: unknown;
        attachments?: unknown;
      };
      if (payload.success === false || payload.termination !== undefined) continue;
      if (payload.toolName !== 'show_image' && payload.toolName !== 'show_html') continue;
      if (!Array.isArray(payload.attachments)) continue;

      for (const candidate of payload.attachments) {
        const ref = this.validTurnArtifact(candidate, payload.toolName);
        if (!ref || seen.has(ref.id)) continue;
        seen.add(ref.id);
        artifacts.push(ref);
      }
    }
    return artifacts;
  }

  private readTraceEntriesForTurnStart(sessionId: string, turnStartSeq: number): unknown[] {
    if (turnStartSeq <= 0) return [];
    const tracePath = join(this.sessionDir(sessionId), 'trace.jsonl');
    if (!existsSync(tracePath)) return [];

    let content: string;
    try {
      content = readFileSync(tracePath, 'utf8');
    } catch {
      return [];
    }

    const entries: unknown[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const trace = JSON.parse(line) as TraceLine;
        if (trace.turnStartSeq !== turnStartSeq) continue;
        entries.push(JSON.parse(trace.payload));
      } catch {
        // Skip corrupted lines.
      }
    }
    return entries;
  }

  private validTurnArtifact(candidate: unknown, toolName: 'show_image' | 'show_html'): ContentRef | null {
    if (!candidate || typeof candidate !== 'object') return null;
    const ref = candidate as Partial<ContentRef>;
    if (ref.type !== 'content_ref') return null;
    if (typeof ref.id !== 'string' || ref.id.trim().length === 0) return null;
    if (typeof ref.mimeType !== 'string') return null;
    if (!Number.isFinite(ref.size) || (ref.size ?? -1) < 0) return null;
    if (toolName === 'show_image' && !ref.mimeType.startsWith('image/')) return null;
    if (toolName === 'show_html' && ref.mimeType !== 'text/html') return null;
    if (ref.name !== undefined && typeof ref.name !== 'string') return null;
    if (ref.caption !== undefined && typeof ref.caption !== 'string') return null;
    if (ref.width !== undefined && (!Number.isFinite(ref.width) || ref.width < 0)) return null;
    if (ref.height !== undefined && (!Number.isFinite(ref.height) || ref.height < 0)) return null;
    return ref as ContentRef;
  }

  /**
   * Update read state for a session (cross-device).
   */
  markRead(sessionId: string, seq: number): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    // Clamp to lastSeq — readSeq must never exceed it. Pre-fix, arms
    // sometimes sent garbage seq values (web's stale `getLastSeq`
    // fallback), and a stuck readSeq > lastSeq broke unread badges
    // and triggered noisy session_read echoes across all peers.
    const clamped = Math.min(seq, meta.lastSeq ?? 0);
    if (clamped > (meta.readSeq ?? 0)) {
      meta.readSeq = clamped;
      meta.updatedAt = new Date().toISOString();
      this.writeMeta(sessionId, meta);
    }
  }

  /**
   * Mark at least the latest spine item unread without ever advancing readSeq.
   * Returns the authoritative cursor to echo to Arms, or null when the session
   * has no spine entries.
   */
  markUnread(sessionId: string): number | null {
    const meta = this.readMeta(sessionId);
    if (!meta || (meta.lastSeq ?? 0) <= 0) return null;
    const rolledBack = Math.min(meta.readSeq ?? 0, Math.max(0, meta.lastSeq - 1));
    if (rolledBack !== (meta.readSeq ?? 0)) {
      meta.readSeq = rolledBack;
      meta.updatedAt = new Date().toISOString();
      this.writeMeta(sessionId, meta);
    }
    return rolledBack;
  }

  /**
   * Get digests for all existing sessions (for session_list sync).
   */
  getSessionList(): Array<{
    id: string;
    agent: string;
    model?: string;
    title?: string;
    autoTitle?: string;
    state: 'active' | 'idle';
    mode: SessionMode;
    pinned?: boolean;
    lastSeq: number;
    readSeq: number;
    messageCount: number;
    createdAt: string;
    usage?: import('@kraki/protocol').SessionUsage;
    source?: import('@kraki/protocol').LocalSessionSource | 'imported';
    preview?: import('@kraki/protocol').SessionPreviewDigest;
  }> {
    const result: ReturnType<SessionManager['getSessionList']> = [];
    if (!existsSync(this.sessionsDir)) return result;

    for (const dir of readdirSync(this.sessionsDir)) {
      const meta = this.readMeta(dir);
      if (!meta) continue;

      // Map 'disconnected' to 'idle' for external consumers
      const state: 'active' | 'idle' = meta.state === 'active' ? 'active' : 'idle';

      result.push({
        id: meta.id,
        agent: meta.agent,
        model: meta.model ? toWellFormedText(meta.model) : undefined,
        title: meta.title ? toWellFormedText(meta.title) : undefined,
        autoTitle: meta.autoTitle ? toWellFormedText(meta.autoTitle) : undefined,
        state,
        mode: meta.mode ?? 'discuss',
        pinned: meta.pinned || undefined,
        lastSeq: meta.lastSeq ?? 0,
        readSeq: meta.readSeq ?? 0,
        messageCount: meta.lastSeq ?? 0,
        createdAt: meta.createdAt,
        usage: meta.usage,
        source: meta.source,
        preview: (() => {
          const preview = this.getSessionPreview(meta.id);
          return preview ? { ...preview, text: toWellFormedText(preview.text) } : undefined;
        })(),
      });
    }
    return result;
  }

  // ── File I/O ──────────────────────────────────────────

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  /**
   * Read the last few lines of a session's JSONL and extract a sidebar preview.
   * Scans backward to find the last agent_message, user_message, error, permission, or question.
   */
  private getSessionPreview(sessionId: string): import('@kraki/protocol').SessionPreviewDigest | undefined {
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) return undefined;

    // Read the tail of the file (last 32KB is plenty for the last few messages)
    const TAIL_BYTES = 32 * 1024;
    let tail: string;
    try {
      const fd = openSync(logPath, 'r');
      try {
        const { size } = fstatSync(fd);
        const readStart = Math.max(0, size - TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
        readSync(fd, buf, 0, buf.length, readStart);
        tail = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }

    // Parse lines from end to find the last previewable message
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      if (!lines[i]) continue;
      try {
        const entry = JSON.parse(lines[i]) as LoggedMessage;
        const inner = JSON.parse(entry.payload);
        const payload = inner.payload as Record<string, unknown> | undefined;
        if (!payload) continue;

        switch (inner.type) {
          case 'interrupted_turn': {
            const draft = payload.draft;
            return {
              text: typeof draft === 'string' && draft ? stripMarkdownForPreview(draft) : 'Turn aborted',
              type: 'agent',
              timestamp: entry.ts,
            };
          }
          case 'agent_message': {
            const content = payload.content;
            if (typeof content === 'string' && content) {
              return { text: stripMarkdownForPreview(content), type: 'agent', timestamp: entry.ts };
            }
            break;
          }
          case 'user_message': {
            const content = payload.content;
            if (typeof content === 'string' && content) {
              return { text: stripMarkdownForPreview(content), type: 'user', timestamp: entry.ts };
            }
            break;
          }
          case 'error': {
            const message = payload.message;
            if (typeof message === 'string') {
              return { text: stripMarkdownForPreview(message), type: 'error', timestamp: entry.ts };
            }
            break;
          }
          case 'permission': {
            if (!payload.resolution) {
              const tool = typeof payload.toolName === 'string' ? payload.toolName : 'permission';
              return { text: truncateText(tool, PREVIEW_MAX), type: 'permission', timestamp: entry.ts };
            }
            break;
          }
          case 'question': {
            if (!payload.answer) {
              const q = typeof payload.question === 'string' ? payload.question : '';
              return { text: stripMarkdownForPreview(q), type: 'question', timestamp: entry.ts };
            }
            break;
          }
          case 'answer': {
            const answer = payload.answer;
            if (typeof answer === 'string' && answer) {
              return { text: stripMarkdownForPreview(answer), type: 'answer', timestamp: entry.ts };
            }
            break;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }
    return undefined;
  }

  // ── Turn-aligned pagination ──────────────────────────

  private backfillIdleSeqs(sessionId: string): void {
    const meta = this.readMeta(sessionId);
    if (!meta || meta.idleSeqs) return;

    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) {
      meta.idleSeqs = [];
      this.writeMeta(sessionId, meta);
      return;
    }

    const idles: number[] = [];
    const content = readFileSync(logPath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as LoggedMessage;
        if (entry.type === 'idle') idles.push(entry.seq);
      } catch { /* skip corrupt lines */ }
    }
    meta.idleSeqs = idles;
    this.writeMeta(sessionId, meta);
  }

  findTurnAlignedStart(sessionId: string, endSeqExclusive: number): number {
    if (endSeqExclusive <= 1) return 1;

    let meta = this.readMeta(sessionId);
    if (!meta) return 1;
    if (!meta.idleSeqs) {
      this.backfillIdleSeqs(sessionId);
      meta = this.readMeta(sessionId)!;
    }
    const idles = meta.idleSeqs ?? [];

    // Binary search: find count of idles with seq < endSeqExclusive
    let lo = 0, hi = idles.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (idles[mid] < endSeqExclusive) lo = mid + 1;
      else hi = mid;
    }
    let cursor = lo - 1;

    // Step A: anchor at latest idle before endSeqExclusive
    let candidateStart = cursor >= 0 ? idles[cursor] + 1 : 1;

    // Step B: extend backwards through whole turns until soft cap
    const TURN_SOFT_CAP = 100;
    while ((endSeqExclusive - candidateStart) < TURN_SOFT_CAP && candidateStart > 1) {
      cursor--;
      if (cursor < 0) { candidateStart = 1; break; }
      candidateStart = idles[cursor] + 1;
    }

    return candidateStart;
  }

  private readMeta(sessionId: string): SessionMeta | null {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(sessionId), 'meta.json'), 'utf8'));
    } catch { return null; }
  }

  private writeMeta(sessionId: string, meta: SessionMeta): void {
    atomicWrite(join(this.sessionDir(sessionId), 'meta.json'), JSON.stringify(meta, null, 2));
  }

  private readContext(sessionId: string): SessionContext | null {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(sessionId), 'context.json'), 'utf8'));
    } catch { return null; }
  }

  private writeContext(sessionId: string, context: SessionContext): void {
    atomicWrite(join(this.sessionDir(sessionId), 'context.json'), JSON.stringify(context, null, 2));
  }

  private readRun(sessionId: string, runId: string): RunRecord | null {
    try {
      return JSON.parse(readFileSync(join(this.sessionDir(sessionId), 'runs', `${runId}.json`), 'utf8'));
    } catch { return null; }
  }

  private writeRun(sessionId: string, run: RunRecord): void {
    atomicWrite(join(this.sessionDir(sessionId), 'runs', `${run.id}.json`), JSON.stringify(run, null, 2));
  }

  // ── Link table (local session sync) ───────────────────

  private get linkTablePath(): string {
    return join(this.sessionsDir, 'link-table.json');
  }

  private readLinkTable(): SessionLink[] {
    try {
      return JSON.parse(readFileSync(this.linkTablePath, 'utf8'));
    } catch { return []; }
  }

  private writeLinkTable(links: SessionLink[]): void {
    atomicWrite(this.linkTablePath, JSON.stringify(links, null, 2));
  }

  /** Add a link between a local Copilot session and a Kraki session. */
  addLink(link: SessionLink): void {
    const links = this.readLinkTable();
    // Replace existing link for this local session ID
    const idx = links.findIndex(l => l.localSessionId === link.localSessionId);
    if (idx >= 0) links[idx] = link;
    else links.push(link);
    this.writeLinkTable(links);
  }

  /** Remove a link by local session ID. */
  removeLink(localSessionId: string): void {
    const links = this.readLinkTable().filter(l => l.localSessionId !== localSessionId);
    this.writeLinkTable(links);
  }

  /** Remove a link by Kraki session ID (used on session delete). */
  removeLinkByKrakiId(krakiSessionId: string): void {
    const links = this.readLinkTable().filter(l => l.krakiSessionId !== krakiSessionId);
    this.writeLinkTable(links);
  }

  /** Get link for a local session ID. */
  getLink(localSessionId: string): SessionLink | null {
    return this.readLinkTable().find(l => l.localSessionId === localSessionId) ?? null;
  }

  /** Get all linked local session IDs. */
  getLinkedIds(): Set<string> {
    return new Set(this.readLinkTable().map(l => l.localSessionId));
  }

  /** Get all links. */
  getAllLinks(): SessionLink[] {
    return this.readLinkTable();
  }
}

/** Link between a local Copilot session and a Kraki session. */
export interface SessionLink {
  localSessionId: string;
  krakiSessionId: string;
  source: import('@kraki/protocol').LocalSessionSource;
  cwd?: string;
  branch?: string;
  linkedAt: string;
}

/** Atomic write: write to temp file, then rename (prevents corruption on crash). */
function atomicWrite(path: string, data: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
