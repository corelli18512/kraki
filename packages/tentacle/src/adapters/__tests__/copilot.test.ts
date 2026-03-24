/**
 * Unit tests for CopilotAdapter.
 *
 * These tests mock the @github/copilot-sdk so they run fast
 * without needing the Copilot CLI installed. They verify:
 *  - Adapter lifecycle (start/stop)
 *  - Session creation and config forwarding
 *  - Event wiring (SDK events → adapter callbacks)
 *  - Permission blocking/resolution flow
 *  - Question blocking/resolution flow
 *  - Kill session cleanup
 *  - Error guards (not started, unknown session, unknown permission)
 *  - parsePermission field extraction for all known kinds
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// Mock the logger so tests don't emit log output
vi.mock('../../logger.js', () => {
  const noop = () => {};
  return {
    createLogger: () => ({
      info: noop,
      debug: noop,
      warn: noop,
      error: noop,
      fatal: noop,
      trace: noop,
      child: () => ({ info: noop, debug: noop, warn: noop, error: noop, fatal: noop, trace: noop }),
    }),
  };
});

// ── Mock the SDK ────────────────────────────────────────

// We build a fake CopilotClient that records calls and lets
// us simulate SDK events via the session's `.on()` listeners.

function createMockSession(sessionId: string) {
  const listeners = new Map<string, Function[]>();
  return {
    sessionId,
    send: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    getMessages: vi.fn().mockResolvedValue([]),
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    }),
    // Test helper: fire a fake SDK event
    _emit(event: string, data: any) {
      for (const fn of listeners.get(event) ?? []) fn(data);
    },
    _listeners: listeners,
  };
}

type MockSession = ReturnType<typeof createMockSession>;

let mockSessions: MockSession[];
let capturedSessionConfigs: any[];
let capturedResumeConfigs: any[];
let capturedClientOptions: any[];
let mockListSessions: Mock;
let mockResumeSessionError: Error | null;
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
let mockRegisterHooks: Mock | undefined;
let mockRegister: Mock | undefined;

vi.mock('@github/copilot-sdk', () => {
  return {
    CopilotClient: vi.fn().mockImplementation((options: any) => {
      capturedClientOptions.push(options);
      return {
        start: vi.fn(),
        stop: vi.fn(),
        createSession: vi.fn().mockImplementation(async (config: any) => {
          capturedSessionConfigs.push(config);
          const session = createMockSession(`mock-sess-${mockSessions.length + 1}`);
          mockSessions.push(session);
          return session;
        }),
        resumeSession: vi.fn().mockImplementation(async (sessionId: string, config: any) => {
          capturedResumeConfigs.push({ sessionId, config });
          if (mockResumeSessionError) {
            throw mockResumeSessionError;
          }
          const session = createMockSession(sessionId);
          mockSessions.push(session);
          return session;
        }),
        listSessions: mockListSessions,
      };
    }),
  };
});

vi.mock('node:fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
}));

vi.mock('node:module', () => ({
  get registerHooks() {
    return mockRegisterHooks;
  },
  get register() {
    return mockRegister;
  },
}));

// Mock execSync so we don't actually call `gh auth token`
import { execSync as realExecSync } from 'node:child_process';
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('fake-gh-token\n'),
}));
const mockedExecSync = realExecSync as unknown as Mock;

// ── Import after mocking ────────────────────────────────

import { CopilotAdapter, AgentAdapter } from '../index.js';
import {
  installCopilotSdkImportCompatibility,
  patchCopilotSdkSessionImport,
  resolveCopilotCliPath,
  resolveCopilotSdkSessionPath,
} from '../copilot.js';

// ── Tests ───────────────────────────────────────────────

describe('CopilotAdapter', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    mockSessions = [];
    capturedSessionConfigs = [];
    capturedResumeConfigs = [];
    capturedClientOptions = [];
    mockListSessions = vi.fn().mockResolvedValue([]);
    mockResumeSessionError = null;
    mockRegisterHooks = vi.fn();
    mockRegister = vi.fn();
    mockExistsSync.mockImplementation(
      (path: string) =>
        path === '/tmp/repo/node_modules/@github/copilot-sdk/dist/session.js' ||
        path === '/opt/homebrew/bin/copilot',
    );
    mockReadFileSync.mockReturnValue('import "vscode-jsonrpc/node.js";\n');
    mockWriteFileSync.mockReset();
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes('gh auth token')) {
        return 'fake-gh-token\n';
      }
      if (command.includes('command -v copilot') || command.includes('where.exe copilot')) {
        return '/opt/homebrew/bin/copilot\n';
      }
      return '';
    });
    adapter = new CopilotAdapter();
  });

  // ── Exports & inheritance ────────────────────────────

  describe('exports and inheritance', () => {
    it('CopilotAdapter extends AgentAdapter', () => {
      expect(adapter).toBeInstanceOf(AgentAdapter);
    });
  });

  // ── Lifecycle ───────────────────────────────────────

  describe('lifecycle', () => {
    it('start() creates and starts a CopilotClient', async () => {
      await adapter.start();
      // No error = success (CopilotClient constructor + start were called)
    });

    it('start() passes the resolved Copilot CLI path to the SDK', async () => {
      await adapter.start();

      expect(capturedClientOptions[0]).toEqual(
        expect.objectContaining({
          useLoggedInUser: false,
          githubToken: 'fake-gh-token',
          cliPath: '/opt/homebrew/bin/copilot',
        }),
      );
    });

    it('patches the SDK import when the installed session file is incompatible', () => {
      mockReadFileSync.mockReturnValue('import { x } from "vscode-jsonrpc/node";\n');

      expect(patchCopilotSdkSessionImport('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts')).toBe(true);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/repo/node_modules/@github/copilot-sdk/dist/session.js',
        'import { x } from "vscode-jsonrpc/node.js";\n',
        'utf8',
      );
    });

    it('stop() clears client and sessions', async () => {
      await adapter.start();
      await adapter.createSession({ model: 'gpt-5' });
      await adapter.stop();
      // After stop, listSessions should return empty
      const sessions = await adapter.listSessions();
      expect(sessions).toEqual([]);
    });

    it('stop() is safe to call without start', async () => {
      await adapter.stop(); // should not throw
    });
  });

  describe('patchCopilotSdkSessionImport', () => {
    it('returns false when no patch is needed', () => {
      mockReadFileSync.mockReturnValue('import "vscode-jsonrpc/node.js";\n');

      expect(patchCopilotSdkSessionImport('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts')).toBe(false);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('installCopilotSdkImportCompatibility', () => {
    it('uses registerHooks when available', () => {
      expect(installCopilotSdkImportCompatibility('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts'))
        .toBe('hook');
      expect(mockRegisterHooks).toHaveBeenCalledTimes(1);
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('falls back to module.register when sync hooks are unavailable', () => {
      mockRegisterHooks = undefined;

      expect(installCopilotSdkImportCompatibility('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts'))
        .toBe('hook');
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^data:text\/javascript,/),
        'file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts',
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('falls back to patching when module hooks are unavailable', () => {
      mockRegisterHooks = undefined;
      mockRegister = undefined;
      mockReadFileSync.mockReturnValue('import { x } from "vscode-jsonrpc/node";\n');

      expect(installCopilotSdkImportCompatibility('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts'))
        .toBe('patch');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/tmp/repo/node_modules/@github/copilot-sdk/dist/session.js',
        'import { x } from "vscode-jsonrpc/node.js";\n',
        'utf8',
      );
    });
  });

  describe('resolveCopilotSdkSessionPath', () => {
    it('finds the sdk session file by walking up to node_modules', () => {
      expect(resolveCopilotSdkSessionPath('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts'))
        .toBe('/tmp/repo/node_modules/@github/copilot-sdk/dist/session.js');
    });

    it('returns null when no sdk session file exists', () => {
      mockExistsSync.mockReturnValue(false);

      expect(resolveCopilotSdkSessionPath('file:///tmp/repo/packages/tentacle/src/adapters/copilot.ts'))
        .toBeNull();
    });
  });

  describe('resolveCopilotCliPath', () => {
    it('returns the first executable path found on PATH', () => {
      expect(resolveCopilotCliPath()).toBe('/opt/homebrew/bin/copilot');
    });

    it('returns undefined when the PATH lookup fails', () => {
      mockedExecSync.mockImplementation((command: string) => {
        if (command.includes('command -v copilot') || command.includes('where.exe copilot')) {
          throw new Error('not found');
        }
        return 'fake-gh-token\n';
      });

      expect(resolveCopilotCliPath()).toBeUndefined();
    });
  });

  // ── Guards ──────────────────────────────────────────

  describe('guards', () => {
    it('createSession throws if not started', async () => {
      await expect(adapter.createSession({})).rejects.toThrow('not started');
    });

    it('sendMessage throws for unknown session', async () => {
      await adapter.start();
      await expect(adapter.sendMessage('nonexistent', 'hi')).rejects.toThrow('not found');
    });

    it('respondToPermission returns silently for unknown session', async () => {
      await adapter.start();
      await expect(adapter.respondToPermission('nonexistent', 'p1', 'approve'))
        .resolves.toBeUndefined();
    });

    it('respondToQuestion returns silently for unknown session', async () => {
      await adapter.start();
      await expect(adapter.respondToQuestion('nonexistent', 'q1', 'yes', true))
        .resolves.toBeUndefined();
    });

    it('respondToPermission returns silently for unknown permissionId', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      await expect(adapter.respondToPermission(sessionId, 'nonexistent', 'approve'))
        .resolves.toBeUndefined();
    });

    it('respondToQuestion returns silently for unknown questionId', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      await expect(adapter.respondToQuestion(sessionId, 'nonexistent', 'yes', true))
        .resolves.toBeUndefined();
    });
  });

  // ── Session creation ────────────────────────────────

  describe('createSession', () => {
    it('returns a sessionId', async () => {
      await adapter.start();
      const result = await adapter.createSession({ model: 'gpt-5' });
      expect(result.sessionId).toBe('mock-sess-1');
    });

    it('forwards model and cwd to SDK config', async () => {
      await adapter.start();
      await adapter.createSession({ model: 'claude-opus-4.6', cwd: '/tmp/project' });
      const config = capturedSessionConfigs[0];
      expect(config.model).toBe('claude-opus-4.6');
      expect(config.workingDirectory).toBe('/tmp/project');
    });

    it('forwards sessionId when provided', async () => {
      await adapter.start();
      await adapter.createSession({ sessionId: 'custom-id' });
      const config = capturedSessionConfigs[0];
      expect(config.sessionId).toBe('custom-id');
    });

    it('omits undefined fields from config', async () => {
      await adapter.start();
      await adapter.createSession({});
      const config = capturedSessionConfigs[0];
      expect(config).not.toHaveProperty('model');
      expect(config).not.toHaveProperty('workingDirectory');
      expect(config).not.toHaveProperty('sessionId');
    });

    it('fires onSessionCreated callback', async () => {
      const spy = vi.fn();
      adapter.onSessionCreated = spy;
      await adapter.start();
      await adapter.createSession({ model: 'gpt-5' });
      expect(spy).toHaveBeenCalledWith({
        sessionId: 'mock-sess-1',
        agent: 'copilot',
        model: 'gpt-5',
      });
    });

    it('registers permission and question handlers with SDK', async () => {
      await adapter.start();
      await adapter.createSession({});
      const config = capturedSessionConfigs[0];
      expect(typeof config.onPermissionRequest).toBe('function');
      expect(typeof config.onUserInputRequest).toBe('function');
    });
  });

  // ── Resume session ──────────────────────────────────

  describe('resumeSession', () => {
    it('returns the same sessionId', async () => {
      await adapter.start();
      const result = await adapter.resumeSession('existing-session');
      expect(result.sessionId).toBe('existing-session');
    });

    it('passes handlers to SDK', async () => {
      await adapter.start();
      await adapter.resumeSession('existing-session');
      const config = capturedResumeConfigs[0].config;
      expect(typeof config.onPermissionRequest).toBe('function');
      expect(typeof config.onUserInputRequest).toBe('function');
    });
  });

  // ── Send message ────────────────────────────────────

  describe('sendMessage', () => {
    it('calls session.send with prompt', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      await adapter.sendMessage(sessionId, 'hello world');
      expect(mockSessions[0].send).toHaveBeenCalledWith({ prompt: 'hello world' });
    });

    it('includes attachments when provided', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      await adapter.sendMessage(sessionId, 'check this', ['file.png']);
      expect(mockSessions[0].send).toHaveBeenCalledWith({
        prompt: 'check this',
        attachments: [{ type: 'file', path: 'file.png' }],
      });
    });

    it('resumes and retries when the SDK says the session is not found', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0].send.mockRejectedValueOnce(new Error(`Request session.send failed with message: Session not found: ${sessionId}`));

      await adapter.sendMessage(sessionId, 'hello again');

      expect(capturedResumeConfigs).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
      expect(mockSessions[1].send).toHaveBeenCalledWith({ prompt: 'hello again' });
    });

    it('resumes and retries when the SDK connection is disposed', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0].send.mockRejectedValueOnce(new Error('Connection is disposed'));

      await adapter.sendMessage(sessionId, 'retry after reconnect');

      expect(capturedResumeConfigs).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
      expect(mockSessions[1].send).toHaveBeenCalledWith({ prompt: 'retry after reconnect' });
    });

    it('emits error and session_ended when recovery resume fails', async () => {
      const errorSpy = vi.fn();
      const endedSpy = vi.fn();
      adapter.onError = errorSpy;
      adapter.onSessionEnded = endedSpy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0].send.mockRejectedValueOnce(new Error(`Request session.send failed with message: Session not found: ${sessionId}`));
      mockResumeSessionError = new Error('resume blew up');

      await expect(adapter.sendMessage(sessionId, 'retry me')).rejects.toThrow('resume blew up');

      expect(errorSpy).toHaveBeenCalledWith(sessionId, {
        message: 'Session is no longer active in Copilot. Please start a new session.',
      });
      expect(endedSpy).toHaveBeenCalledWith(sessionId, { reason: 'session unavailable' });
    });
  });

  // ── Event wiring ────────────────────────────────────

  describe('event wiring', () => {
    it('wires assistant.message_delta → onMessageDelta', async () => {
      const spy = vi.fn();
      adapter.onMessageDelta = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('assistant.message_delta', { data: { deltaContent: 'hello ' } });
      expect(spy).toHaveBeenCalledWith(sessionId, { content: 'hello ' });
    });

    it('wires assistant.message → onMessage', async () => {
      const spy = vi.fn();
      adapter.onMessage = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('assistant.message', { data: { content: 'Full response' } });
      expect(spy).toHaveBeenCalledWith(sessionId, { content: 'Full response' });
    });

    it('wires tool.execution_start → onToolStart', async () => {
      const spy = vi.fn();
      adapter.onToolStart = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'readFile', args: { path: 'foo.ts' } },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'readFile', args: { path: 'foo.ts' } });
    });

    it('wires tool.execution_complete → onToolComplete', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'readFile', toolCallId: 'tc_1', result: 'const x = 1;' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'readFile', result: 'const x = 1;', toolCallId: 'tc_1' });
    });

    it('wires session.idle → onIdle', async () => {
      const spy = vi.fn();
      adapter.onIdle = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('session.idle', {});
      expect(spy).toHaveBeenCalledWith(sessionId);
    });

    it('wires assistant.turn_end with error → onError', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'error', error: 'Model rate limited' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { message: 'Model rate limited' });
    });

    it('wires assistant.turn_end error with no error message', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'error' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { message: 'Unknown agent error' });
    });

    it('does not fire onError for non-error turn_end', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'complete' },
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not throw when callbacks are null', async () => {
      await adapter.start();
      await adapter.createSession({});
      // Fire events with no callbacks set — should not throw
      mockSessions[0]._emit('assistant.message', { data: { content: 'test' } });
      mockSessions[0]._emit('session.idle', {});
      mockSessions[0]._emit('assistant.turn_end', { data: { reason: 'error', error: 'test' } });
    });
  });

  // ── Permission flow ─────────────────────────────────

  describe('permission flow', () => {
    it('fires onPermissionRequest and blocks until resolved', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});

      // Simulate SDK calling onPermissionRequest
      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'shell', command: 'npm test' },
        { sessionId: 'mock-sess-1' },
      );

      // Callback should have been called
      expect(permSpy).toHaveBeenCalledTimes(1);
      const call = permSpy.mock.calls[0];
      expect(call[0]).toBe('mock-sess-1');
      expect(call[1].toolArgs.toolName).toBe('shell');
      expect(call[1].description).toContain('npm test');

      // Resolve via adapter
      const permId = call[1].id;
      await adapter.respondToPermission('mock-sess-1', permId, 'approve');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'approved' });
    });

    it('maps deny → denied', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'write', fileName: 'foo.ts', intention: 'Edit file' },
        { sessionId: 'mock-sess-1' },
      );

      const permId = permSpy.mock.calls[0][1].id;
      await adapter.respondToPermission('mock-sess-1', permId, 'deny');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'denied-interactively-by-user' });
    });

    it('maps always_allow → approved', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'read', fileName: 'package.json' },
        { sessionId: 'mock-sess-1' },
      );

      const permId = permSpy.mock.calls[0][1].id;
      await adapter.respondToPermission('mock-sess-1', permId, 'always_allow');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'approved' });
    });
  });

  // ── Question flow ───────────────────────────────────

  describe('question flow', () => {
    it('fires onQuestionRequest and blocks until answered', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      const resultPromise = handler(
        { question: 'Which framework?', choices: ['React', 'Vue'], allowFreeform: true },
        { sessionId: 'mock-sess-1' },
      );

      expect(qSpy).toHaveBeenCalledTimes(1);
      const call = qSpy.mock.calls[0];
      expect(call[0]).toBe('mock-sess-1');
      expect(call[1].question).toBe('Which framework?');
      expect(call[1].choices).toEqual(['React', 'Vue']);
      expect(call[1].allowFreeform).toBe(true);

      const qId = call[1].id;
      await adapter.respondToQuestion('mock-sess-1', qId, 'React', false);

      const result = await resultPromise;
      expect(result).toEqual({ answer: 'React', wasFreeform: false });
    });

    it('defaults allowFreeform to true when not set', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      handler({ question: 'Name?' }, { sessionId: 'mock-sess-1' });

      expect(qSpy.mock.calls[0][1].allowFreeform).toBe(true);
    });
  });

  // ── Kill session ────────────────────────────────────

  describe('killSession', () => {
    it('disconnects the session and fires onSessionEnded', async () => {
      const endSpy = vi.fn();
      adapter.onSessionEnded = endSpy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});

      await adapter.killSession(sessionId);

      expect(mockSessions[0].disconnect).toHaveBeenCalled();
      expect(endSpy).toHaveBeenCalledWith(sessionId, { reason: 'killed' });
    });

    it('resolves pending permissions with denied on kill', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'shell', command: 'rm -rf /' },
        { sessionId: 'mock-sess-1' },
      );

      await adapter.killSession('mock-sess-1');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'denied-interactively-by-user' });
    });

    it('resolves pending questions with empty on kill', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      const resultPromise = handler(
        { question: 'Which framework?' },
        { sessionId: 'mock-sess-1' },
      );

      await adapter.killSession('mock-sess-1');

      const result = await resultPromise;
      expect(result).toEqual({ answer: '', wasFreeform: true });
    });

    it('is safe to kill a nonexistent session', async () => {
      await adapter.start();
      await adapter.killSession('nonexistent'); // should not throw
    });
  });

  // ── List sessions ───────────────────────────────────

  describe('listSessions', () => {
    it('returns empty if not started', async () => {
      const result = await adapter.listSessions();
      expect(result).toEqual([]);
    });

    it('merges SDK list with local active sessions', async () => {
      mockListSessions.mockResolvedValue([
        { sessionId: 'sess-1', summary: 'first', context: { cwd: '/tmp' } },
        { sessionId: 'sess-old', summary: 'old' },
      ]);
      await adapter.start();
      await adapter.createSession({}); // creates mock-sess-1

      const list = await adapter.listSessions();
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({ id: 'sess-1', cwd: '/tmp', summary: 'first' });
      expect(list[1]).toMatchObject({ id: 'sess-old', state: 'ended', summary: 'old' });
    });

    it('marks active sessions correctly', async () => {
      await adapter.start();
      await adapter.createSession({}); // mock-sess-1
      mockListSessions.mockResolvedValue([
        { sessionId: 'mock-sess-1', context: { cwd: '/home' } },
      ]);
      const list = await adapter.listSessions();
      expect(list[0]).toMatchObject({ id: 'mock-sess-1', state: 'active' });
    });

    it('handles sessions with no summary', async () => {
      mockListSessions.mockResolvedValue([
        { sessionId: 'no-summary' },
      ]);
      await adapter.start();
      const list = await adapter.listSessions();
      expect(list[0].summary).toBe('');
    });

    it('handles sessions with no context', async () => {
      mockListSessions.mockResolvedValue([
        { sessionId: 'no-ctx', summary: 'test' },
      ]);
      await adapter.start();
      const list = await adapter.listSessions();
      expect(list[0].cwd).toBeUndefined();
    });
  });

  // ── parsePermission ─────────────────────────────────

  describe('parsePermission (via onPermissionRequest)', () => {
    let permSpy: Mock;
    let handler: Function;

    beforeEach(async () => {
      permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});
      handler = capturedSessionConfigs[0].onPermissionRequest;
    });

    it('parses shell permission', async () => {
      handler({ kind: 'shell', command: 'npm test' }, { sessionId: 'mock-sess-1' });
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('shell');
      expect(data.toolArgs.args).toEqual({ command: 'npm test' });
      expect(data.description).toBe('Run: npm test');
    });

    it('parses write permission with intention', async () => {
      handler(
        { kind: 'write', fileName: '/tmp/foo.txt', intention: 'Create file' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('write_file');
      expect(data.toolArgs.args).toEqual({ path: "/tmp/foo.txt", content: "" });
      expect(data.description).toBe('Create file: /tmp/foo.txt');
    });

    it('parses write permission without intention', async () => {
      handler(
        { kind: 'write', fileName: '/tmp/foo.txt' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('write_file');
      expect(data.description).toBe('Write: /tmp/foo.txt');
    });

    it('parses read permission', async () => {
      handler(
        { kind: 'read', fileName: 'src/index.ts', intention: 'read_file' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('read_file');
      expect(data.toolArgs.args).toEqual({ path: 'src/index.ts' });
    });

    it('parses url permission', async () => {
      handler(
        { kind: 'url', url: 'https://example.com' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('fetch_url');
      expect(data.toolArgs.args).toEqual({ url: 'https://example.com' });
      expect(data.description).toBe('Fetch: https://example.com');
    });

    it('parses mcp permission', async () => {
      handler(
        { kind: 'mcp', serverName: 'github', toolName: 'list_issues' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('mcp');
      expect(data.toolArgs.args).toEqual({ tool: 'list_issues', server: 'github', params: {} });
    });

    it('handles unknown kind gracefully', async () => {
      handler(
        { kind: 'custom-tool', toolCallId: 'tc1', foo: 'bar' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('custom-tool');
      expect(data.toolArgs.args).toEqual({ foo: 'bar' });
    });

    it('uses intention for unknown kind when available', async () => {
      handler(
        { kind: 'custom-tool', intention: 'Do something', toolCallId: 'tc1' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('Do something');
      expect(data.description).toBe('Do something');
    });

    it('parses shell with cmd fallback', async () => {
      handler(
        { kind: 'shell', cmd: 'ls -la' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.args).toEqual({ command: 'ls -la' });
      expect(data.description).toBe('Run: ls -la');
    });

    it('parses shell with script fallback', async () => {
      handler(
        { kind: 'shell', script: 'echo hi' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.args).toEqual({ command: 'echo hi' });
    });

    it('parses write with path fallback (no fileName)', async () => {
      handler(
        { kind: 'write', path: '/tmp/alt.txt' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.args).toEqual({ path: "/tmp/alt.txt", content: "" });
    });

    it('parses read with path fallback', async () => {
      handler(
        { kind: 'read', path: 'alt.ts' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.args).toEqual({ path: 'alt.ts' });
    });

    it('parses read with no path at all', async () => {
      handler(
        { kind: 'read' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('read_file');
      expect(data.toolArgs.args).toEqual({ path: '' });
      expect(data.description).toBe('Read: ');
    });

    it('parses read without intention', async () => {
      handler(
        { kind: 'read', fileName: 'test.ts' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('read_file');
      expect(data.description).toBe('Read: test.ts');
    });

    it('parses url with intention', async () => {
      handler(
        { kind: 'url', url: 'https://api.com', intention: 'fetch_url' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('fetch_url');
    });

    it('parses mcp with missing fields', async () => {
      handler(
        { kind: 'mcp' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('mcp');
      expect(data.toolArgs.args).toEqual({ tool: 'unknown', server: 'unknown', params: {} });
    });

    it('parses shell with all fields empty', async () => {
      handler(
        { kind: 'shell' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.args).toEqual({ command: '' });
      expect(data.description).toBe('Run: ');
    });

    it('parses write with all fields empty', async () => {
      handler(
        { kind: 'write' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('write_file');
      expect(data.toolArgs.args).toEqual({ path: '', content: '' });
    });

    it('parses url with empty url', async () => {
      handler(
        { kind: 'url' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('fetch_url');
      expect(data.description).toBe('Fetch: ');
    });

    it('parses request with no kind', async () => {
      handler(
        { someField: 'value' },
        { sessionId: 'mock-sess-1' },
      );
      const data = permSpy.mock.calls[0][1];
      expect(data.toolArgs.toolName).toBe('unknown');
    });
  });

  // ── Event wiring edge cases ─────────────────────────

  describe('event wiring edge cases', () => {
    it('tool_start uses arguments fallback when args is missing', async () => {
      const spy = vi.fn();
      adapter.onToolStart = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'test', arguments: { foo: 'bar' } },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'test', args: { foo: 'bar' } });
    });

    it('tool_start uses empty object when neither args nor arguments exist', async () => {
      const spy = vi.fn();
      adapter.onToolStart = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'test' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'test', args: {} });
    });

    it('tool_complete uses output fallback when result is missing', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'test', output: 'output text' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'test', result: 'output text' });
    });

    it('tool_complete uses empty string when neither result nor output exist', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'test' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, { toolName: 'test', result: '' });
    });
  });

  // ── Start with env vars ─────────────────────────────

  describe('start with environment variables', () => {
    it('uses GITHUB_TOKEN env var when set', async () => {
      const orig = process.env.GITHUB_TOKEN;
      process.env.GITHUB_TOKEN = 'env-token-123';
      try {
        const a = new CopilotAdapter();
        await a.start();
      } finally {
        if (orig) process.env.GITHUB_TOKEN = orig;
        else delete process.env.GITHUB_TOKEN;
      }
    });

    it('uses GH_TOKEN env var when GITHUB_TOKEN is not set', async () => {
      const origGH = process.env.GITHUB_TOKEN;
      const origGH2 = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = 'gh-token-456';
      try {
        const a = new CopilotAdapter();
        await a.start();
      } finally {
        if (origGH) process.env.GITHUB_TOKEN = origGH;
        else delete process.env.GITHUB_TOKEN;
        if (origGH2) process.env.GH_TOKEN = origGH2;
        else delete process.env.GH_TOKEN;
      }
    });

    it('falls back to gh CLI when no env vars set', async () => {
      const origGH = process.env.GITHUB_TOKEN;
      const origGH2 = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      mockedExecSync.mockReturnValueOnce('cli-token\n');
      try {
        const a = new CopilotAdapter();
        await a.start();
      } finally {
        if (origGH) process.env.GITHUB_TOKEN = origGH;
        else delete process.env.GITHUB_TOKEN;
        if (origGH2) process.env.GH_TOKEN = origGH2;
        else delete process.env.GH_TOKEN;
      }
    });

    it('handles gh CLI returning empty string', async () => {
      const origGH = process.env.GITHUB_TOKEN;
      const origGH2 = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      mockedExecSync.mockReturnValueOnce('');
      try {
        const a = new CopilotAdapter();
        await a.start();
      } finally {
        if (origGH) process.env.GITHUB_TOKEN = origGH;
        else delete process.env.GITHUB_TOKEN;
        if (origGH2) process.env.GH_TOKEN = origGH2;
        else delete process.env.GH_TOKEN;
      }
    });

    it('handles gh CLI throwing an error', async () => {
      const origGH = process.env.GITHUB_TOKEN;
      const origGH2 = process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      mockedExecSync.mockImplementationOnce(() => { throw new Error('gh not found'); });
      try {
        const a = new CopilotAdapter();
        await a.start(); // should not throw — falls through to SDK auth
      } finally {
        if (origGH) process.env.GITHUB_TOKEN = origGH;
        else delete process.env.GITHUB_TOKEN;
        if (origGH2) process.env.GH_TOKEN = origGH2;
        else delete process.env.GH_TOKEN;
      }
    });

    it('passes cliPath when provided', async () => {
      const a = new CopilotAdapter({ cliPath: '/custom/copilot' });
      await a.start();
    });
  });

  // ── Question edge cases ─────────────────────────────

  describe('question edge cases', () => {
    it('handles question with no choices', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      handler({ question: 'Name?' }, { sessionId: 'mock-sess-1' });

      const data = qSpy.mock.calls[0][1];
      expect(data.choices).toBeUndefined();
      expect(data.allowFreeform).toBe(true);
    });

    it('handles question with allowFreeform explicitly false', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      handler(
        { question: 'Pick one:', choices: ['A', 'B'], allowFreeform: false },
        { sessionId: 'mock-sess-1' },
      );

      const data = qSpy.mock.calls[0][1];
      expect(data.allowFreeform).toBe(false);
    });

    it('handles question with empty question string', async () => {
      const qSpy = vi.fn();
      adapter.onQuestionRequest = qSpy;
      await adapter.start();
      await adapter.createSession({});

      const handler = capturedSessionConfigs[0].onUserInputRequest;
      handler({}, { sessionId: 'mock-sess-1' });

      expect(qSpy.mock.calls[0][1].question).toBe('');
    });
  });

  // ── sendMessage with attachments edge case ──────────

  describe('sendMessage edge cases', () => {
    it('does not include attachments when array is empty', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      await adapter.sendMessage(sessionId, 'hi', []);
      expect(mockSessions[0].send).toHaveBeenCalledWith({ prompt: 'hi' });
    });
  });
});
