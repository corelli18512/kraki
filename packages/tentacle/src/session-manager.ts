/**
 * Tentacle session manager.
 *
 * Owns session lifecycle: create, resume, crash recovery, context persistence.
 * The head doesn't know about runs or context — it just sees sessionIds.
 * This is the tentacle's local intelligence layer.
 */

import { atomicWriteFile, renameWithRetry } from './fs-retry.js';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { DEFAULT_SESSION_MODE, normalizeSessionMode, toWireSessionMode } from '@kraki/protocol';
import { dirname, join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getConfigDir } from './config.js';
import type { ContentRef } from '@kraki/protocol';
import { InputLedgerStore } from './session/input-ledger.js';
import { SessionLinkTable } from './session/link-table.js';
import { forEachLogLine, lastLoggedSeq, type LogIndex, upgradeLegacyEntry } from './session/log-file.js';
import { readSessionPreview } from './session/preview.js';
import { isSafeId, toWellFormedText } from './session/text.js';
import { readTraceEntries, turnArtifacts } from './session/turn-trace.js';
import type {
  InputLedgerEntry, LoggedMessage, PendingHumanAction, RunRecord, SessionContext, SessionLink,
  SessionListEntry, SessionMeta, SessionMode, TraceLine,
} from './session/types.js';

// Public names of the session modules, unchanged by the split into session/.
export { forEachLogLine, lastLoggedSeq, upgradeLegacyEntry } from './session/log-file.js';
export { isSafeId, toWellFormedText } from './session/text.js';
export type {
  InputLedgerEntry, LoggedMessage, PendingHumanAction, RunRecord, SessionContext, SessionLink,
  SessionListEntry, SessionMeta, SessionMode, TraceLine,
} from './session/types.js';

// ── Session Manager ─────────────────────────────────────

