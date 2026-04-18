import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseEventsFile, parseSessionHistory } from '../history-parser.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tmpDir(): string {
  const dir = join(tmpdir(), `kraki-test-parser-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(type: string, data: Record<string, unknown>, timestamp?: string): string {
  return JSON.stringify({ type, data, timestamp: timestamp ?? '2026-04-10T12:00:00Z' });
}

describe('history-parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true }); } catch {}
  });

  describe('parseEventsFile', () => {
    it('should extract metadata from session.start', () => {
      const events = [
        makeEvent('session.start', {
          sessionId: 'test-123',
          selectedModel: 'claude-opus-4.6-1m',
          context: { cwd: '/Users/test/kraki', gitRoot: '/Users/test/kraki', branch: 'main', repository: 'test/kraki' },
        }),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages, meta } = parseEventsFile(join(dir, 'events.jsonl'));

      expect(meta.model).toBe('claude-opus-4.6-1m');
      expect(meta.cwd).toBe('/Users/test/kraki');
      expect(meta.gitRoot).toBe('/Users/test/kraki');
      expect(meta.branch).toBe('main');
      expect(meta.repository).toBe('test/kraki');
      expect(messages).toHaveLength(0); // session.start doesn't produce a message
    });

    it('should convert user.message to user_message', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('user.message', { content: 'fix the auth bug' }, '2026-04-10T12:01:00Z'),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user_message');
      expect(messages[0].seq).toBe(1);
      const payload = JSON.parse(messages[0].payload);
      expect(payload.content).toBe('fix the auth bug');
    });

    it('should convert assistant.message to agent_message', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('assistant.message', { content: 'I will fix the auth bug.' }, '2026-04-10T12:02:00Z'),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('agent_message');
      const payload = JSON.parse(messages[0].payload);
      expect(payload.content).toBe('I will fix the auth bug.');
    });

    it('should skip empty assistant.message', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('assistant.message', { content: '' }),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));
      expect(messages).toHaveLength(0);
    });

    it('should convert tool events', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('tool.execution_start', {
          toolName: 'bash', toolCallId: 'tc1',
          arguments: { command: 'ls -la' },
        }, '2026-04-10T12:03:00Z'),
        makeEvent('tool.execution_complete', {
          toolName: 'bash', toolCallId: 'tc1', success: true,
          result: { content: 'file1.txt\nfile2.txt' },
        }, '2026-04-10T12:03:01Z'),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));

      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('tool_start');
      const startPayload = JSON.parse(messages[0].payload);
      expect(startPayload.toolName).toBe('bash');
      expect(startPayload.args.command).toBe('ls -la');

      expect(messages[1].type).toBe('tool_complete');
      const completePayload = JSON.parse(messages[1].payload);
      expect(completePayload.toolName).toBe('bash');
      expect(completePayload.result).toBe('file1.txt\nfile2.txt');
      expect(completePayload.success).toBe(true);
    });

    it('should convert assistant.turn_end to idle', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('assistant.turn_end', { turnId: '0' }),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('idle');
    });

    it('should skip hook and subagent events', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        makeEvent('hook.start', { hookId: 'h1' }),
        makeEvent('hook.end', { hookId: 'h1' }),
        makeEvent('subagent.started', { agentId: 'a1' }),
        makeEvent('assistant.message_delta', { content: 'partial' }),
        makeEvent('session.idle', {}),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));
      expect(messages).toHaveLength(0);
    });

    it('should cap at 500 messages and re-number seq', () => {
      const lines = [makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } })];
      for (let i = 0; i < 600; i++) {
        lines.push(makeEvent('user.message', { content: `msg ${i}` }));
      }
      writeFileSync(join(dir, 'events.jsonl'), lines.join('\n'), 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));
      expect(messages).toHaveLength(500);
      expect(messages[0].seq).toBe(1);
      expect(messages[499].seq).toBe(500);
      // Should be the last 500 messages (100-599)
      const firstPayload = JSON.parse(messages[0].payload);
      expect(firstPayload.content).toBe('msg 100');
    });

    it('should handle missing events.jsonl', () => {
      const { messages, meta } = parseEventsFile(join(dir, 'nonexistent.jsonl'));
      expect(messages).toHaveLength(0);
      expect(meta).toEqual({});
    });

    it('should skip corrupt lines', () => {
      const events = [
        makeEvent('session.start', { sessionId: 'test', context: { cwd: '/' } }),
        'this is not json',
        makeEvent('user.message', { content: 'hello' }),
      ].join('\n');
      writeFileSync(join(dir, 'events.jsonl'), events, 'utf8');

      const { messages } = parseEventsFile(join(dir, 'events.jsonl'));
      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('user_message');
    });
  });

  describe('parseSessionHistory', () => {
    it('should parse from session directory', () => {
      const sessionDir = join(dir, 'test-session');
      mkdirSync(sessionDir, { recursive: true });

      const events = [
        makeEvent('session.start', { sessionId: 'test', selectedModel: 'gpt-4', context: { cwd: '/proj' } }),
        makeEvent('user.message', { content: 'hello' }),
        makeEvent('assistant.message', { content: 'hi there' }),
      ].join('\n');
      writeFileSync(join(sessionDir, 'events.jsonl'), events, 'utf8');

      const { messages, meta } = parseSessionHistory(sessionDir);

      expect(meta.model).toBe('gpt-4');
      expect(meta.cwd).toBe('/proj');
      expect(messages).toHaveLength(2);
      expect(messages[0].type).toBe('user_message');
      expect(messages[1].type).toBe('agent_message');
    });
  });
});
