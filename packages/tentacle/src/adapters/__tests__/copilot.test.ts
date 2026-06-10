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
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  const catchAllListeners: Function[] = [];
  return {
    sessionId,
    send: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    on: vi.fn((...args: unknown[]) => {
      if (args.length === 2) {
        // Typed form: on(eventType, handler)
        const [event, handler] = args as [string, Function];
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)!.push(handler);
      } else if (args.length === 1 && typeof args[0] === 'function') {
        // Catch-all form: on(handler)
        catchAllListeners.push(args[0] as Function);
      }
    }),
    // Test helper: fire a fake SDK event
    _emit(event: string, data: unknown) {
      for (const fn of listeners.get(event) ?? []) fn(data);
      // Also dispatch to catch-all listeners with {type, data} shape
      const eventObj = { type: event, ...(typeof data === 'object' && data !== null ? data : { data }) };
      for (const fn of catchAllListeners) fn(eventObj);
    },
    _listeners: listeners,
  };
}

type MockSession = ReturnType<typeof createMockSession>;

const fakeRepoRoot = resolve('/tmp/repo');
const fakeSdkSessionPath = resolve(fakeRepoRoot, 'node_modules', '@github', 'copilot-sdk', 'dist', 'session.js');
const fakeAdapterUrl = pathToFileURL(resolve(fakeRepoRoot, 'packages', 'tentacle', 'src', 'adapters', 'copilot.ts')).href;
const fakeCopilotPath = process.platform === 'win32' ? 'C:\\Tools\\copilot.exe' : '/opt/homebrew/bin/copilot';

let mockSessions: MockSession[];
let capturedSessionConfigs: Record<string, unknown>[];
let capturedResumeConfigs: Record<string, unknown>[];
let capturedClientOptions: Record<string, unknown>[];
let mockListSessions: Mock;
let mockResumeSessionError: Error | null;
let mockGetAuthStatus: Mock;
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
let mockRegisterHooks: Mock | undefined;
let mockRegister: Mock | undefined;

