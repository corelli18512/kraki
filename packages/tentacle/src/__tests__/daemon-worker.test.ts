/**
 * Unit tests for daemon-worker.ts — the background process.
 *
 * Tests startWorker() by mocking all dependencies:
 *  - config (loadConfig, loadChannelKey, getOrCreateDeviceId)
 *  - CopilotAdapter (start/stop)
 *  - RelayClient (connect/disconnect)
 *  - SessionManager
 *  - KeyManager
 *  - execSync (gh auth token)
 *  - logger (pino)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────

const mockAdapter = {
  start: vi.fn(),
  stop: vi.fn(),
  onSessionCreated: null as unknown as ((event: { sessionId: string; agent: string; model?: string }) => void) | null,
  onMessage: null as unknown as ((sessionId: string, event: { content: string }) => void) | null,
  onMessageDelta: null as unknown as ((sessionId: string, event: { content: string }) => void) | null,
  onPermissionRequest: null as unknown as ((sessionId: string, event: { id: string; toolArgs: unknown; description: string }) => void) | null,
  onQuestionRequest: null as unknown as ((sessionId: string, event: { id: string; question: string }) => void) | null,
  onToolStart: null as unknown as ((sessionId: string, event: { toolName: string; args: Record<string, unknown> }) => void) | null,
  onToolComplete: null as unknown as ((sessionId: string, event: { toolName: string; result: string }) => void) | null,
  onIdle: null as unknown as ((sessionId: string) => void) | null,
  onError: null as unknown as ((sessionId: string, event: { message: string }) => void) | null,
  onSessionEnded: null as unknown as ((sessionId: string, event: { reason: string }) => void) | null,
};

vi.mock('../adapters/copilot.js', () => ({
  CopilotAdapter: vi.fn().mockImplementation(() => mockAdapter),
}));

const mockRelay = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  onStateChange: null as ((state: string) => void) | null,
  onAuthenticated: null as ((info: Record<string, unknown>) => void) | null,
  onFatalError: null as ((message: string) => void) | null,
};

vi.mock('../relay-client.js', () => ({
  RelayClient: vi.fn().mockImplementation(() => mockRelay),
}));

vi.mock('../session-manager.js', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../key-manager.js', () => ({
  KeyManager: vi.fn().mockImplementation(() => ({})),
}));

const mockLoggerFns = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
};

vi.mock('../logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: (...args: unknown[]) => mockLoggerFns.info(...args),
    debug: (...args: unknown[]) => mockLoggerFns.debug(...args),
    warn: (...args: unknown[]) => mockLoggerFns.warn(...args),
    error: (...args: unknown[]) => mockLoggerFns.error(...args),
    fatal: (...args: unknown[]) => mockLoggerFns.fatal(...args),
  }),
}));

let mockConfig: Record<string, unknown> | null = null;
let mockChannelKey: string | null = null;

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
  loadChannelKey: vi.fn(() => mockChannelKey),
  loadGitHubToken: vi.fn(() => null),
  getOrCreateDeviceId: vi.fn(() => 'dev_test123'),
  getConfigPath: vi.fn(() => '/tmp/fake-kraki/config.json'),
  getChannelKeyPath: vi.fn(() => '/tmp/fake-kraki/channel.key'),
  getConfigDir: vi.fn(() => '/tmp/fake-kraki'),
  getVersion: vi.fn(() => '0.0.0-test'),
  saveDaemonPid: vi.fn(),
}));

let mockExecSyncReturn = 'fake-token\n';
let mockExecSyncThrow = false;

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    if (mockExecSyncThrow) throw new Error('gh not found');
    return mockExecSyncReturn;
  }),
}));

// Prevent process.exit from killing the test runner
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

// ── Import after mocking ────────────────────────────────

import { startWorker } from '../daemon-worker.js';

// ── Tests ───────────────────────────────────────────────

describe('daemon-worker: startWorker()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      relay: 'wss://kraki.corelli.cloud',
      authMethod: 'github_token',
      device: { name: 'test-machine' },
    };
    mockChannelKey = null;
    mockExecSyncReturn = 'fake-token\n';
    mockExecSyncThrow = false;
    mockExit.mockClear();
    delete process.env.GITHUB_TOKEN;
  });

  it('loads config, resolves gh token, starts adapter, connects relay', async () => {
    const { adapter, relay, shutdown } = await startWorker();

    expect(mockLoggerFns.info).toHaveBeenCalledWith(expect.stringContaining('Daemon starting'));
    expect(mockLoggerFns.debug).toHaveBeenCalledWith(expect.stringContaining('Resolved GitHub token'));
    expect(mockAdapter.start).toHaveBeenCalled();
    expect(mockRelay.connect).toHaveBeenCalled();
    expect(process.env.GITHUB_TOKEN).toBe('fake-token');

    await shutdown();
    expect(mockRelay.disconnect).toHaveBeenCalled();
    expect(mockAdapter.stop).toHaveBeenCalled();
  });

  it('exits if no config found', async () => {
    mockConfig = null;
    await startWorker().catch(() => {});
    expect(mockLoggerFns.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ configPath: '/tmp/fake-kraki/config.json' }),
      expect.stringContaining('No config found'),
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('warns when gh auth token fails and no saved token (github auth)', async () => {
    mockExecSyncThrow = true;
    await startWorker();
    expect(mockLoggerFns.warn).toHaveBeenCalledWith(expect.stringContaining('No GitHub token found'));
  });

  it('handles empty gh token by falling back to saved token', async () => {
    mockExecSyncReturn = '';
    await startWorker();
    // Falls through to loadGitHubToken which also returns null in tests
    expect(mockLoggerFns.warn).toHaveBeenCalledWith(expect.stringContaining('No GitHub token found'));
  });

  it('loads channel key for non-github auth', async () => {
    mockConfig.authMethod = 'open';
    mockChannelKey = 'my-secret-key';
    await startWorker();
    expect(mockLoggerFns.debug).toHaveBeenCalledWith(
      expect.objectContaining({ channelKeyPath: '/tmp/fake-kraki/channel.key' }),
      expect.stringContaining('Loaded channel key'),
    );
  });

  it('sets up relay state change and auth callbacks', async () => {
    await startWorker();
    expect(mockRelay.onStateChange).toBeTypeOf('function');
    expect(mockRelay.onAuthenticated).toBeTypeOf('function');
    expect(mockRelay.onFatalError).toBeTypeOf('function');
  });

  it('shutdown disconnects relay and stops adapter', async () => {
    const { shutdown } = await startWorker();
    await shutdown();
    expect(mockRelay.disconnect).toHaveBeenCalled();
    expect(mockAdapter.stop).toHaveBeenCalled();
    expect(mockLoggerFns.info).toHaveBeenCalledWith(expect.stringContaining('Shutting down'));
  });

  it('logs relay and device info on startup', async () => {
    await startWorker();
    expect(mockLoggerFns.info).toHaveBeenCalledWith(
      expect.objectContaining({ relay: 'wss://kraki.corelli.cloud', device: 'test-machine' }),
      expect.stringContaining('Daemon running'),
    );
  });

  it('returns all components for external access', async () => {
    const result = await startWorker();
    expect(result.adapter).toBeTruthy();
    expect(result.relay).toBeTruthy();
    expect(result.sessionManager).toBeTruthy();
    expect(result.shutdown).toBeTypeOf('function');
  });
});
