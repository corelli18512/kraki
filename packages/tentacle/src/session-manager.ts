/**
 * Tentacle session manager.
 *
 * Owns session lifecycle: create, resume, crash recovery, context persistence.
 * The head doesn't know about runs or context — it just sees sessionIds.
 * This is the tentacle's local intelligence layer.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, appendFileSync, openSync, readSync, closeSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config.js';

// ── Types ───────────────────────────────────────────────

/** A single logged message in a session's message log. */
export interface LoggedMessage {
  seq: number;
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
  currentRunId: string;
  totalRuns: number;
  lastSeq: number;
  readSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
}

// ── Session Manager ─────────────────────────────────────

export class SessionManager {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(getConfigDir(), 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
    this.migrateGlobalLog();
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
   * Get all sessions that need resume on restart (active, idle, or disconnected).
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

    meta.lastSeq = seq;
    meta.updatedAt = new Date().toISOString();
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

  /**
   * Update read state for a session (cross-device).
   */
  markRead(sessionId: string, seq: number): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    if (seq > (meta.readSeq ?? 0)) {
      meta.readSeq = seq;
      meta.updatedAt = new Date().toISOString();
      this.writeMeta(sessionId, meta);
    }
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
    lastSeq: number;
    readSeq: number;
    messageCount: number;
    createdAt: string;
  }> {
    const result: ReturnType<SessionManager['getSessionList']> = [];
    if (!existsSync(this.sessionsDir)) return result;

    for (const dir of readdirSync(this.sessionsDir)) {
      const meta = this.readMeta(dir);
      if (!meta) continue;

      const logPath = join(this.sessionDir(dir), 'messages.jsonl');
      let messageCount = 0;
      if (existsSync(logPath)) {
        try {
          const content = readFileSync(logPath, 'utf8');
          messageCount = content.split('\n').filter(l => l.length > 0).length;
        } catch { /* ignore */ }
      }

      // Map 'disconnected' to 'idle' for external consumers
      const state: 'active' | 'idle' = meta.state === 'active' ? 'active' : 'idle';

      result.push({
        id: meta.id,
        agent: meta.agent,
        model: meta.model,
        title: meta.title,
        autoTitle: meta.autoTitle,
        state,
        mode: meta.mode ?? 'discuss',
        lastSeq: meta.lastSeq ?? 0,
        readSeq: meta.readSeq ?? 0,
        messageCount,
        createdAt: meta.createdAt,
      });
    }
    return result;
  }

  // ── File I/O ──────────────────────────────────────────

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
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
}

/** Atomic write: write to temp file, then rename (prevents corruption on crash). */
function atomicWrite(path: string, data: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