vi.mock('@github/copilot-sdk', () => {
  return {
    CopilotClient: vi.fn().mockImplementation((options: Record<string, unknown>) => {
      capturedClientOptions.push(options);
      return {
        start: vi.fn(),
        stop: vi.fn(),
        createSession: vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
          capturedSessionConfigs.push(config);
          const session = createMockSession(`mock-sess-${mockSessions.length + 1}`);
          mockSessions.push(session);
          return session;
        }),
        resumeSession: vi.fn().mockImplementation(async (sessionId: string, config: Record<string, unknown>) => {
          capturedResumeConfigs.push({ sessionId, config });
          if (mockResumeSessionError) {
            throw mockResumeSessionError;
          }
          const session = createMockSession(sessionId);
          mockSessions.push(session);
          return session;
        }),
        listSessions: mockListSessions,
        getAuthStatus: mockGetAuthStatus,
      };
    }),
  };
});

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  cpSync: vi.fn(),
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

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Isolate from real environment tokens so the mock execSync controls the value
    savedEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    savedEnv.GH_TOKEN = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    mockSessions = [];
    capturedSessionConfigs = [];
    capturedResumeConfigs = [];
    capturedClientOptions = [];
    mockListSessions = vi.fn().mockResolvedValue([]);
    mockResumeSessionError = null;
    mockGetAuthStatus = vi.fn().mockResolvedValue({ isAuthenticated: true });
    mockRegisterHooks = vi.fn();
    mockRegister = vi.fn();
    mockExistsSync.mockImplementation(
      (path: string) =>
        path === fakeSdkSessionPath ||
        path === fakeCopilotPath,
    );
    mockReadFileSync.mockReturnValue('import "vscode-jsonrpc/node.js";\n');
    mockWriteFileSync.mockReset();
    mockedExecSync.mockImplementation((command: string) => {
      if (command.includes('gh auth token')) {
        return 'fake-gh-token\n';
      }
      if (command.includes('command -v copilot') || command.includes('where.exe copilot')) {
        return `${fakeCopilotPath}\n`;
      }
      return '';
    });
    adapter = new CopilotAdapter();
  });

  afterEach(() => {
    // Restore environment
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
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

    it('start() passes useLoggedInUser: true and the resolved Copilot CLI path to the SDK', async () => {
      await adapter.start();

      expect(capturedClientOptions[0]).toEqual(
        expect.objectContaining({
          useLoggedInUser: true,
          cliPath: fakeCopilotPath,
        }),
      );
      // Static gitHubToken should NOT be injected — copilot server owns auth refresh
      expect(capturedClientOptions[0]).not.toHaveProperty('gitHubToken');
    });

    it('patches the SDK import when the installed session file is incompatible', () => {
      mockReadFileSync.mockReturnValue('import { x } from "vscode-jsonrpc/node";\n');

      expect(patchCopilotSdkSessionImport(fakeAdapterUrl)).toBe(true);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        fakeSdkSessionPath,
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

    it('stop() aborts each active session before tearing down the client', async () => {
      await adapter.start();
      const a = await adapter.createSession({ model: 'gpt-5' });
      const b = await adapter.createSession({ model: 'gpt-5' });

      const sessionA = mockSessions.find(s => s.sessionId === a.sessionId)!;
      const sessionB = mockSessions.find(s => s.sessionId === b.sessionId)!;

      await adapter.stop();

      expect(sessionA.abort).toHaveBeenCalledTimes(1);
      expect(sessionB.abort).toHaveBeenCalledTimes(1);
    });

    it('stop() proceeds when one session.abort() hangs (timeout guard)', async () => {
      await adapter.start();
      const a = await adapter.createSession({ model: 'gpt-5' });
      const b = await adapter.createSession({ model: 'gpt-5' });

      const sessionA = mockSessions.find(s => s.sessionId === a.sessionId)!;
      const sessionB = mockSessions.find(s => s.sessionId === b.sessionId)!;

      // sessionA's abort hangs forever; sessionB resolves normally.
      sessionA.abort.mockImplementation(() => new Promise(() => {}));

      vi.useFakeTimers();
      const stopP = adapter.stop();
      // Let microtasks run, then exceed the abort timeout.
      await vi.advanceTimersByTimeAsync(2_500);
      await stopP;
      vi.useRealTimers();

      // Both sessions were attempted; the hung one was abandoned.
      expect(sessionA.abort).toHaveBeenCalledTimes(1);
      expect(sessionB.abort).toHaveBeenCalledTimes(1);
      // listSessions returns [] — sessions map was cleared.
      const sessions = await adapter.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('patchCopilotSdkSessionImport', () => {
    it('returns false when no patch is needed', () => {
      mockReadFileSync.mockReturnValue('import "vscode-jsonrpc/node.js";\n');

      expect(patchCopilotSdkSessionImport(fakeAdapterUrl)).toBe(false);
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('installCopilotSdkImportCompatibility', () => {
    it('uses registerHooks when available', () => {
      expect(installCopilotSdkImportCompatibility(fakeAdapterUrl))
        .toBe('hook');
      expect(mockRegisterHooks).toHaveBeenCalledTimes(1);
      expect(mockRegister).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('falls back to module.register when sync hooks are unavailable', () => {
      mockRegisterHooks = undefined;

      expect(installCopilotSdkImportCompatibility(fakeAdapterUrl))
        .toBe('hook');
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^data:text\/javascript,/),
        fakeAdapterUrl,
      );
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('falls back to patching when module hooks are unavailable', () => {
      mockRegisterHooks = undefined;
      mockRegister = undefined;
      mockReadFileSync.mockReturnValue('import { x } from "vscode-jsonrpc/node";\n');

      expect(installCopilotSdkImportCompatibility(fakeAdapterUrl))
        .toBe('patch');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        fakeSdkSessionPath,
        'import { x } from "vscode-jsonrpc/node.js";\n',
        'utf8',
      );
    });
  });

  describe('resolveCopilotSdkSessionPath', () => {
    it('finds the sdk session file by walking up to node_modules', () => {
      expect(resolveCopilotSdkSessionPath(fakeAdapterUrl))
        .toBe(fakeSdkSessionPath);
    });

    it('returns null when no sdk session file exists', () => {
      mockExistsSync.mockReturnValue(false);

      expect(resolveCopilotSdkSessionPath(fakeAdapterUrl))
        .toBeNull();
    });
  });

  describe('resolveCopilotCliPath', () => {
    it('returns the first executable path found on PATH', () => {
      expect(resolveCopilotCliPath()).toBe(fakeCopilotPath);
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

    it('sendMessage on unknown session attempts to resume and reports session_ended if resume fails', async () => {
      // Previously: sendMessage threw "Session not found" as a guard.
      // After v0.21.1+ fix: sendMessage tries to resume from disk (self-heal
      // for state-drift cases). If the SDK has no record either, we fall
      // through to handleUnavailableSession → arm sees session_ended.
      const endedSpy = vi.fn();
      const errorSpy = vi.fn();
      adapter.onSessionEnded = endedSpy;
      adapter.onError = errorSpy;
      await adapter.start();
      mockResumeSessionError = new Error('Session file is missing');

      await expect(adapter.sendMessage('nonexistent', 'hi')).rejects.toThrow();
      expect(endedSpy).toHaveBeenCalledWith('nonexistent', { reason: 'session unavailable' });
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
      await adapter.sendMessage(sessionId, 'check this', [{ type: 'image', mimeType: 'image/png', data: 'iVBOR' }]);
      expect(mockSessions[0].send).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'check this',
          attachments: [expect.objectContaining({ type: 'file' })],
        }),
      );
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

    it('fires onError with descriptive auth message for auth errors on send', async () => {
      const errorSpy = vi.fn();
      adapter.onError = errorSpy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0].send.mockRejectedValueOnce(new Error('Authorization error, you may need to run /login'));
      mockGetAuthStatus.mockResolvedValueOnce({ isAuthenticated: false });

      await expect(adapter.sendMessage(sessionId, 'hello')).rejects.toThrow('Authorization error');

      expect(errorSpy).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        message: expect.stringContaining('GitHub credential expired'),
      }));
    });

    it('self-heals when the SDK session is not loaded (resumes from disk + retries)', async () => {
      // Regression for v0.21.1: meta state could drift such that the relay-
      // client did not lazy-resume before calling sendMessage. The adapter's
      // getSession() would throw "Session not found" and escape the recovery
      // path, leaving the user with a permanent "Failed to deliver message"
      // until restart.
      await adapter.start();
      // Pretend the session exists on disk (resume will succeed) but is not
      // tracked in the adapter's in-memory map.
      const sessionId = 'sess-not-loaded';

      await adapter.sendMessage(sessionId, 'first message after crash');

      // The adapter resumed the session from disk and successfully delivered.
      expect(capturedResumeConfigs).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
      // The freshly-resumed session received the prompt.
      expect(mockSessions[mockSessions.length - 1].send).toHaveBeenCalledWith({ prompt: 'first message after crash' });
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
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(sessionId, { message: 'Model rate limited' });
      });
    });

    it('wires assistant.turn_end error with no error message', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'error' },
      });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(sessionId, { message: 'Unknown agent error' });
      });
    });

    it('does not fire onError for non-error turn_end with output', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      await adapter.createSession({});
      // Simulate a complete turn: start → message → end
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('assistant.message', { data: { content: 'hello' } });
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'complete' },
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it('fires onError for empty cycle (no output until idle)', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      // Simulate user sending a message that produces nothing through to idle
      await adapter.sendMessage(sessionId, 'hi');
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('assistant.turn_end', {
        data: { reason: 'complete' },
      });
      mockSessions[0]._emit('session.idle', {});
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: expect.stringContaining('no output') }),
      );
    });

    it('does not fire onError for empty turn when previous turn in same cycle had output', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      // User sends a message that triggers a tool, then agent stays silent
      await adapter.sendMessage(sessionId, 'silently run echo');
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('tool.execution_start', { data: { toolName: 'bash', toolCallId: 't1' } });
      mockSessions[0]._emit('tool.execution_complete', { data: { toolName: 'bash', toolCallId: 't1' } });
      mockSessions[0]._emit('assistant.turn_end', { data: { reason: 'complete' } });
      // Second turn: model decides to stay silent (no output)
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '2' } });
      mockSessions[0]._emit('assistant.turn_end', { data: { reason: 'complete' } });
      mockSessions[0]._emit('session.idle', {});
      // No error — the cycle had output (the tool ran)
      expect(spy).not.toHaveBeenCalled();
    });

    it('detects empty cycle in second user message even after first cycle errored', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});

      // Cycle 1: user message → session.error fires
      await adapter.sendMessage(sessionId, 'first');
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'rate_limit', message: 'Rate limited' },
      });
      mockSessions[0]._emit('session.idle', {});
      spy.mockClear();

      // Cycle 2: user message → session goes idle with no output (silent fail)
      await adapter.sendMessage(sessionId, 'second');
      mockSessions[0]._emit('session.idle', {});
      // Should fire empty-cycle error — not suppressed by previous cycle's error flag
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: expect.stringContaining('no output') }),
      );
    });

    it('does NOT fire empty-cycle error when user aborted the turn before output', async () => {
      // Regression: previously, sending a message and clicking stop immediately
      // would cause a phantom "Agent produced no output" error because the
      // detector ran on the abort-triggered session.idle. User-initiated aborts
      // are the user's explicit choice; producing no output is the expected
      // outcome, not a silent SDK failure.
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});

      // User sends a message, then immediately clicks stop before any output.
      await adapter.sendMessage(sessionId, 'do something');
      await adapter.abortSession(sessionId);
      // SDK fires the idle event in response to the abort.
      mockSessions[0]._emit('session.idle', {});

      expect(spy).not.toHaveBeenCalled();
    });

    it('still fires empty-cycle error on the NEXT cycle after an abort', async () => {
      // The abort flag must be cleared after the abort-triggered idle fires,
      // so a subsequent legitimately-empty cycle still gets flagged.
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});

      // Cycle 1: user sends + aborts immediately. No error fires.
      await adapter.sendMessage(sessionId, 'first');
      await adapter.abortSession(sessionId);
      mockSessions[0]._emit('session.idle', {});
      expect(spy).not.toHaveBeenCalled();

      // Cycle 2: user sends a normal message, session silently produces nothing.
      // This IS a real failure case and should still fire.
      await adapter.sendMessage(sessionId, 'second');
      mockSessions[0]._emit('session.idle', {});
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: expect.stringContaining('no output') }),
      );
    });

    it('abort flag does not leak across sessions', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId: sidA } = await adapter.createSession({});
      const { sessionId: sidB } = await adapter.createSession({});
      // mockSessions[0] = sidA, mockSessions[1] = sidB

      // Abort session A.
      await adapter.sendMessage(sidA, 'A');
      await adapter.abortSession(sidA);
      mockSessions[0]._emit('session.idle', {});
      expect(spy).not.toHaveBeenCalled();

      // Session B sends a message, gets silently empty. Should still fire — B
      // was never aborted.
      await adapter.sendMessage(sidB, 'B');
      mockSessions[1]._emit('session.idle', {});
      expect(spy).toHaveBeenCalledWith(
        sidB,
        expect.objectContaining({ message: expect.stringContaining('no output') }),
      );
    });

    it('does not throw when callbacks are null', async () => {
      await adapter.start();
      await adapter.createSession({});
      // Fire events with no callbacks set — should not throw
      mockSessions[0]._emit('assistant.message', { data: { content: 'test' } });
      mockSessions[0]._emit('session.idle', {});
      mockSessions[0]._emit('assistant.turn_end', { data: { reason: 'error', error: 'test' } });
    });

    it('fires onError for session.error events', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'query', message: 'Model "opus" is not available.', statusCode: 400 },
      });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledWith(sessionId, { message: 'Model "opus" is not available.' });
      });
    });

    it('fires onError with descriptive auth message for auth-related session.error events', async () => {
      const errorSpy = vi.fn();
      adapter.onError = errorSpy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockGetAuthStatus.mockResolvedValueOnce({ isAuthenticated: false });
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'auth', message: 'Authorization error, you may need to run /login', statusCode: 401 },
      });
      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(sessionId, expect.objectContaining({
          message: expect.stringContaining('GitHub credential expired'),
        }));
      });
    });

    it('disconnects and errors on model mismatch in tools_updated', async () => {
      const errorSpy = vi.fn();
      const idleSpy = vi.fn();
      adapter.onError = errorSpy;
      adapter.onIdle = idleSpy;
      await adapter.start();
      await adapter.createSession({ model: 'claude-opus-4.6' });
      mockSessions[0]._emit('session.tools_updated', {
        data: { model: 'goldeneye' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: expect.stringContaining('unavailable') }),
      );
      expect(idleSpy).toHaveBeenCalled();
      // Session should be removed from adapter — next getSession would throw
      expect(mockSessions[0].abort).toHaveBeenCalled();
      expect(mockSessions[0].disconnect).toHaveBeenCalled();
    });

    it('does not disconnect when tools_updated matches expected model', async () => {
      const errorSpy = vi.fn();
      adapter.onError = errorSpy;
      await adapter.start();
      await adapter.createSession({ model: 'claude-opus-4.6' });
      mockSessions[0]._emit('session.tools_updated', {
        data: { model: 'claude-opus-4.6' },
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(mockSessions[0].abort).not.toHaveBeenCalled();
    });

    it('does not disconnect when user changed model via setSessionModel', async () => {
      const errorSpy = vi.fn();
      adapter.onError = errorSpy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({ model: 'claude-opus-4.6' });
      await adapter.setSessionModel(sessionId, 'gpt-4.1');
      mockSessions[0]._emit('session.tools_updated', {
        data: { model: 'gpt-4.1' },
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(mockSessions[0].abort).not.toHaveBeenCalled();
    });

    it('uses original user-requested model in error message after fallback', async () => {
      const errorSpy = vi.fn();
      adapter.onError = errorSpy;
      adapter.onIdle = vi.fn();
      await adapter.start();
      await adapter.createSession({ model: 'claude-opus-4.6-1m' });
      mockSessions[0]._emit('session.tools_updated', {
        data: { model: 'goldeneye' },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ message: expect.stringContaining('claude-opus-4.6-1m') }),
      );
    });

    it('does not duplicate session.error reports within the same turn', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'query', message: 'First error' },
      });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'query', message: 'Duplicate error' },
      });
      // Second session.error should be suppressed (turnErrorReported is already true, sync check)
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
    });

    it('does not fire empty-turn error when session.error already reported', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      await adapter.createSession({});
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'query', message: 'API error' },
      });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
      spy.mockClear();
      mockSessions[0]._emit('assistant.turn_end', { data: {} });
      // Should not double-report — session.error already surfaced
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not double-report when session.error fires before turn_start', async () => {
      const spy = vi.fn();
      adapter.onError = spy;
      await adapter.start();
      await adapter.createSession({});
      // session.error arrives BEFORE turn_start (error recovery path)
      mockSessions[0]._emit('session.error', {
        data: { errorType: 'query', message: 'Model not available' },
      });
      await vi.waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
      spy.mockClear();
      // turn_start should NOT reset the error flag
      mockSessions[0]._emit('assistant.turn_start', { data: { turnId: '1' } });
      mockSessions[0]._emit('assistant.turn_end', { data: {} });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── Permission flow ─────────────────────────────────

  describe('permission flow', () => {
    it('fires onPermissionRequest and blocks until resolved', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});
      adapter.setSessionMode('mock-sess-1', 'safe');

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
      expect(result).toEqual({ kind: 'approve-once' });
    });

    it('maps deny → denied', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});
      adapter.setSessionMode('mock-sess-1', 'safe');

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'write', fileName: 'foo.ts', intention: 'Edit file' },
        { sessionId: 'mock-sess-1' },
      );

      const permId = permSpy.mock.calls[0][1].id;
      await adapter.respondToPermission('mock-sess-1', permId, 'deny');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'reject' });
    });

    it('maps always_allow → approved', async () => {
      const permSpy = vi.fn();
      adapter.onPermissionRequest = permSpy;
      await adapter.start();
      await adapter.createSession({});
      adapter.setSessionMode('mock-sess-1', 'safe');

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'read', fileName: 'package.json' },
        { sessionId: 'mock-sess-1' },
      );

      const permId = permSpy.mock.calls[0][1].id;
      await adapter.respondToPermission('mock-sess-1', permId, 'always_allow');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'approve-once' });
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
      adapter.setSessionMode('mock-sess-1', 'safe');

      const handler = capturedSessionConfigs[0].onPermissionRequest;
      const resultPromise = handler(
        { kind: 'shell', command: 'rm -rf /' },
        { sessionId: 'mock-sess-1' },
      );

      await adapter.killSession('mock-sess-1');

      const result = await resultPromise;
      expect(result).toEqual({ kind: 'reject' });
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

    it('clears pendingToolArgs/pendingToolIdentity for tool calls that never completed', async () => {
      await adapter.start();
      await adapter.createSession({});
      // Two tool calls started but never completed (e.g. session killed mid-flight)
      mockSessions[0]._emit('tool.execution_start', { data: { toolName: 'bash', toolCallId: 'leak-1' } });
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'view', toolCallId: 'leak-2', mcpServerName: 'kraki', mcpToolName: 'show_image' },
      });
      // Sanity: maps are populated
      const a = adapter as unknown as {
        pendingToolArgs: Map<string, unknown>;
        pendingToolIdentity: Map<string, unknown>;
        sessionToolCallIds: Map<string, Set<string>>;
      };
      expect(a.pendingToolArgs.size).toBe(2);
      expect(a.pendingToolIdentity.size).toBe(2);
      expect(a.sessionToolCallIds.get('mock-sess-1')?.size).toBe(2);

      await adapter.killSession('mock-sess-1');

      // After kill, all three are empty
      expect(a.pendingToolArgs.size).toBe(0);
      expect(a.pendingToolIdentity.size).toBe(0);
      expect(a.sessionToolCallIds.has('mock-sess-1')).toBe(false);
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
      adapter.setSessionMode('mock-sess-1', 'safe');
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

    it('tool_complete extracts error message when result is absent (failed tool)', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'web_fetch', toolCallId: 'tc1', success: false, error: { message: 'Failed to fetch https://example.com: timeout' } },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, {
        toolName: 'web_fetch',
        result: 'Failed to fetch https://example.com: timeout',
        toolCallId: 'tc1',
        success: false,
      });
    });

    it('tool_complete extracts string error when result is absent', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'web_fetch', success: false, error: 'Connection refused' },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, {
        toolName: 'web_fetch',
        result: 'Connection refused',
        success: false,
      });
    });

    it('tool_complete for `view` on an image NO LONGER attaches bytes (v1: only kraki-show_image surfaces images)', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const imgPath = '/tmp/test-image.png';
      mockExistsSync.mockImplementation((p: string) => p === imgPath);
      mockReadFileSync.mockImplementation((p: string) => {
        if (p === imgPath) return Buffer.from(pngBase64, 'base64');
        throw new Error('not found');
      });
      try {
        mockSessions[0]._emit('tool.execution_start', {
          data: { toolName: 'view', toolCallId: 'tc_img', args: { path: imgPath } },
        });
        mockSessions[0]._emit('tool.execution_complete', {
          data: {
            toolCallId: 'tc_img',
            result: { content: 'Viewed image file successfully.' },
            toolTelemetry: { properties: { viewType: 'image', mimeType: 'image/png' } },
          },
        });
        expect(spy).toHaveBeenCalledWith(sessionId, expect.objectContaining({
          toolName: 'view',
          result: 'Viewed image file successfully.',
          attachments: undefined,
        }));
      } finally {
        mockExistsSync.mockReset();
        mockReadFileSync.mockReset();
      }
    });

    it('tool_complete does not attach image when file does not exist', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockExistsSync.mockReturnValue(false);
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'view', toolCallId: 'tc_nofile', args: { path: '/nonexistent/file.png' } },
      });
      mockSessions[0]._emit('tool.execution_complete', {
        data: {
          toolName: 'view', toolCallId: 'tc_nofile',
          result: { content: 'Viewed image file successfully.' },
          toolTelemetry: { properties: { viewType: 'image', mimeType: 'image/png' } },
        },
      });
      expect(spy).toHaveBeenCalledWith(sessionId, expect.objectContaining({
        toolName: 'view',
        attachments: undefined,
      }));
      mockExistsSync.mockReset();
    });

    it('tool_complete cleans up pendingToolArgs after completion', async () => {
      const spy = vi.fn();
      adapter.onToolComplete = spy;
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      mockSessions[0]._emit('tool.execution_start', {
        data: { toolName: 'bash', toolCallId: 'tc_clean', args: { command: 'ls' } },
      });
      mockSessions[0]._emit('tool.execution_complete', {
        data: { toolName: 'bash', toolCallId: 'tc_clean', result: 'output' },
      });
      // Emit another complete with same toolCallId — should NOT have stale args
      mockExistsSync.mockReturnValue(false);
      mockSessions[0]._emit('tool.execution_complete', {
        data: {
          toolName: 'view', toolCallId: 'tc_clean',
          result: { content: 'Viewed image file successfully.' },
          toolTelemetry: { properties: { viewType: 'image', mimeType: 'image/png' } },
        },
      });
      // No path from stale args → no attachment
      expect(spy).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({
        attachments: undefined,
      }));
      mockExistsSync.mockReset();
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

  // ── setSessionModel ────────────────────────────────

  describe('setSessionModel', () => {
    it('calls session.setModel on the SDK session', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({ model: 'gpt-5' });

      await adapter.setSessionModel(sessionId, 'claude-opus-4');

      expect(mockSessions[0].setModel).toHaveBeenCalledWith('claude-opus-4');
    });

    it('does not throw for unknown session', async () => {
      await adapter.start();
      await adapter.setSessionModel('nonexistent', 'gpt-5');
      // Should not throw
    });
  });

  // ── Runtime death recovery (probeRuntime + rebuildClient) ──

  describe('runtime death recovery', () => {
    it('rebuildClient tears down the dead client and spawns a fresh one', async () => {
      await adapter.start();
      const firstClientCount = capturedClientOptions.length;
      await adapter.createSession({});
      expect((adapter as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(1);

      await adapter.rebuildClient();

      // A new CopilotClient was constructed and start() ran again.
      expect(capturedClientOptions.length).toBe(firstClientCount + 1);
      // All previous SDK session handles are invalidated — caller is
      // responsible for re-resuming individual sessions on demand.
      expect((adapter as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
    });

    it('rebuildClient resolves pending permission requests across all sessions before tearing them down', async () => {
      const autoResolveSpy = vi.fn();
      adapter.onPermissionAutoResolved = autoResolveSpy;

      await adapter.start();
      const { sessionId: a } = await adapter.createSession({});
      const { sessionId: b } = await adapter.createSession({});

      // Capture the SDK's onPermissionRequest handler for both sessions and
      // start a request on each. The handler returns a Promise we expect to
      // resolve with a reject decision when rebuildClient runs cleanup.
      const sessionAEntry = (adapter as unknown as { sessions: Map<string, { pendingPermissions: Map<string, { resolve: (v: { kind: string }) => void }> }> }).sessions.get(a)!;
      const sessionBEntry = (adapter as unknown as { sessions: Map<string, { pendingPermissions: Map<string, { resolve: (v: { kind: string }) => void }> }> }).sessions.get(b)!;
      let resolveA = false;
      let resolveB = false;
      sessionAEntry.pendingPermissions.set('perm-a', { resolve: () => { resolveA = true; } } as unknown as { resolve: (v: { kind: string }) => void });
      sessionBEntry.pendingPermissions.set('perm-b', { resolve: () => { resolveB = true; } } as unknown as { resolve: (v: { kind: string }) => void });

      await adapter.rebuildClient();

      expect(resolveA).toBe(true);
      expect(resolveB).toBe(true);
      expect(autoResolveSpy).toHaveBeenCalledWith(a, 'perm-a', 'cancelled');
      expect(autoResolveSpy).toHaveBeenCalledWith(b, 'perm-b', 'cancelled');
    });

    it('rebuildClient serialises concurrent callers (single rebuild even when called twice)', async () => {
      await adapter.start();
      const before = capturedClientOptions.length;

      const [r1, r2] = await Promise.all([adapter.rebuildClient(), adapter.rebuildClient()]);

      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      // Exactly ONE additional client was built, even though we asked twice.
      expect(capturedClientOptions.length).toBe(before + 1);
    });

    it('sendMessage rebuilds the client and retries when the runtime is dead (probe throws)', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      const clientsBeforeSend = capturedClientOptions.length;

      // Simulate: send fails because the runtime process exited, AND
      // getAuthStatus throws because the JSON-RPC channel is gone. The
      // adapter must classify this as 'dead' → rebuild → re-resume → retry.
      mockSessions[0].send.mockRejectedValueOnce(new Error('Connection is closed.'));
      mockGetAuthStatus.mockRejectedValueOnce(new Error('Connection is closed.'));

      await adapter.sendMessage(sessionId, 'hello after crash');

      // A new client was built (rebuild) AND the session was resumed onto it.
      expect(capturedClientOptions.length).toBe(clientsBeforeSend + 1);
      expect(capturedResumeConfigs).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
      // The send was retried on the new session handle.
      expect(mockSessions[mockSessions.length - 1].send).toHaveBeenCalledWith({ prompt: 'hello after crash' });
    });

    it('sendMessage does not rebuild when probe says runtime is alive (session-level error path)', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      const clientsBeforeSend = capturedClientOptions.length;

      // Send fails, but probe still succeeds → session-level error,
      // resume on the existing client (no rebuild).
      mockSessions[0].send.mockRejectedValueOnce(new Error(`Session not found: ${sessionId}`));

      await adapter.sendMessage(sessionId, 'retry on same runtime');

      // No new client was built (no rebuild).
      expect(capturedClientOptions.length).toBe(clientsBeforeSend);
      expect(capturedResumeConfigs).toEqual([
        expect.objectContaining({ sessionId }),
      ]);
    });

    it('probeRuntime times out and reports the runtime as dead when getAuthStatus hangs', async () => {
      await adapter.start();
      const { sessionId } = await adapter.createSession({});
      const clientsBeforeSend = capturedClientOptions.length;

      // getAuthStatus never resolves → exceeds PROBE_RUNTIME_TIMEOUT_MS → treated as dead.
      mockSessions[0].send.mockRejectedValueOnce(new Error('something blew up'));
      mockGetAuthStatus.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

      vi.useFakeTimers();
      const sendPromise = adapter.sendMessage(sessionId, 'wedged probe');
      // Advance past the 5s probe timeout
      await vi.advanceTimersByTimeAsync(5_001);
      await sendPromise;
      vi.useRealTimers();

      // Treated as dead → rebuilt + re-resumed + retried.
      expect(capturedClientOptions.length).toBe(clientsBeforeSend + 1);
      expect(mockSessions[mockSessions.length - 1].send).toHaveBeenCalledWith({ prompt: 'wedged probe' });
    });
  });

  // ── Idle-session eviction ─────────────────────────────────────

  // Eviction is intentionally a no-op on Windows (no pgrep for descendant
  // RSS walk). Skip the test suite there — semantics are platform-aware.
  const describeEviction = process.platform === 'win32' ? describe.skip : describe;

  describeEviction('idle-session eviction', () => {
    type AdapterInternals = {
      sessions: Map<string, { pendingPermissions: Map<string, unknown>; pendingQuestions: Map<string, unknown>; session: { disconnect: Mock } }>;
      lastActivityAt: Map<string, number>;
      turnHasOutput: Map<string, boolean>;
      evictIdleSessions: () => Promise<void>;
    };

    // Helper: configure execSync to report the given total RSS (MB).
    function mockRuntimeRssMB(mb: number, sessionCount: number) {
      // pgrep returns child pids; ps returns rss in KB. Simulate `sessionCount`
      // child processes each contributing equally so the sum hits `mb`.
      const pids = Array.from({ length: sessionCount }, (_, i) => 90000 + i);
      const rssKb = Math.round((mb * 1024) / Math.max(sessionCount, 1));
      mockedExecSync.mockImplementation((command: string) => {
        if (command.includes('gh auth token')) return 'fake-gh-token\n';
        if (command.includes('command -v copilot') || command.includes('where.exe copilot')) return `${fakeCopilotPath}\n`;
        if (command.startsWith('pgrep -P ')) {
          // Single hop: report `sessionCount` direct children, no grandchildren.
          if (command.includes(`-P ${process.pid}`)) return pids.join('\n');
          return '';
        }
        if (command.startsWith('ps -o rss=')) {
          return pids.map(() => String(rssKb)).join('\n');
        }
        return '';
      });
    }

    it('does NOT evict when total runtime RSS is below the 2GB threshold', async () => {
      await adapter.start();
      const a = await adapter.createSession({});
      const b = await adapter.createSession({});

      // Force "ancient" activity so the only thing protecting these sessions
      // is the RSS threshold.
      const internals = adapter as unknown as AdapterInternals;
      internals.lastActivityAt.set(a.sessionId, 0);
      internals.lastActivityAt.set(b.sessionId, 0);

      // Report RSS = 500 MB — well under threshold.
      mockRuntimeRssMB(500, 2);

      await internals.evictIdleSessions();

      expect(internals.sessions.size).toBe(2);
      expect(mockSessions[0].disconnect).not.toHaveBeenCalled();
      expect(mockSessions[1].disconnect).not.toHaveBeenCalled();
    });

    it('evicts only sessions idle longer than 30min when RSS is over threshold', async () => {
      await adapter.start();
      const stale = await adapter.createSession({});
      const recent = await adapter.createSession({});

      const internals = adapter as unknown as AdapterInternals;
      // stale: idle 1 hour ago → eligible
      internals.lastActivityAt.set(stale.sessionId, Date.now() - 60 * 60_000);
      // recent: idle 1 minute ago → safe
      internals.lastActivityAt.set(recent.sessionId, Date.now() - 60_000);

      mockRuntimeRssMB(3000, 2); // 3 GB > 2 GB threshold

      await internals.evictIdleSessions();

      expect(mockSessions[0].disconnect).toHaveBeenCalled();
      expect(mockSessions[1].disconnect).not.toHaveBeenCalled();
      expect(internals.sessions.has(stale.sessionId)).toBe(false);
      expect(internals.sessions.has(recent.sessionId)).toBe(true);
    });

    it('does NOT evict a session with a pending permission, even if idle and over threshold', async () => {
      await adapter.start();
      const blocked = await adapter.createSession({});

      const internals = adapter as unknown as AdapterInternals;
      internals.lastActivityAt.set(blocked.sessionId, 0); // ancient
      // Simulate a pending permission so the session is mid-prompt
      internals.sessions.get(blocked.sessionId)!.pendingPermissions.set('perm-1', { resolve: () => {} });

      mockRuntimeRssMB(3000, 1);

      await internals.evictIdleSessions();

      expect(mockSessions[0].disconnect).not.toHaveBeenCalled();
      expect(internals.sessions.has(blocked.sessionId)).toBe(true);
    });

    it('does NOT evict a session currently mid-turn (turnHasOutput=true)', async () => {
      await adapter.start();
      const turning = await adapter.createSession({});

      const internals = adapter as unknown as AdapterInternals;
      internals.lastActivityAt.set(turning.sessionId, 0);
      internals.turnHasOutput.set(turning.sessionId, true);

      mockRuntimeRssMB(3000, 1);

      await internals.evictIdleSessions();

      expect(mockSessions[0].disconnect).not.toHaveBeenCalled();
      expect(internals.sessions.has(turning.sessionId)).toBe(true);
    });

    it('fires onSessionEvicted so relay-client can mark the session disconnected', async () => {
      const evictedSpy = vi.fn();
      adapter.onSessionEvicted = evictedSpy;

      await adapter.start();
      const s = await adapter.createSession({});

      const internals = adapter as unknown as AdapterInternals;
      internals.lastActivityAt.set(s.sessionId, 0);

      mockRuntimeRssMB(3000, 1);

      await internals.evictIdleSessions();

      expect(evictedSpy).toHaveBeenCalledWith(s.sessionId);
    });
  });
});
