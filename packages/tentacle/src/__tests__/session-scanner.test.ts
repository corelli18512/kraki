import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanLocalSessions, filterSessions } from '../session-scanner.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpDir(): string {
  const dir = join(tmpdir(), `kraki-test-scanner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createFakeSession(baseDir: string, id: string, workspace: Record<string, string>): void {
  const sessionDir = join(baseDir, id);
  mkdirSync(sessionDir, { recursive: true });

  const lines = Object.entries(workspace).map(([k, v]) => `${k}: ${v}`).join('\n');
  writeFileSync(join(sessionDir, 'workspace.yaml'), lines, 'utf8');

  // Minimal events.jsonl
  const startEvent = JSON.stringify({
    type: 'session.start',
    data: { sessionId: id, selectedModel: workspace.model ?? null, context: { cwd: workspace.cwd ?? '/' } },
    timestamp: workspace.created_at ?? new Date().toISOString(),
  });
  writeFileSync(join(sessionDir, 'events.jsonl'), startEvent + '\n', 'utf8');
}

describe('session-scanner', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  describe('scanLocalSessions', () => {
    it('should discover sessions from workspace.yaml files', () => {
      createFakeSession(dir, 'sess-1', {
        id: 'sess-1',
        cwd: '/Users/test/project',
        git_root: '/Users/test/project',
        repository: 'test/project',
        branch: 'main',
        summary: 'Fix auth bug',
        created_at: '2026-04-01T00:00:00Z',
        updated_at: '2026-04-02T00:00:00Z',
      });
      createFakeSession(dir, 'sess-2', {
        id: 'sess-2',
        cwd: '/Users/test/other',
        created_at: '2026-04-03T00:00:00Z',
        updated_at: '2026-04-04T00:00:00Z',
      });

      const sessions = scanLocalSessions({ extraDirs: [dir] });
      // Filter to only our test sessions (real ~/.copilot may have sessions too)
      const ours = sessions.filter(s => s.sessionId.startsWith('sess-'));

      expect(ours).toHaveLength(2);
      // Sorted by modifiedTime desc
      expect(ours[0].sessionId).toBe('sess-2');
      expect(ours[1].sessionId).toBe('sess-1');
    });

    it('should parse workspace.yaml fields correctly', () => {
      createFakeSession(dir, 'sess-full', {
        id: 'sess-full',
        cwd: '/Users/test/kraki',
        git_root: '/Users/test/kraki',
        repository: 'corelli18512/kraki',
        branch: 'feat/sync',
        summary: 'Local session sync',
        created_at: '2026-04-10T12:00:00Z',
        updated_at: '2026-04-10T14:00:00Z',
      });

      const sessions = scanLocalSessions({ extraDirs: [dir] });
      const s = sessions.find(s => s.sessionId === 'sess-full');

      expect(s).toBeTruthy();
      expect(s!.cwd).toBe('/Users/test/kraki');
      expect(s!.gitRoot).toBe('/Users/test/kraki');
      expect(s!.repository).toBe('corelli18512/kraki');
      expect(s!.branch).toBe('feat/sync');
      expect(s!.summary).toBe('Local session sync');
      expect(s!.startTime).toBe('2026-04-10T12:00:00Z');
      expect(s!.modifiedTime).toBe('2026-04-10T14:00:00Z');
      expect(s!.isLive).toBe(false); // no lock file
      expect(s!.source).toBe('copilot-cli');
    });

    it('should detect vscode source from non-empty metadata', () => {
      createFakeSession(dir, 'sess-vscode', {
        id: 'sess-vscode',
        cwd: '/Users/test/project',
        created_at: '2026-04-10T00:00:00Z',
        updated_at: '2026-04-10T00:00:00Z',
      });
      writeFileSync(join(dir, 'sess-vscode', 'vscode.metadata.json'), '{"version": "1.0"}', 'utf8');

      const sessions = scanLocalSessions({ extraDirs: [dir] });
      const s = sessions.find(s => s.sessionId === 'sess-vscode');

      expect(s!.source).toBe('vscode');
    });

    it('should detect live sessions from lock files with live PIDs', () => {
      createFakeSession(dir, 'sess-live', {
        id: 'sess-live',
        cwd: '/Users/test/project',
        created_at: '2026-04-10T00:00:00Z',
        updated_at: '2026-04-10T00:00:00Z',
      });
      // Use current PID (guaranteed alive)
      writeFileSync(join(dir, 'sess-live', `inuse.${process.pid}.lock`), String(process.pid), 'utf8');

      const sessions = scanLocalSessions({ extraDirs: [dir] });
      const s = sessions.find(s => s.sessionId === 'sess-live');

      expect(s!.isLive).toBe(true);
    });

    it('should detect dead sessions from stale lock files', () => {
      createFakeSession(dir, 'sess-dead', {
        id: 'sess-dead',
        cwd: '/Users/test/project',
        created_at: '2026-04-10T00:00:00Z',
        updated_at: '2026-04-10T00:00:00Z',
      });
      // Use a PID that's very unlikely to be alive
      writeFileSync(join(dir, 'sess-dead', 'inuse.99999999.lock'), '99999999', 'utf8');

      const sessions = scanLocalSessions({ extraDirs: [dir] });
      const s = sessions.find(s => s.sessionId === 'sess-dead');

      expect(s!.isLive).toBe(false);
    });

    it('should extract model from events.jsonl when includeModel is true', () => {
      createFakeSession(dir, 'sess-model', {
        id: 'sess-model',
        cwd: '/Users/test/project',
        model: 'claude-opus-4.6-1m',
        created_at: '2026-04-10T00:00:00Z',
        updated_at: '2026-04-10T00:00:00Z',
      });

      const sessions = scanLocalSessions({ extraDirs: [dir], includeModel: true });
      const s = sessions.find(s => s.sessionId === 'sess-model');

      expect(s!.model).toBe('claude-opus-4.6-1m');
    });

    it('should skip directories without workspace.yaml', () => {
      mkdirSync(join(dir, 'empty-dir'), { recursive: true });
      const sessions = scanLocalSessions({ extraDirs: [dir] });
      const s = sessions.find(s => s.sessionId === 'empty-dir');
      expect(s).toBeUndefined();
    });
  });

  describe('filterSessions', () => {
    const sessions = [
      { sessionId: 's1', cwd: '/proj/kraki', gitRoot: '/proj/kraki', branch: 'main', summary: 'Fix auth', isLive: true, source: 'copilot-cli' as const, startTime: '', modifiedTime: '' },
      { sessionId: 's2', cwd: '/proj/hermit', gitRoot: '/proj/hermit', branch: 'main', summary: 'Add tests', isLive: false, source: 'copilot-cli' as const, startTime: '', modifiedTime: '' },
      { sessionId: 's3', cwd: '/home', summary: 'Random task', isLive: false, source: 'vscode' as const, startTime: '', modifiedTime: '' },
    ];

    it('should filter by search substring', () => {
      const result = filterSessions(sessions, { search: 'kraki' }, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('s1');
    });

    it('should filter by liveOnly', () => {
      const result = filterSessions(sessions, { liveOnly: true }, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('s1');
    });

    it('should exclude linked sessions by default', () => {
      const linked = new Set(['s1']);
      const result = filterSessions(sessions, {}, linked);
      expect(result).toHaveLength(2);
      expect(result.map(s => s.sessionId)).toEqual(['s2', 's3']);
    });

    it('should include linked sessions when includeLinked is true', () => {
      const linked = new Set(['s1']);
      const result = filterSessions(sessions, { includeLinked: true }, linked);
      expect(result).toHaveLength(3);
    });

    it('should combine filters with AND', () => {
      const result = filterSessions(sessions, { search: 'main', liveOnly: true }, new Set());
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('s1');
    });
  });
});