export class SessionManager {
  private sessionsDir: string;
  private inputLedger: InputLedgerStore;
  private linkTable: SessionLinkTable;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(getConfigDir(), 'sessions');
    this.inputLedger = new InputLedgerStore((id) => this.sessionDir(id));
    this.linkTable = new SessionLinkTable(this.sessionsDir);
    mkdirSync(this.sessionsDir, { recursive: true });
    this.migrateGlobalLog();
    this.clampOverflowReadSeq();
    this.resumeForkAttachmentLinks();
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
   * Migrate from global message-log.jsonl (before 2026-03) to per-session
   * message logs. Runs on startup only while the old file exists next to the
   * sessions folder; splits it by sessionId, then deletes it.
   */
  private migrateGlobalLog(): void {
    // dirname, not a '/sessions' regex: that never matched Windows paths.
    const configDir = dirname(this.sessionsDir);
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
  createSession(
    agent: string,
    model?: string,
    sessionId?: string,
    reasoningEffort?: import('@kraki/protocol').ReasoningEffort,
  ): { sessionId: string; runId: string } {
    const id = sessionId ?? `sess_${randomUUID().slice(0, 12)}`;
    const runId = 'run_001';
    const sessionDir = this.sessionDir(id);
    mkdirSync(join(sessionDir, 'runs'), { recursive: true });

    const meta: SessionMeta = {
      id,
      agent,
      model,
      reasoningEffort,
      state: 'active',
      mode: DEFAULT_SESSION_MODE,
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
  resumeSession(sessionId: string, active = true): { runId: string; context: SessionContext } | null {
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

    // Update meta. Loading runtime state for a configuration-only operation
    // (e.g. set_session_model) is not a turn start, so the caller may preserve
    // idle while still creating a fresh process run.
    meta.state = active ? 'active' : 'idle';
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
    if (!isSafeId(sessionId)) return;
    this.inputLedger.inputLedgerCache.delete(sessionId);
    this.cancelledAttachmentLinks.add(sessionId);
    const dir = this.sessionDir(sessionId);
    if (existsSync(dir)) {
      // A fork's attachments may still be linking in the background (up to 16
      // links in flight): one landing mid-delete makes rmdir fail ENOTEMPTY.
      // Retry; the linker stops once it sees the fork is gone.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }

  /**
   * Copy a session's Kraki state into a new session. Fast and bounded: the
   * spine and trace are rewritten to the new id (so every copied row belongs
   * to the fork), and attachments — which can be tens of thousands of files —
   * are linked in the background (`attachmentsFrom` lets reads fall back to
   * the source meanwhile). Agent state is the adapter's job.
   */
  forkSession(sourceSessionId: string): {
    sessionId: string;
    runId: string;
    /** Seqs 1…throughSeq are the source's rows, unchanged except the id. */
    throughSeq: number;
    /** The source was in the middle of a turn when it was copied. */
    sourceWasRunning: boolean;
  } | null {
    const sourceMeta = this.readMeta(sourceSessionId);
    if (!sourceMeta) return null;

    const newId = `${sourceSessionId.split('-')[0]}-${randomUUID().slice(0, 8)}`;
    const runId = 'run_001';
    const srcDir = this.sessionDir(sourceSessionId);
    const newDir = this.sessionDir(newId);
    mkdirSync(join(newDir, 'runs'), { recursive: true });

    const now = new Date().toISOString();
    const throughSeq = sourceMeta.lastSeq ?? 0;
    const srcAttachments = join(srcDir, 'attachments');
    const hasAttachments = existsSync(srcAttachments);
    const meta: SessionMeta = {
      id: newId,
      agent: sourceMeta.agent,
      model: sourceMeta.model,
      reasoningEffort: sourceMeta.reasoningEffort,
      title: this.forkTitle(sourceMeta.title || sourceMeta.autoTitle || this.firstUserText(sourceSessionId) || 'New Session'),
      autoTitle: sourceMeta.autoTitle,
      state: 'active',
      // A fork keeps the source's permission mode: forking a `safe` session
      // must not silently produce one that runs side effects unasked.
      mode: sourceMeta.mode ?? DEFAULT_SESSION_MODE,
      ...(sourceMeta.idleSeqs && { idleSeqs: [...sourceMeta.idleSeqs] }),
      ...(sourceMeta.currentTurnStartSeq !== undefined && { currentTurnStartSeq: sourceMeta.currentTurnStartSeq }),
      currentRunId: runId,
      totalRuns: 1,
      lastSeq: throughSeq,
      readSeq: throughSeq,
      createdAt: now,
      updatedAt: now,
      ...(hasAttachments && { attachmentsFrom: sourceSessionId }),
    };

    // Copied rows carry the source id inside their payloads; rewrite it so
    // apps don't attribute the fork's history to the source.
    const rewrite = (name: string) => {
      const from = join(srcDir, name);
      if (!existsSync(from)) return;
      const content = readFileSync(from, 'utf8');
      writeFileSync(join(newDir, name), content.split(sourceSessionId).join(newId));
    };
    rewrite('messages.jsonl');
    rewrite('trace.jsonl');

    this.writeMeta(newId, meta);
    this.writeRun(newId, { id: runId, startedAt: now });
    const context = this.readContext(sourceSessionId);
    if (context) this.writeContext(newId, { ...context, updatedAt: now });

    if (hasAttachments) void this.linkForkAttachments(newId, sourceSessionId);

    return { sessionId: newId, runId, throughSeq, sourceWasRunning: sourceMeta.state === 'active' };
  }

  /** The first thing the user said, shortened: the name of an untitled
   *  session's fork. */
  private firstUserText(sessionId: string): string | undefined {
    for (const row of this.getMessagesAfterSeq(sessionId, 0, 50)) {
      if (row.type !== 'user_message') continue;
      try {
        const text = (JSON.parse(row.payload) as { payload?: { content?: string } }).payload?.content?.trim();
        if (text) return text.length > 40 ? `${text.slice(0, 40).trimEnd()}…` : text;
      } catch { /* skip */ }
    }
    return undefined;
  }

  /** "Fork of X", then "Fork 2 of X", "Fork 3 of X"… when that name is
   *  taken. The number comes first so a truncated title still shows it. */
  private forkTitle(sourceTitle: string | undefined): string | undefined {
    if (!sourceTitle) return undefined;
    const subject = sourceTitle.replace(/^Fork(?: \d+)? of /, '');
    const taken = new Set<string>();
    let names: string[] = [];
    try { names = readdirSync(this.sessionsDir); } catch { /* none */ }
    for (const name of names) {
      if (!isSafeId(name)) continue;
      const title = this.readMeta(name)?.title;
      if (title) taken.add(title);
    }
    if (!taken.has(`Fork of ${subject}`)) return `Fork of ${subject}`;
    for (let n = 2; ; n++) if (!taken.has(`Fork ${n} of ${subject}`)) return `Fork ${n} of ${subject}`;
  }


  /** Forks deleted while their attachments were being linked. */
  private cancelledAttachmentLinks = new Set<string>();

  /** Forks whose attachments are still being linked (one job per fork). */
  private attachmentLinkJobs = new Map<string, Promise<void>>();

  /**
   * Hard-link (or copy across volumes) the source's attachments into a fork,
   * off the event loop's critical path, then drop `attachmentsFrom`.
   * Attachments are immutable and content-addressed, so linking is safe.
   */
  linkForkAttachments(forkId: string, sourceId: string): Promise<void> {
    const running = this.attachmentLinkJobs.get(forkId);
    if (running) return running;
    const job = (async () => {
      const from = join(this.sessionDir(sourceId), 'attachments');
      const to = join(this.sessionDir(forkId), 'attachments');
      // Stop if the fork was deleted (a failed fork); never recreate it.
      const gone = () => this.cancelledAttachmentLinks.has(forkId) || !existsSync(join(this.sessionDir(forkId), 'meta.json'));
      if (gone()) return;
      await fsp.mkdir(to, { recursive: true });
      let names: string[] = [];
      try { names = await fsp.readdir(from); } catch { /* source gone */ }
      const queue = [...names];
      const worker = async () => {
        for (let name = queue.pop(); name !== undefined && !gone(); name = queue.pop()) {
          const src = join(from, name);
          const dst = join(to, name);
          try { await fsp.link(src, dst); } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
            try { await fsp.copyFile(src, dst); } catch { /* best effort */ }
          }
        }
      };
      await Promise.all(Array.from({ length: 16 }, worker));
      const meta = this.readMeta(forkId);
      if (meta?.attachmentsFrom === sourceId) {
        delete meta.attachmentsFrom;
        this.writeMeta(forkId, meta);
      }
    })().catch(() => { /* retried at the next start */ }).finally(() => {
      this.attachmentLinkJobs.delete(forkId);
      this.cancelledAttachmentLinks.delete(forkId);
    });
    this.attachmentLinkJobs.set(forkId, job);
    return job;
  }

  /** Where to look for a session's attachments that aren't linked yet. */
  attachmentsFallback(sessionId: string): string | undefined {
    if (!isSafeId(sessionId)) return undefined;
    return this.readMeta(sessionId)?.attachmentsFrom;
  }

  /** Resume attachment links a restart interrupted. */
  private resumeForkAttachmentLinks(): void {
    let names: string[] = [];
    try { names = readdirSync(this.sessionsDir); } catch { return; }
    for (const name of names) {
      if (!isSafeId(name)) continue;
      const from = this.readMeta(name)?.attachmentsFrom;
      if (from) void this.linkForkAttachments(name, from);
    }
  }


  /** Sessions whose meta.lastSeq was checked against the log this process. */
  private lastSeqReconciled = new Set<string>();

  /**
   * A row is appended to messages.jsonl before meta.json records its seq. A
   * crash between the two leaves meta one behind the log, and the next append
   * would reuse the seq (apps dedupe by seq, so a message would vanish). Once
   * per session per process, take lastSeq from the log's last row if ahead.
   */
  private reconcileLastSeq(sessionId: string, meta: SessionMeta): void {
    if (this.lastSeqReconciled.has(sessionId)) return;
    this.lastSeqReconciled.add(sessionId);
    const tail = lastLoggedSeq(join(this.sessionDir(sessionId), 'messages.jsonl'));
    if (tail > (meta.lastSeq ?? 0)) {
      meta.lastSeq = tail;
      this.writeMeta(sessionId, meta);
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

  /** Archive or unarchive a session. Returns true when the flag changed. */
  setArchived(sessionId: string, archived: boolean): boolean {
    const meta = this.readMeta(sessionId);
    if (!meta || !!meta.archived === archived) return false;
    meta.archived = archived || undefined;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);
    return true;
  }

  isArchived(sessionId: string): boolean {
    return this.readMeta(sessionId)?.archived === true;
  }

  /**
   * Archive sessions with no new messages for `days` days (F2). Pinned,
   * running and `keep` sessions are left alone. Returns the archived ids.
   */
  autoArchive(days: number, keep: (sessionId: string) => boolean = () => false, now = Date.now()): string[] {
    if (!(days > 0) || !existsSync(this.sessionsDir)) return [];
    const cutoff = now - days * 24 * 3600_000;
    const archived: string[] = [];
    for (const dir of readdirSync(this.sessionsDir)) {
      if (!isSafeId(dir)) continue;
      const meta = this.readMeta(dir);
      if (!meta || meta.archived || meta.pinned || meta.state === 'active') continue;
      if (this.lastActivityMs(dir, meta) >= cutoff || keep(dir)) continue;
      meta.archived = true;
      this.writeMeta(dir, meta);
      archived.push(dir);
    }
    return archived;
  }

  /** Last time a message was written (log mtime), else creation time. */
  private lastActivityMs(sessionId: string, meta: SessionMeta): number {
    try {
      return statSync(join(this.sessionDir(sessionId), 'messages.jsonl')).mtimeMs;
    } catch {
      return Date.parse(meta.createdAt) || 0;
    }
  }

  /**
   * Set session model.
   */
  setModel(
    sessionId: string,
    model: string,
    reasoningEffort?: import('@kraki/protocol').ReasoningEffort,
  ): void {
    const meta = this.readMeta(sessionId);
    if (!meta) return;
    meta.model = model;
    meta.reasoningEffort = reasoningEffort;
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
    renameWithRetry(tmp, path);
  }

  getPendingHumanAction(sessionId: string): PendingHumanAction | null {
    const path = this.pendingActionPath(sessionId);
    if (!existsSync(path)) return null;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as PendingHumanAction;
      if (value?.version !== 2 || value.kind !== 'question' || !value.questionId) return null;
      return value;
    } catch {
      return null;
    }
  }

  clearPendingHumanAction(sessionId: string): void {
    rmSync(this.pendingActionPath(sessionId), { force: true });
  }

  // ── Durable input identity state (session/input-ledger.ts) ──

  getInputLedger(sessionId: string): InputLedgerEntry[] {
    return this.inputLedger.getInputLedger(sessionId);
  }

  getInputLedgerEntry(sessionId: string, clientId: string): InputLedgerEntry | null {
    return this.inputLedger.getInputLedgerEntry(sessionId, clientId);
  }

  recordInputLedger(sessionId: string, entry: InputLedgerEntry): void {
    this.inputLedger.recordInputLedger(sessionId, entry);
  }

  findUserMessageSeqByClientId(sessionId: string, clientId: string): number | null {
    return this.inputLedger.findUserMessageSeqByClientId(sessionId, clientId);
  }

  markInputLedgerSettled(sessionId: string, turnId: string): void {
    this.inputLedger.markInputLedgerSettled(sessionId, turnId);
  }

  // ── Message log ────────────────────────────────────────

  /**
   * Append a message to a session's log. Assigns the next per-session seq.
   * Returns the assigned seq number.
   */
  appendMessage(sessionId: string, type: string, payload: string, createsUnread = false): number {
    const meta = this.readMeta(sessionId);
    if (!meta) return 0;
    this.reconcileLastSeq(sessionId, meta);

    const previousLastSeq = meta.lastSeq ?? 0;
    const wasRead = (meta.readSeq ?? 0) >= previousLastSeq;
    const seq = previousLastSeq + 1;
    const entry: LoggedMessage = { seq, type, payload, ts: new Date().toISOString() };
    const line = JSON.stringify(entry) + '\n';
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    appendFileSync(logPath, line, 'utf8');

    if (type === 'idle') {
      if (!meta.idleSeqs) meta.idleSeqs = [];
      meta.idleSeqs.push(seq);
    }

    // A normal user_message begins a new turn — remember its seq so trace
    // entries recorded until the next normal prompt can be tagged to this turn.
    // A steer is a visible user interjection inside the current agent lifecycle
    // and must not split its TRACE history.
    if (type === 'user_message') {
      try {
        const parsed = JSON.parse(payload) as { payload?: { delivery?: string } };
        if (parsed.payload?.delivery !== 'steer') meta.currentTurnStartSeq = seq;
      } catch {
        // Legacy/corrupt payloads retain the historical boundary behavior.
        meta.currentTurnStartSeq = seq;
      }
    }

    meta.lastSeq = seq;
    // Preserve the existing two-cursor contract. Ordinary Spine bookkeeping
    // must not create a badge when the session was fully read; a genuine
    // attention boundary advances only lastSeq and intentionally leaves a gap.
    // Once a gap exists, later ordinary entries must not clear it.
    if (wasRead && !createsUnread) meta.readSeq = seq;
    meta.updatedAt = new Date().toISOString();
    this.writeMeta(sessionId, meta);

    return seq;
  }

  /**
   * Batch-append messages to a session's log in a single write.
   * Much faster than calling appendMessage() N times.
   * Returns the final seq number.
   */
  appendMessagesBatch(
    sessionId: string,
    messages: Array<{ type: string; payload: string; ts?: string }>,
    markAppendedRead = false,
  ): number {
    const meta = this.readMeta(sessionId);
    if (!meta || messages.length === 0) return meta?.lastSeq ?? 0;
    this.reconcileLastSeq(sessionId, meta);

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
        try {
          const parsed = JSON.parse(messages[i].payload) as { payload?: { delivery?: string } };
          if (parsed.payload?.delivery !== 'steer') {
            meta.currentTurnStartSeq = seq - messages.length + i + 1;
          }
        } catch {
          meta.currentTurnStartSeq = seq - messages.length + i + 1;
        }
      }
    }

    meta.lastSeq = seq;
    // Imported/backfilled history is pre-existing content, not a new result.
    // Its caller opts into marking the whole appended range read.
    if (markAppendedRead) meta.readSeq = seq;
    meta.updatedAt = now;
    this.writeMeta(sessionId, meta);

    return seq;
  }

  /**
   * Get messages for a session with seq > afterSeq.
   *
   * Reads only from the first matching row onward, located through a
   * per-session seq→byte-offset index: logs carry inline images (rows can be
   * megabytes), so re-reading and parsing whole files per page stalled the
   * daemon. Files whose seqs are not ascending fall back to a full scan.
   */
  getMessagesAfterSeq(sessionId: string, afterSeq: number, limit?: number): LoggedMessage[] {
    const logPath = join(this.sessionDir(sessionId), 'messages.jsonl');
    if (!existsSync(logPath)) return [];
    const index = this.logIndexFor(sessionId, logPath);
    if (!index) return [];

    let start = 0;
    if (index.ascending) {
      // First row with seq > afterSeq.
      let lo = 0, hi = index.seqs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (index.seqs[mid] > afterSeq) hi = mid; else lo = mid + 1;
      }
      if (lo >= index.seqs.length) return [];
      start = index.offsets[lo];
    }

    const messages: LoggedMessage[] = [];
    forEachLogLine(logPath, start, index.size, (line) => {
      try {
        const msg = JSON.parse(line) as LoggedMessage;
        if (msg.seq > afterSeq) {
          messages.push(upgradeLegacyEntry(msg, sessionId));
          if (limit && messages.length >= limit) return false;
        }
      } catch {
        // Skip corrupted lines
      }
      return true;
    });
    return messages;
  }

  /** Per-session index of messages.jsonl rows (seq and byte offset). */
  private logIndexes = new Map<string, LogIndex>();

  private logIndexFor(sessionId: string, logPath: string): LogIndex | null {
    let st;
    try { st = statSync(logPath); } catch { return null; }
    let index = this.logIndexes.get(sessionId);
    // Rewritten (atomic rename → new inode) or truncated: start over.
    if (!index || index.ino !== st.ino || st.size < index.size) {
      index = { ino: st.ino, size: 0, seqs: [], offsets: [], ascending: true };
      this.logIndexes.set(sessionId, index);
    }
    if (st.size > index.size) {
      const target = index;
      let lastSeq = target.seqs.length > 0 ? target.seqs[target.seqs.length - 1] : -Infinity;
      // Index only complete lines; a torn tail is picked up once finished.
      const indexedTo = forEachLogLine(logPath, target.size, st.size, (line, offset) => {
        const m = /^\{"seq":(\d+)/.exec(line);
        let seq: number | undefined = m ? Number(m[1]) : undefined;
        if (seq === undefined) {
          try { seq = (JSON.parse(line) as { seq?: number }).seq; } catch { /* corrupt row */ }
        }
        if (typeof seq !== 'number') return true;
        if (seq <= lastSeq) target.ascending = false;
        lastSeq = seq;
        target.seqs.push(seq);
        target.offsets.push(offset);
        return true;
      });
      target.size = indexedTo;
    }
    return index;
  }

  // ── Turn trace (TRACE axis) ─────────────────────────────

  /**
   * Mirror an off-spine tool/action record to the session's `trace.jsonl`.
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

    // Resolve the turn start: greatest non-steer user_message seq <= bubbleSeq.
    let turnStartSeq = 0;
    for (const m of this.getMessagesAfterSeq(sessionId, 0)) {
      if (m.type !== 'user_message' || m.seq > bubbleSeq || m.seq <= turnStartSeq) continue;
      try {
        const parsed = JSON.parse(m.payload) as { payload?: { delivery?: string } };
        if (parsed.payload?.delivery === 'steer') continue;
      } catch {
        // Legacy/corrupt payloads retain the historical boundary behavior.
      }
      turnStartSeq = m.seq;
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
    return turnArtifacts(entries);
  }

  private readTraceEntriesForTurnStart(sessionId: string, turnStartSeq: number): unknown[] {
    if (turnStartSeq <= 0) return [];
    return readTraceEntries(join(this.sessionDir(sessionId), 'trace.jsonl'), turnStartSeq);
  }

  /**
   * Update read state for a session (cross-device).
   */
  markRead(sessionId: string, seq: number): number | null {
    const meta = this.readMeta(sessionId);
    if (!meta) return null;
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
    return meta.readSeq ?? 0;
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
   * Digests for session_list sync. Archived sessions are left out unless
   * `archived: true` asks for only them (F2). Digests are cached per session
   * and rebuilt only when its meta or message log changes, so a session list
   * no longer re-reads every session's history each time.
   */
  getSessionList(opts: { archived?: boolean; all?: boolean } = {}): SessionListEntry[] {
    const result: SessionListEntry[] = [];
    if (!existsSync(this.sessionsDir)) return result;
    const seen = new Set<string>();

    for (const dir of readdirSync(this.sessionsDir)) {
      if (!isSafeId(dir)) continue;
      const stamp = this.digestStamp(dir);
      if (!stamp) continue;
      seen.add(dir);
      let cached = this.digestCache.get(dir);
      if (!cached || cached.stamp !== stamp) {
        const meta = this.readMeta(dir);
        if (!meta) { this.digestCache.delete(dir); continue; }
        cached = { stamp, archived: meta.archived === true, entry: this.buildDigest(meta) };
        this.digestCache.set(dir, cached);
      }
      if (!opts.all && cached.archived !== (opts.archived === true)) continue;
      result.push(opts.archived ? { ...cached.entry, archived: true } : cached.entry);
    }
    for (const id of this.digestCache.keys()) if (!seen.has(id)) this.digestCache.delete(id);
    return result;
  }

  /** Number of archived sessions (cheap after a getSessionList call). */
  countArchived(): number {
    return this.getSessionList({ archived: true }).length;
  }

  private digestCache = new Map<string, { stamp: string; archived: boolean; entry: SessionListEntry }>();

  private digestStamp(sessionId: string): string | null {
    const dir = join(this.sessionsDir, sessionId);
    try {
      const meta = statSync(join(dir, 'meta.json'));
      let log = '0:0';
      try {
        const st = statSync(join(dir, 'messages.jsonl'));
        log = `${st.mtimeMs}:${st.size}`;
      } catch { /* no messages yet */ }
      return `${meta.ino}:${meta.mtimeMs}:${meta.size}:${log}`;
    } catch {
      return null;
    }
  }

  private buildDigest(meta: SessionMeta): SessionListEntry {
    // Map 'disconnected' to 'idle' for external consumers
    const state: 'active' | 'idle' = meta.state === 'active' ? 'active' : 'idle';
    const preview = this.getSessionPreview(meta.id);
    return {
      id: meta.id,
      agent: meta.agent,
      model: meta.model ? toWellFormedText(meta.model) : undefined,
      reasoningEffort: meta.reasoningEffort,
      title: meta.title ? toWellFormedText(meta.title) : undefined,
      autoTitle: meta.autoTitle ? toWellFormedText(meta.autoTitle) : undefined,
      state,
      mode: toWireSessionMode(meta.mode),
      pinned: meta.pinned || undefined,
      lastSeq: meta.lastSeq ?? 0,
      readSeq: meta.readSeq ?? 0,
      messageCount: meta.lastSeq ?? 0,
      createdAt: meta.createdAt,
      lastActivityAt: new Date(this.lastActivityMs(meta.id, meta)).toISOString(),
      usage: meta.usage,
      source: meta.source,
      preview: preview ? { ...preview, text: toWellFormedText(preview.text) } : undefined,
    };
  }

  // ── File I/O ──────────────────────────────────────────

  private sessionDir(sessionId: string): string {
    if (!isSafeId(sessionId)) throw new Error(`Invalid session id: ${JSON.stringify(sessionId).slice(0, 80)}`);
    return join(this.sessionsDir, sessionId);
  }

  /** The sidebar preview (session/preview.ts). */
  private getSessionPreview(sessionId: string): import('@kraki/protocol').SessionPreviewDigest | undefined {
    return readSessionPreview(sessionId, join(this.sessionDir(sessionId), 'messages.jsonl'));
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

  /**
   * meta.json is read dozens of times per message and rewritten on every
   * spine append. Keep the parsed copy in memory, revalidated by the file's
   * inode, mtime and size (another process, e.g. a CLI command, may write it), and
   * hand out clones so a caller's unsaved edits never leak into the cache.
   */
  private metaCache = new Map<string, { ino: number; mtimeMs: number; size: number; meta: SessionMeta }>();

  private readMeta(sessionId: string): SessionMeta | null {
    const path = join(this.sessionDir(sessionId), 'meta.json');
    let st;
    try { st = statSync(path); } catch {
      this.metaCache.delete(sessionId);
      return null;
    }
    const cached = this.metaCache.get(sessionId);
    if (cached && cached.ino === st.ino && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return structuredClone(cached.meta);
    try {
      const meta = JSON.parse(readFileSync(path, 'utf8')) as SessionMeta;
      // Normalize legacy wire names (`execute`) and unknown values.
      // Rewritten on the next save; nothing else on disk needs migrating.
      meta.mode = normalizeSessionMode(meta.mode);
      this.metaCache.set(sessionId, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, meta: structuredClone(meta) });
      return meta;
    } catch {
      this.metaCache.delete(sessionId);
      return null;
    }
  }

  private writeMeta(sessionId: string, meta: SessionMeta): void {
    const path = join(this.sessionDir(sessionId), 'meta.json');
    atomicWrite(path, JSON.stringify(meta));
    try {
      const st = statSync(path);
      this.metaCache.set(sessionId, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, meta: structuredClone(meta) });
    } catch {
      this.metaCache.delete(sessionId);
    }
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

  // ── Link table (local session sync, session/link-table.ts) ──

  /** Add a link between a local Copilot session and a Kraki session. */
  addLink(link: SessionLink): void {
    this.linkTable.addLink(link);
  }

  /** Remove a link by local session ID. */
  removeLink(localSessionId: string): void {
    this.linkTable.removeLink(localSessionId);
  }

  /** Remove a link by Kraki session ID (used on session delete). */
  removeLinkByKrakiId(krakiSessionId: string): void {
    this.linkTable.removeLinkByKrakiId(krakiSessionId);
  }

  /** Get link for a local session ID. */
  getLink(localSessionId: string): SessionLink | null {
    return this.linkTable.getLink(localSessionId);
  }

  /** Get all linked local session IDs. */
  getLinkedIds(): Set<string> {
    return this.linkTable.getLinkedIds();
  }

  /** Get all links. */
  getAllLinks(): SessionLink[] {
    return this.linkTable.getAllLinks();
  }
}

/** Atomic write: write to temp file, then rename (prevents corruption on crash). */
function atomicWrite(path: string, data: string): void {
  atomicWriteFile(path, data);
}
