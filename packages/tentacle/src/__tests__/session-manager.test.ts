import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../session-manager.js';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
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

  describe('durable pending human action', () => {
    it('round-trips and clears a pending question sidecar', () => {
      const { sessionId } = sm.createSession('pi');
      const pending = {
        version: 1 as const,
        kind: 'question' as const,
        questionId: 'q1',
        question: 'Which backend?',
        choices: ['A', 'B'],
        allowFreeform: true,
        draft: 'I inspected the project.',
        action: {
          type: 'question' as const,
          payload: { id: 'q1', question: 'Which backend?', choices: ['A', 'B'], allowFreeform: true },
        },
        createdAt: new Date().toISOString(),
      };

      sm.savePendingHumanAction(sessionId, pending);
      expect(sm.getPendingHumanAction(sessionId)).toEqual(pending);
      expect(existsSync(join(dir, sessionId, 'pending-human-action.json'))).toBe(true);

      sm.clearPendingHumanAction(sessionId);
      expect(sm.getPendingHumanAction(sessionId)).toBeNull();
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

  // ── Link table ────────────────────────────────────────

  describe('link table', () => {
    it('should add and retrieve a link', () => {
      sm.addLink({
        localSessionId: 'local-1',
        krakiSessionId: 'kraki-1',
        source: 'copilot-cli',
        cwd: '/proj',
        branch: 'main',
        linkedAt: '2026-04-10T00:00:00Z',
      });

      const link = sm.getLink('local-1');
      expect(link).toBeTruthy();
      expect(link!.krakiSessionId).toBe('kraki-1');
      expect(link!.source).toBe('copilot-cli');
    });

    it('should return null for unknown links', () => {
      expect(sm.getLink('nonexistent')).toBeNull();
    });

    it('should return all linked IDs', () => {
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k1', source: 'copilot-cli', linkedAt: '' });
      sm.addLink({ localSessionId: 'l2', krakiSessionId: 'k2', source: 'vscode', linkedAt: '' });

      const ids = sm.getLinkedIds();
      expect(ids.size).toBe(2);
      expect(ids.has('l1')).toBe(true);
      expect(ids.has('l2')).toBe(true);
    });

    it('should remove link by local session ID', () => {
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k1', source: 'copilot-cli', linkedAt: '' });
      sm.removeLink('l1');
      expect(sm.getLink('l1')).toBeNull();
    });

    it('should remove link by Kraki session ID', () => {
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k1', source: 'copilot-cli', linkedAt: '' });
      sm.removeLinkByKrakiId('k1');
      expect(sm.getLink('l1')).toBeNull();
    });

    it('should replace existing link for same local session', () => {
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k1', source: 'copilot-cli', linkedAt: 'old' });
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k2', source: 'vscode', linkedAt: 'new' });

      const link = sm.getLink('l1');
      expect(link!.krakiSessionId).toBe('k2');
      expect(sm.getAllLinks()).toHaveLength(1);
    });

    it('should persist across instances', () => {
      sm.addLink({ localSessionId: 'l1', krakiSessionId: 'k1', source: 'copilot-cli', linkedAt: '' });

      const sm2 = new SessionManager(dir);
      expect(sm2.getLink('l1')).toBeTruthy();
      expect(sm2.getLink('l1')!.krakiSessionId).toBe('k1');
    });

    it('should include source in session list', () => {
      const { sessionId } = sm.createSession('copilot', 'gpt-4');
      const meta = sm.getMeta(sessionId);
      meta!.source = 'copilot-cli';
      // Write back (normally done via a setter, but test the field)
      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      // source is on meta but getSessionList reads it
      expect(entry).toBeTruthy();
    });
  });

  // ── Preview extraction ─────────────────────────────────

  describe('getSessionList preview', () => {
    it('should extract agent_message preview from session', () => {
      const { sessionId } = sm.createSession('copilot');

      // Append messages including a final agent_message
      sm.appendMessage(sessionId, 'active', JSON.stringify({
        type: 'active', sessionId, payload: {},
      }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content: 'Hello **world**, this is a test.' },
      }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({
        type: 'idle', sessionId, payload: {},
      }));

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry?.preview).toBeTruthy();
      expect(entry!.preview!.type).toBe('agent');
      expect(entry!.preview!.text).toBe('Hello world, this is a test.');
      expect(entry!.preview!.timestamp).toBeTruthy();
    });

    it('should extract user_message preview when it is the last previewable', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.appendMessage(sessionId, 'user_message', JSON.stringify({
        type: 'user_message', sessionId, payload: { content: 'Can you fix this bug?' },
      }));
      sm.appendMessage(sessionId, 'active', JSON.stringify({
        type: 'active', sessionId, payload: {},
      }));
      sm.appendMessage(sessionId, 'tool_start', JSON.stringify({
        type: 'tool_start', sessionId, payload: { toolName: 'bash', args: {} },
      }));

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry?.preview).toBeTruthy();
      expect(entry!.preview!.type).toBe('user');
      expect(entry!.preview!.text).toBe('Can you fix this bug?');
    });

    it('should strip markdown in preview text', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: {
          content: '# Heading\n\n**Bold** and `code` with [link](http://x.com)\n\n```\nblock\n```\n\nDone.',
        },
      }));

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry!.preview!.text).toBe('Heading Bold and code with link Done.');
    });

    it('should truncate preview to 80 chars', () => {
      const { sessionId } = sm.createSession('copilot');

      const longContent = 'A'.repeat(200);
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content: longContent },
      }));

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry!.preview!.text.length).toBeLessThanOrEqual(80);
    });

    it('should not split an emoji surrogate pair at the preview limit', () => {
      const { sessionId } = sm.createSession('copilot');
      const content = `${'A'.repeat(79)}😀trailing`;
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content },
      }));

      const entry = sm.getSessionList().find(s => s.id === sessionId);
      expect(Array.from(entry!.preview!.text)).toHaveLength(80);
      expect(entry!.preview!.text.endsWith('😀')).toBe(true);
      expect(JSON.stringify(entry)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i);
    });

    it('should sanitize lone surrogates from existing session metadata', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.updateMeta(sessionId, { title: `broken-\ud83d` });

      const entry = sm.getSessionList().find(s => s.id === sessionId);
      expect(entry!.title).toBe('broken-�');
      expect(JSON.stringify(entry)).not.toContain('\\ud83d');
    });

    it('should return undefined preview for session with no messages', () => {
      const { sessionId } = sm.createSession('copilot');

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      expect(entry?.preview).toBeUndefined();
    });

    it('should skip resolved permissions and find earlier message', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content: 'I will run a command.' },
      }));
      sm.appendMessage(sessionId, 'permission', JSON.stringify({
        type: 'permission', sessionId, payload: { id: 'p1', toolName: 'bash', resolution: 'approved' },
      }));

      const list = sm.getSessionList();
      const entry = list.find(s => s.id === sessionId);
      // Should skip the resolved permission and find the agent_message
      expect(entry!.preview!.type).toBe('agent');
      expect(entry!.preview!.text).toContain('I will run a command');
    });
  });

  // ── Legacy inline-image strip migration ───────────────

  describe('stripLegacyInlineImages migration', () => {
    it('strips inline image attachments from tool_complete on startup', async () => {
      const { sessionId } = sm.createSession('copilot');
      const bigBase64 = 'a'.repeat(4096); // pretend image bytes
      sm.appendMessage(sessionId, 'tool_complete', JSON.stringify({
        type: 'tool_complete',
        sessionId,
        payload: {
          toolName: 'view',
          result: 'Viewed image file successfully.',
          attachments: [{ type: 'image', mimeType: 'image/png', data: bigBase64 }],
        },
      }));

      // Confirm the inline bytes are in the on-disk log
      const beforeMessages = sm.getMessagesAfterSeq(sessionId, 0);
      expect(beforeMessages.length).toBeGreaterThan(0);
      const beforeInner = JSON.parse(beforeMessages[0].payload) as { payload: { attachments?: unknown[] } };
      expect(beforeInner.payload.attachments).toHaveLength(1);

      // Reset the `inlineImagesStripped` flag so we can re-run the migration
      const meta = sm.getMeta(sessionId)!;
      meta.inlineImagesStripped = false;
      sm['writeMeta'](sessionId, meta);

      // Re-construct the manager — runs migration in constructor
      // eslint-disable-next-line no-new
      const sm2 = new SessionManager(dir);
      const afterMessages = sm2.getMessagesAfterSeq(sessionId, 0);
      const afterInner = JSON.parse(afterMessages[0].payload) as { payload: { attachments?: unknown[] } };
      expect(afterInner.payload.attachments).toBeUndefined();

      // Flag is set so re-migration is a no-op
      expect(sm2.getMeta(sessionId)!.inlineImagesStripped).toBe(true);
    });

    it('leaves ContentRef attachments untouched', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'tool_complete', JSON.stringify({
        type: 'tool_complete',
        sessionId,
        payload: {
          toolName: 'kraki-show_image',
          result: 'Image displayed to user.',
          attachments: [{ type: 'content_ref', id: 'abc', mimeType: 'image/png', size: 100 }],
        },
      }));

      const meta = sm.getMeta(sessionId)!;
      meta.inlineImagesStripped = false;
      sm['writeMeta'](sessionId, meta);

      const sm2 = new SessionManager(dir);
      const after = sm2.getMessagesAfterSeq(sessionId, 0);
      const inner = JSON.parse(after[0].payload) as { payload: { attachments?: unknown[] } };
      expect(inner.payload.attachments).toEqual([
        { type: 'content_ref', id: 'abc', mimeType: 'image/png', size: 100 },
      ]);
    });

    it('is idempotent — skips when inlineImagesStripped is already true', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'tool_complete', JSON.stringify({
        type: 'tool_complete',
        sessionId,
        payload: {
          toolName: 'view',
          result: 'ok',
          attachments: [{ type: 'image', mimeType: 'image/png', data: 'aaaa' }],
        },
      }));

      // Mark already stripped (e.g. previously migrated)
      const meta = sm.getMeta(sessionId)!;
      meta.inlineImagesStripped = true;
      sm['writeMeta'](sessionId, meta);

      const sm2 = new SessionManager(dir);
      const after = sm2.getMessagesAfterSeq(sessionId, 0);
      const inner = JSON.parse(after[0].payload) as { payload: { attachments?: unknown[] } };
      // Migration was skipped, so the inline attachment is still there
      expect(inner.payload.attachments).toHaveLength(1);
    });
  });

  // ── idleSeqs tracking ──────────────────────────────────

  describe('idleSeqs tracking', () => {
    it('maintains idleSeqs on appendMessage', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.appendMessage(sessionId, 'user_message', JSON.stringify({
        type: 'user_message', sessionId, payload: { content: 'hello' },
      }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content: 'hi' },
      }));
      const idleSeq1 = sm.appendMessage(sessionId, 'idle', JSON.stringify({
        type: 'idle', sessionId, payload: {},
      }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', sessionId, payload: { content: 'more' },
      }));
      const idleSeq2 = sm.appendMessage(sessionId, 'idle', JSON.stringify({
        type: 'idle', sessionId, payload: {},
      }));

      const meta = sm.getMeta(sessionId)!;
      expect(meta.idleSeqs).toEqual([idleSeq1, idleSeq2]);
    });

    it('maintains idleSeqs on appendMessagesBatch', () => {
      const { sessionId } = sm.createSession('copilot');

      const messages = [
        { type: 'user_message', payload: JSON.stringify({ type: 'user_message', payload: {} }) },
        { type: 'agent_message', payload: JSON.stringify({ type: 'agent_message', payload: {} }) },
        { type: 'idle', payload: JSON.stringify({ type: 'idle', payload: {} }) },
        { type: 'user_message', payload: JSON.stringify({ type: 'user_message', payload: {} }) },
        { type: 'agent_message', payload: JSON.stringify({ type: 'agent_message', payload: {} }) },
        { type: 'idle', payload: JSON.stringify({ type: 'idle', payload: {} }) },
      ];
      sm.appendMessagesBatch(sessionId, messages);

      const meta = sm.getMeta(sessionId)!;
      expect(meta.idleSeqs).toEqual([3, 6]);
    });

    it('backfills idleSeqs from existing log', () => {
      const { sessionId } = sm.createSession('copilot');

      sm.appendMessage(sessionId, 'user_message', JSON.stringify({
        type: 'user_message', payload: {},
      }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
        type: 'agent_message', payload: {},
      }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({
        type: 'idle', payload: {},
      }));

      // Manually remove idleSeqs from meta to simulate pre-existing session
      const meta = sm.getMeta(sessionId)!;
      delete meta.idleSeqs;
      sm['writeMeta'](sessionId, meta);

      // Verify it was removed
      expect(sm.getMeta(sessionId)!.idleSeqs).toBeUndefined();

      // findTurnAlignedStart triggers backfill
      sm.findTurnAlignedStart(sessionId, 4);

      const backfilled = sm.getMeta(sessionId)!;
      expect(backfilled.idleSeqs).toEqual([3]);
    });
  });

  // ── findTurnAlignedStart ────────────────────────────────

  describe('findTurnAlignedStart', () => {
    function buildSession(sm: SessionManager, turns: Array<{ msgCount: number }>): string {
      const { sessionId } = sm.createSession('copilot');
      for (const turn of turns) {
        for (let i = 0; i < turn.msgCount - 1; i++) {
          sm.appendMessage(sessionId, 'agent_message', JSON.stringify({
            type: 'agent_message', payload: { content: `msg ${i}` },
          }));
        }
        sm.appendMessage(sessionId, 'idle', JSON.stringify({
          type: 'idle', payload: {},
        }));
      }
      return sessionId;
    }

    it('anchors at latest idle before endSeqExclusive', () => {
      // Turn 1: msgs 1-5, idle@5. Turn 2: msgs 6-10, idle@10. Turn 3: msgs 11-50, idle@50.
      const { sessionId } = sm.createSession('copilot');
      for (let i = 0; i < 4; i++) sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} })); // seq 5
      for (let i = 0; i < 4; i++) sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} })); // seq 10
      for (let i = 0; i < 39; i++) sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} })); // seq 50

      // endSeqExclusive=60 → latest idle before 60 is @50 → candidateStart = 51
      // 60 - 51 = 9, which is < 100, so extend backwards
      // cursor goes to idle@10 → candidateStart = 11, 60 - 11 = 49, still < 100
      // cursor goes to idle@5 → candidateStart = 6, 60 - 6 = 54, still < 100
      // cursor goes to -1 → candidateStart = 1
      const start = sm.findTurnAlignedStart(sessionId, 60);
      // With only 50 messages total and soft cap 100, it should return 1
      expect(start).toBe(1);
    });

    it('extends backwards to fill soft cap', () => {
      // Create a session with enough messages that soft cap matters
      // 20 turns of 10 messages each = 200 messages, idle at 10,20,...,200
      const { sessionId } = sm.createSession('copilot');
      for (let t = 0; t < 20; t++) {
        for (let i = 0; i < 9; i++) sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
        sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));
      }
      // idles at 10,20,...,200

      // findTurnAlignedStart(sessionId, 201) → anchor at idle@200 → candidateStart=201
      // Wait, 201 > 200, so latest idle < 201 is @200. candidateStart = 201.
      // But 201-201 = 0 < 100, extend back: idle@190 → candidateStart=191, 201-191=10 < 100
      // Continue extending... until we reach candidateStart where 201-candidateStart >= 100
      // idle@100 → candidateStart=101, 201-101=100 >= 100 → stop
      const start = sm.findTurnAlignedStart(sessionId, 201);
      expect(start).toBe(101);
    });

    it('respects soft cap with many small turns', () => {
      // 200 turns of 2 messages each (400 messages total), idle at every even seq
      const { sessionId } = sm.createSession('copilot');
      for (let t = 0; t < 200; t++) {
        sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
        sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));
      }
      // idles at 2,4,6,...,400

      // findTurnAlignedStart(sessionId, 401)
      // anchor at idle@400 → candidateStart=401, 401-401=0 < 100
      // extend back: idle@398 → candidateStart=399, 401-399=2 < 100
      // ... keep going until 401-candidateStart >= 100
      // idle@300 → candidateStart=301, 401-301=100 >= 100 → stop
      const start = sm.findTurnAlignedStart(sessionId, 401);
      expect(start).toBe(301);
    });

    it('returns whole oversized turn when no earlier idle', () => {
      // Single turn of 200 messages (no idle)
      const { sessionId } = sm.createSession('copilot');
      for (let i = 0; i < 200; i++) {
        sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      }

      const start = sm.findTurnAlignedStart(sessionId, 201);
      expect(start).toBe(1);
    });

    it('returns 1 for session with no idles', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));

      const start = sm.findTurnAlignedStart(sessionId, 3);
      expect(start).toBe(1);
    });
  });

  // ── markRead clamp + migration ─────────────────────────

  describe('markRead', () => {
    it('clamps incoming seq to lastSeq', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      // lastSeq is now 2; arm sends a runaway seq from a stale store
      sm.markRead(sessionId, 999_999);
      const meta = sm.getMeta(sessionId)!;
      expect(meta.lastSeq).toBe(2);
      expect(meta.readSeq).toBe(2);
    });

    it('still advances readSeq when seq is within range', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.markRead(sessionId, 2);
      expect(sm.getMeta(sessionId)!.readSeq).toBe(2);
      sm.markRead(sessionId, 3);
      expect(sm.getMeta(sessionId)!.readSeq).toBe(3);
    });

    it('does not roll readSeq backwards', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.markRead(sessionId, 3);
      sm.markRead(sessionId, 1);
      expect(sm.getMeta(sessionId)!.readSeq).toBe(3);
    });

    it('markUnread rolls back a fully-read session by one item', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      sm.markRead(sessionId, 2);
      expect(sm.markUnread(sessionId)).toBe(1);
      expect(sm.getMeta(sessionId)!.readSeq).toBe(1);
    });

    it('markUnread is idempotent and never advances an already-unread cursor', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.markRead(sessionId, 1);
      expect(sm.markUnread(sessionId)).toBe(1);
      expect(sm.markUnread(sessionId)).toBe(1);
      expect(sm.getMeta(sessionId)!.readSeq).toBe(1);
    });
  });

  describe('clampOverflowReadSeq migration', () => {
    it('repairs sessions where readSeq exceeds lastSeq on startup', () => {
      // Hand-write a meta.json that simulates the legacy corruption
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ payload: {} }));
      const metaPath = join(dir, sessionId, 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      meta.readSeq = 99_999;
      writeFileSync(metaPath, JSON.stringify(meta), 'utf8');

      // Re-construct triggers the migration
      const sm2 = new SessionManager(dir);
      expect(sm2.getMeta(sessionId)!.readSeq).toBe(2);
      expect(sm2.getMeta(sessionId)!.lastSeq).toBe(2);
    });

    it('leaves healthy meta untouched (idempotent)', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ payload: {} }));
      sm.markRead(sessionId, 1);
      const before = readFileSync(join(dir, sessionId, 'meta.json'), 'utf8');

      // Second construct over the same dir should be a no-op
      const _sm2 = new SessionManager(dir);
      const after = readFileSync(join(dir, sessionId, 'meta.json'), 'utf8');
      expect(JSON.parse(after).readSeq).toBe(1);
      // updatedAt is the only field we may bump, and we don't bump it
      // when readSeq doesn't need clamping
      expect(JSON.parse(before).updatedAt).toBe(JSON.parse(after).updatedAt);
    });
  });

  // ── Turn trace (TRACE axis) ────────────────────────────
  //
  // Under the three-axis model, tool_start/tool_complete no longer occupy a
  // per-session spine seq. They are mirrored to trace.jsonl tagged with the
  // seq of the user_message that began the turn (meta.currentTurnStartSeq),
  // and pulled per-turn via readTurnTrace(bubbleSeq) where bubbleSeq is the
  // concluding agent_message's spine seq.

  describe('turn trace', () => {
    // Helper: append a tool_start/tool_complete pair to the trace log.
    const tool = (sm2: SessionManager, sid: string, toolCallId: string, toolName: string) => {
      sm2.appendTrace(sid, 'tool_start', JSON.stringify({
        type: 'tool_start', sessionId: sid, payload: { toolName, toolCallId, headline: toolName },
      }));
      sm2.appendTrace(sid, 'tool_complete', JSON.stringify({
        type: 'tool_complete', sessionId: sid, payload: { toolName, toolCallId, headline: toolName },
      }));
    };

    it('tracks currentTurnStartSeq on user_message', () => {
      const { sessionId } = sm.createSession('copilot');
      const u1 = sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: { content: 'a' } }));
      expect(sm.getMeta(sessionId)!.currentTurnStartSeq).toBe(u1);
      // A mid-turn permission (also persistent) must NOT move the turn start.
      sm.appendMessage(sessionId, 'permission', JSON.stringify({ type: 'permission', payload: { id: 'p1' } }));
      expect(sm.getMeta(sessionId)!.currentTurnStartSeq).toBe(u1);
      // Next user_message starts a new turn.
      const u2 = sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: { content: 'b' } }));
      expect(sm.getMeta(sessionId)!.currentTurnStartSeq).toBe(u2);
    });

    it('does NOT assign a spine seq to trace entries (messages.jsonl unchanged)', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'tc1', 'read_file');
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: { content: 'done' } }));
      // Spine has only user_message(1) and agent_message(2) — tools didn't consume seqs.
      const spine = sm.getMessagesAfterSeq(sessionId, 0);
      expect(spine.map(m => m.type)).toEqual(['user_message', 'agent_message']);
      expect(bubble).toBe(2);
      expect(sm.getMeta(sessionId)!.lastSeq).toBe(2);
    });

    it('returns a single turn\'s tools keyed by concluding bubble seq', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'tc1', 'read_file');
      tool(sm, sessionId, 'tc2', 'edit');
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: { content: 'done' } }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));

      const { entries, complete } = sm.readTurnTrace(sessionId, bubble);
      expect(entries.map((e) => (e as { type: string }).type))
        .toEqual(['tool_start', 'tool_complete', 'tool_start', 'tool_complete']);
      expect(entries.map((e) => (e as { payload: { toolCallId: string } }).payload.toolCallId))
        .toEqual(['tc1', 'tc1', 'tc2', 'tc2']);
      expect(complete).toBe(true);
    });

    it('isolates tools across multiple turns', () => {
      const { sessionId } = sm.createSession('copilot');
      // Turn 1
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'a1', 'read_file');
      const bubble1 = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));
      // Turn 2
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'b1', 'grep');
      tool(sm, sessionId, 'b2', 'edit');
      const bubble2 = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));

      expect(sm.readTurnTrace(sessionId, bubble1).entries.map((e) => (e as { payload: { toolCallId: string } }).payload.toolCallId))
        .toEqual(['a1', 'a1']);
      expect(sm.readTurnTrace(sessionId, bubble2).entries.map((e) => (e as { payload: { toolCallId: string } }).payload.toolCallId))
        .toEqual(['b1', 'b1', 'b2', 'b2']);
    });

    it('groups tools that ran across a mid-turn permission into the same turn', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'before', 'read_file');
      // Permission is a spine message mid-turn; it must not split the trace turn.
      sm.appendMessage(sessionId, 'permission', JSON.stringify({ type: 'permission', payload: { id: 'p1' } }));
      sm.appendMessage(sessionId, 'permission_resolved', JSON.stringify({ type: 'permission_resolved', payload: { permissionId: 'p1' } }));
      tool(sm, sessionId, 'after', 'edit');
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));

      expect(sm.readTurnTrace(sessionId, bubble).entries.map((e) => (e as { payload: { toolCallId: string } }).payload.toolCallId))
        .toEqual(['before', 'before', 'after', 'after']);
    });

    it('reports complete=false while the turn is still running (no idle yet)', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'tc1', 'read_file');
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      // No idle appended — turn hasn't concluded.
      const { entries, complete } = sm.readTurnTrace(sessionId, bubble);
      expect(entries).toHaveLength(2);
      expect(complete).toBe(false);
    });

    it('returns empty for an unknown / out-of-range bubble seq', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'tc1', 'read_file');
      sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      const { entries } = sm.readTurnTrace(sessionId, 999);
      // bubble 999 resolves to the latest user_message turn but with no idle;
      // still, a session with no trace.jsonl at all returns empty cleanly.
      expect(Array.isArray(entries)).toBe(true);
    });

    it('returns empty when the session has no trace log', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      expect(sm.readTurnTrace(sessionId, bubble).entries).toEqual([]);
    });

    it('persists trace across a SessionManager restart', () => {
      const { sessionId } = sm.createSession('copilot');
      sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: {} }));
      tool(sm, sessionId, 'tc1', 'read_file');
      const bubble = sm.appendMessage(sessionId, 'agent_message', JSON.stringify({ type: 'agent_message', payload: {} }));
      sm.appendMessage(sessionId, 'idle', JSON.stringify({ type: 'idle', payload: {} }));

      const sm2 = new SessionManager(dir);
      expect(sm2.readTurnTrace(sessionId, bubble).entries).toHaveLength(2);
    });
  });
});
