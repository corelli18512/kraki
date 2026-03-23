/**
 * Tentacle session manager.
 *
 * Owns session lifecycle: create, resume, crash recovery, context persistence.
 * The head doesn't know about runs or context — it just sees sessionIds.
 * This is the tentacle's local intelligence layer.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config.js';

// ── Types ───────────────────────────────────────────────

export interface SessionContext {
  summary: string;
  keyFiles: string[];
  lastUserMessage: string;
  pendingAction?: string;
  updatedAt: string;
}

export interface SessionMeta {
  id: string;
  agent: string;
  model?: string;
  title?: string;
  state: 'active' | 'idle' | 'disconnected' | 'ended';
  currentRunId: string;
  totalRuns: number;
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
      currentRunId: runId,
      totalRuns: 1,
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
   * Delete a session permanently. Removes all files for this session.
   */
  deleteSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
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
    meta.title = title;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
  }

  /**
   * Get all sessions that were active/disconnected (need resume on restart).
   */
  getResumableSessions(): SessionMeta[] {
    const sessions: SessionMeta[] = [];
    if (!existsSync(this.sessionsDir)) return sessions;

    for (const dir of readdirSync(this.sessionsDir)) {
      const meta = this.readMeta(dir);
      if (meta && (meta.state === 'active' || meta.state === 'disconnected')) {
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
