import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../session-manager.js';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpSessionsDir(): string {
  const dir = join(tmpdir(), `kraki-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('SessionManager', () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = tmpSessionsDir();
    sm = new SessionManager(dir);
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  // ── Create ────────────────────────────────────────────

  describe('create session', () => {
    it('should create session with ID and first run', () => {
      const { sessionId, runId } = sm.createSession('copilot', 'gpt-4');
      expect(sessionId).toMatch(/^sess_/);
      expect(runId).toBe('run_001');
    });

    it('should persist meta to disk', () => {
      const { sessionId } = sm.createSession('copilot');
      const meta = sm.getMeta(sessionId);
      expect(meta).toBeTruthy();
      expect(meta!.agent).toBe('copilot');
      expect(meta!.state).toBe('active');
      expect(meta!.currentRunId).toBe('run_001');
      expect(meta!.totalRuns).toBe(1);
    });

    it('should initialize empty context', () => {
      const { sessionId } = sm.createSession('copilot');
      const ctx = sm.getContext(sessionId);
      expect(ctx).toBeTruthy();
      expect(ctx!.summary).toBe('');
      expect(ctx!.keyFiles).toEqual([]);
      expect(ctx!.lastUserMessage).toBe('');
    });

    it('should create session directory with runs folder', () => {
      const { sessionId } = sm.createSession('copilot');
      expect(existsSync(join(dir, sessionId, 'meta.json'))).toBe(true);
      expect(existsSync(join(dir, sessionId, 'context.json'))).toBe(true);
      expect(existsSync(join(dir, sessionId, 'runs', 'run_001.json'))).toBe(true);
    });
  });

  // ── Context updates ───────────────────────────────────

  describe('context updates', () => {
    it('should update partial context', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.updateContext(sessionId, { lastUserMessage: 'fix the bug' });
      let ctx = sm.getContext(sessionId)!;
      expect(ctx.lastUserMessage).toBe('fix the bug');
      expect(ctx.summary).toBe(''); // unchanged

      sm.updateContext(sessionId, {
        summary: 'Working on auth bug',
        keyFiles: ['src/auth.ts'],
      });
      ctx = sm.getContext(sessionId)!;
      expect(ctx.summary).toBe('Working on auth bug');
      expect(ctx.keyFiles).toEqual(['src/auth.ts']);
      expect(ctx.lastUserMessage).toBe('fix the bug'); // preserved
    });

    it('should set updatedAt on context update', () => {
      const { sessionId } = sm.createSession('copilot');
      const before = sm.getContext(sessionId)!.updatedAt;

      // Small delay to ensure different timestamp
      sm.updateContext(sessionId, { summary: 'new summary' });
      const after = sm.getContext(sessionId)!.updatedAt;
      expect(after >= before).toBe(true);
    });
  });

  // ── Title ─────────────────────────────────────────────

  describe('session title', () => {
    it('should set and persist title', () => {
      const { sessionId } = sm.createSession('copilot');
      expect(sm.getMeta(sessionId)!.title).toBeUndefined();

      sm.setTitle(sessionId, 'Fix auth token refresh');
      expect(sm.getMeta(sessionId)!.title).toBe('Fix auth token refresh');
    });

    it('should set and persist autoTitle', () => {
      const { sessionId } = sm.createSession('copilot');
      expect(sm.getMeta(sessionId)!.autoTitle).toBeUndefined();

      sm.setAutoTitle(sessionId, 'Refactoring auth middleware');
      expect(sm.getMeta(sessionId)!.autoTitle).toBe('Refactoring auth middleware');
    });

    it('should clear manual title with empty string', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.setTitle(sessionId, 'My custom name');
      expect(sm.getMeta(sessionId)!.title).toBe('My custom name');

      sm.setTitle(sessionId, '');
      expect(sm.getMeta(sessionId)!.title).toBeUndefined();
    });

    it('should include autoTitle in session list', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.setAutoTitle(sessionId, 'Working on tests');

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry?.autoTitle).toBe('Working on tests');
    });

    it('should copy autoTitle when forking', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.setAutoTitle(sessionId, 'Original auto title');
      sm.setTitle(sessionId, 'Manual title');

      const forked = sm.forkSession(sessionId)!;
      const forkedMeta = sm.getMeta(forked.sessionId)!;
      expect(forkedMeta.autoTitle).toBe('Original auto title');
      expect(forkedMeta.title).toBe('Fork of Manual title');
    });
  });

  // ── Model ──────────────────────────────────────────────

  describe('session model', () => {
    it('should set and persist model', () => {
      const { sessionId } = sm.createSession('copilot', 'claude-sonnet-4');
      expect(sm.getMeta(sessionId)!.model).toBe('claude-sonnet-4');

      sm.setModel(sessionId, 'claude-opus-4');
      expect(sm.getMeta(sessionId)!.model).toBe('claude-opus-4');
    });

    it('should no-op for non-existent session', () => {
      sm.setModel('sess_nope', 'gpt-5');
      // No throw
    });
  });

  // ── Pin state ────────────────────────────────────────

  describe('session pin', () => {
    it('should set and persist pin state', () => {
      const { sessionId } = sm.createSession('copilot');
      expect(sm.getMeta(sessionId)!.pinned).toBeUndefined();

      sm.setPin(sessionId, true);
      expect(sm.getMeta(sessionId)!.pinned).toBe(true);

      sm.setPin(sessionId, false);
      expect(sm.getMeta(sessionId)!.pinned).toBeUndefined();
    });

    it('should include pinned in session list', () => {
      const { sessionId: s1 } = sm.createSession('copilot');
      const { sessionId: s2 } = sm.createSession('copilot');
      sm.setPin(s1, true);

      const list = sm.getSessionList();
      const entry1 = list.find(s => s.id === s1)!;
      const entry2 = list.find(s => s.id === s2)!;
      expect(entry1.pinned).toBe(true);
      expect(entry2.pinned).toBeUndefined();
    });

    it('should no-op for non-existent session', () => {
      sm.setPin('sess_nope', true);
      // No throw
    });
  });

  // ── End session ───────────────────────────────────────

  describe('end session', () => {
    it('should mark session as ended', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.endSession(sessionId, 'completed');

      const meta = sm.getMeta(sessionId)!;
      expect(meta.state).toBe('ended');
    });

    it('should record end reason on current run', () => {
      const { sessionId, runId } = sm.createSession('copilot');
      sm.endSession(sessionId, 'user_killed');

      // Read run file directly
      const runPath = join(dir, sessionId, 'runs', `${runId}.json`);
      const run = JSON.parse(require('fs').readFileSync(runPath, 'utf8'));
      expect(run.endedAt).toBeTruthy();
      expect(run.endReason).toBe('user_killed');
    });

    it('should not appear in resumable sessions', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.endSession(sessionId, 'completed');
      expect(sm.getResumableSessions()).toHaveLength(0);
    });
  });

  // ── Crash and disconnect ──────────────────────────────

  describe('crash detection', () => {
    it('should mark session as disconnected', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      const meta = sm.getMeta(sessionId)!;
      expect(meta.state).toBe('disconnected');
    });

    it('should appear in resumable sessions', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      const resumable = sm.getResumableSessions();
      expect(resumable).toHaveLength(1);
      expect(resumable[0].id).toBe(sessionId);
      expect(resumable[0].state).toBe('disconnected');
    });

    it('active sessions also appear in resumable (tentacle restart)', () => {
      sm.createSession('copilot');
      sm.createSession('claude');

      // Active sessions = tentacle crashed without marking disconnected
      const resumable = sm.getResumableSessions();
      expect(resumable).toHaveLength(2);
    });
  });

  // ── Resume ────────────────────────────────────────────

  describe('resume session', () => {
    it('should create a new run and return context', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.updateContext(sessionId, {
        summary: 'Was fixing auth bug',
        keyFiles: ['src/auth.ts'],
        lastUserMessage: 'commit the changes',
      });
      sm.markDisconnected(sessionId);

      const result = sm.resumeSession(sessionId);
      expect(result).toBeTruthy();
      expect(result!.runId).toBe('run_002');
      expect(result!.context.summary).toBe('Was fixing auth bug');
      expect(result!.context.keyFiles).toEqual(['src/auth.ts']);
      expect(result!.context.lastUserMessage).toBe('commit the changes');
    });

    it('should update meta with new run', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      sm.resumeSession(sessionId);

      const meta = sm.getMeta(sessionId)!;
      expect(meta.state).toBe('active');
      expect(meta.currentRunId).toBe('run_002');
      expect(meta.totalRuns).toBe(2);
    });

    it('should mark previous run as crashed', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      sm.resumeSession(sessionId);

      const run1Path = join(dir, sessionId, 'runs', 'run_001.json');
      const run1 = JSON.parse(require('fs').readFileSync(run1Path, 'utf8'));
      expect(run1.endedAt).toBeTruthy();
      expect(run1.endReason).toBe('crashed');
    });

    it('should create run file for new run', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      const result = sm.resumeSession(sessionId);

      const run2Path = join(dir, sessionId, 'runs', `${result!.runId}.json`);
      expect(existsSync(run2Path)).toBe(true);
    });

    it('should return null for non-existent session', () => {
      expect(sm.resumeSession('sess_nonexistent')).toBeNull();
    });

    it('should handle resume with empty context', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.markDisconnected(sessionId);

      const result = sm.resumeSession(sessionId);
      expect(result).toBeTruthy();
      expect(result!.context.summary).toBe('');
    });
  });

  // ── Multiple crash/resume cycles ──────────────────────

  describe('multiple crash/resume cycles', () => {
    it('should handle 3 crashes and resumes', () => {
      const { sessionId } = sm.createSession('copilot');

      // Crash 1
      sm.updateContext(sessionId, { summary: 'Round 1' });
      sm.markDisconnected(sessionId);
      const r2 = sm.resumeSession(sessionId)!;
      expect(r2.runId).toBe('run_002');
      expect(r2.context.summary).toBe('Round 1');

      // Crash 2
      sm.updateContext(sessionId, { summary: 'Round 2' });
      sm.markDisconnected(sessionId);
      const r3 = sm.resumeSession(sessionId)!;
      expect(r3.runId).toBe('run_003');
      expect(r3.context.summary).toBe('Round 2');

      // Crash 3
      sm.updateContext(sessionId, { summary: 'Round 3' });
      sm.markDisconnected(sessionId);
      const r4 = sm.resumeSession(sessionId)!;
      expect(r4.runId).toBe('run_004');
      expect(r4.context.summary).toBe('Round 3');

      const meta = sm.getMeta(sessionId)!;
      expect(meta.totalRuns).toBe(4);
      expect(meta.state).toBe('active');

      // All run files should exist
      expect(existsSync(join(dir, sessionId, 'runs', 'run_001.json'))).toBe(true);
      expect(existsSync(join(dir, sessionId, 'runs', 'run_002.json'))).toBe(true);
      expect(existsSync(join(dir, sessionId, 'runs', 'run_003.json'))).toBe(true);
      expect(existsSync(join(dir, sessionId, 'runs', 'run_004.json'))).toBe(true);
    });
  });

  // ── Persistence across SessionManager instances ───────

  describe('persistence across restarts', () => {
    it('should survive SessionManager recreation (simulates tentacle restart)', () => {
      const { sessionId } = sm.createSession('copilot', 'gpt-4');
      sm.updateContext(sessionId, {
        summary: 'Was refactoring the router',
        keyFiles: ['src/router.ts', 'src/router.test.ts'],
        lastUserMessage: 'now add error handling',
        pendingAction: 'modify router.ts',
      });
      sm.setTitle(sessionId, 'Router refactor');

      // Simulate crash: create a new SessionManager from same directory
      const sm2 = new SessionManager(dir);

      // All state should be recoverable
      const meta = sm2.getMeta(sessionId)!;
      expect(meta.agent).toBe('copilot');
      expect(meta.model).toBe('gpt-4');
      expect(meta.title).toBe('Router refactor');
      expect(meta.state).toBe('active');

      const ctx = sm2.getContext(sessionId)!;
      expect(ctx.summary).toBe('Was refactoring the router');
      expect(ctx.keyFiles).toEqual(['src/router.ts', 'src/router.test.ts']);
      expect(ctx.lastUserMessage).toBe('now add error handling');
      expect(ctx.pendingAction).toBe('modify router.ts');

      // Should appear in resumable
      const resumable = sm2.getResumableSessions();
      expect(resumable).toHaveLength(1);

      // Can resume from new instance
      const result = sm2.resumeSession(sessionId)!;
      expect(result.runId).toBe('run_002');
      expect(result.context.summary).toBe('Was refactoring the router');
    });

    it('should handle multiple sessions across restart', () => {
      const s1 = sm.createSession('copilot');
      const s2 = sm.createSession('claude');
      const s3 = sm.createSession('codex');
      sm.endSession(s3.sessionId, 'completed'); // this one is done

      // New manager
      const sm2 = new SessionManager(dir);
      const resumable = sm2.getResumableSessions();

      // Only s1 and s2 should be resumable (s3 is ended)
      expect(resumable).toHaveLength(2);
      const ids = resumable.map(s => s.id).sort();
      expect(ids).toEqual([s1.sessionId, s2.sessionId].sort());
    });
  });

  // ── Edge cases ────────────────────────────────────────

  describe('edge cases', () => {
    it('should return null for non-existent session meta', () => {
      expect(sm.getMeta('sess_nope')).toBeNull();
    });

    it('should return null for non-existent session context', () => {
      expect(sm.getContext('sess_nope')).toBeNull();
    });

    it('should handle endSession for non-existent session', () => {
      // Should not throw
      sm.endSession('sess_nope', 'completed');
    });

    it('should handle markDisconnected for non-existent session', () => {
      sm.markDisconnected('sess_nope');
    });

    it('should handle setTitle for non-existent session', () => {
      sm.setTitle('sess_nope', 'title');
    });

    it('should handle updateContext for non-existent session', () => {
      // Creates context.json even if session dir doesn't exist?
      // No — getConfigDir won't have the session dir. Should not throw.
      sm.updateContext('sess_nope', { summary: 'test' });
    });

    it('should return empty resumable list when no sessions exist', () => {
      expect(sm.getResumableSessions()).toEqual([]);
    });
  });
});
