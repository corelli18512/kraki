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
  onSessionCreated: null as any,
  onMessage: null as any,
  onMessageDelta: null as any,
  onPermissionRequest: null as any,
  onQuestionRequest: null as any,
  onToolStart: null as any,
  onToolComplete: null as any,
  onIdle: null as any,
  onError: null as any,
  onSessionEnded: null as any,
};

vi.mock('../adapters/copilot.js', () => ({
  CopilotAdapter: vi.fn().mockImplementation(() => mockAdapter),
}));

const mockRelay = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  onStateChange: null as any,
  onAuthenticated: null as any,
  onFatalError: null as any,
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
    info: (...args: any[]) => mockLoggerFns.info(...args),
    debug: (...args: any[]) => mockLoggerFns.debug(...args),
    warn: (...args: any[]) => mockLoggerFns.warn(...args),
    error: (...args: any[]) => mockLoggerFns.error(...args),
    fatal: (...args: any[]) => mockLoggerFns.fatal(...args),
  }),
}));

let mockConfig: any = null;
let mockChannelKey: string | null = null;

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
  loadChannelKey: vi.fn(() => mockChannelKey),
  getOrCreateDeviceId: vi.fn(() => 'dev_test123'),
  getConfigPath: vi.fn(() => '/tmp/fake-kraki/config.json'),
  getChannelKeyPath: vi.fn(() => '/tmp/fake-kraki/channel.key'),
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
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

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

  it('warns when gh auth token fails (github auth)', async () => {
    mockExecSyncThrow = true;
    await startWorker();
    expect(mockLoggerFns.warn).toHaveBeenCalledWith(expect.stringContaining('Could not resolve'));
  });

  it('handles empty gh token', async () => {
    mockExecSyncReturn = '';
    await startWorker();
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
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

  it('warns when channel key is missing', async () => {
    mockConfig.authMethod = 'open';
    mockChannelKey = null;
    await startWorker();
    expect(mockLoggerFns.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelKeyPath: '/tmp/fake-kraki/channel.key' }),
      expect.stringContaining('No channel key'),
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
