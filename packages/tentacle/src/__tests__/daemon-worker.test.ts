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
  updateAgentCapabilities: vi.fn(),
  updateAccountUsage: vi.fn(),
  setAccountUsageEnabled: vi.fn(),
  setAccountUsageRefresher: vi.fn(),
  usageHistoryReader: null as unknown,
};

const mockUsageMonitor = { start: vi.fn(), stop: vi.fn(), refresh: vi.fn(async () => {}), accounts: [], onChange: null as unknown };
vi.mock('../account-usage.js', () => ({
  AccountUsageMonitor: vi.fn().mockImplementation(() => mockUsageMonitor),
  UsageHistory: vi.fn().mockImplementation((path: string) => ({ path, load: vi.fn(() => []) })),
}));

vi.mock('../relay-client.js', () => ({
  RelayClient: vi.fn().mockImplementation(() => mockRelay),
}));

vi.mock('../session-manager.js', () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    getSessionsRoot: () => '/tmp/test-sessions',
    isSessionActive: () => false,
  })),
}));

vi.mock('../mcp/index.js', () => ({
  KrakiMcpServer: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({
      urlForSession: (sid: string) => `http://127.0.0.1:1234/mcp/${sid}`,
      tokenForSession: (sid: string) => `test-token-${sid}`,
      port: 1234,
      baseUrl: 'http://127.0.0.1:1234/mcp',
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../attachment-store.js', () => ({
  AttachmentStore: vi.fn().mockImplementation(() => ({
    put: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    read: vi.fn().mockReturnValue(null),
    stream: vi.fn(),
    removeSession: vi.fn(),
    gc: vi.fn().mockReturnValue(0),
  })),
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

const mockSaveDaemonPid = vi.fn();
const mockSaveDaemonReady = vi.fn();
const mockClearDaemonReady = vi.fn();
const mockClearDaemonIdentity = vi.fn();

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
  loadChannelKey: vi.fn(() => mockChannelKey),
  loadGitHubToken: vi.fn(() => mockSavedGitHubToken),
  getOrCreateDeviceId: vi.fn(() => 'dev_test123'),
  getConfigPath: vi.fn(() => '/tmp/fake-kraki/config.json'),
  getChannelKeyPath: vi.fn(() => '/tmp/fake-kraki/channel.key'),
  getConfigDir: vi.fn(() => '/tmp/fake-kraki'),
  getKrakiHome: vi.fn(() => '/tmp/fake-kraki'),
  getVersion: vi.fn(() => '0.0.0-test'),
  saveDaemonPid: (...args: unknown[]) => mockSaveDaemonPid(...args),
  saveDaemonReady: (...args: unknown[]) => mockSaveDaemonReady(...args),
  clearDaemonReady: (...args: unknown[]) => mockClearDaemonReady(...args),
  clearDaemonIdentity: (...args: unknown[]) => mockClearDaemonIdentity(...args),
}));

let mockSavedGitHubToken: string | null = 'fake-token';
let mockExecSyncReturn = 'gho_broad_gh_token\n';
let mockExecSyncThrow = false;

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => {
    if (mockExecSyncThrow) throw new Error('gh not found');
    return mockExecSyncReturn;
  }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
    setTimeout(() => cb(null), 0);
    const { EventEmitter } = require('node:events');
    return new EventEmitter();
  }),
}));

vi.mock('../checks.js', () => ({
  ensureWindowsSystemPath: vi.fn().mockReturnValue([]),
  ensureTccBundleRegistered: vi.fn(),
  cleanupStaleBundleEntries: vi.fn().mockReturnValue({ removed: [], kept: [] }),
  probeFda: vi.fn().mockResolvedValue('granted'),
}));

const mockHydrateLoginShellEnv = vi.fn(() => ({ source: 'shell', shell: '/bin/zsh', addedKeys: [] }));
vi.mock('../shell-env.js', () => ({
  hydrateLoginShellEnv: (...args: unknown[]) => mockHydrateLoginShellEnv(...(args as [])),
}));

let mockManagedBy: unknown = null;
vi.mock('../managed.js', () => ({
  isMacAppManagedWorker: (env: NodeJS.ProcessEnv = process.env) => env.KRAKI_MANAGED_BY === 'kraki-mac',
  loadManagedBy: () => mockManagedBy,
}));

const mockRetireCliLaunchdJob = vi.fn();
vi.mock('../daemon.js', () => ({
  retireCliLaunchdJob: () => mockRetireCliLaunchdJob(),
}));

let mockPlatform: string | null = null;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => (mockPlatform ?? actual.platform()) };
});

// Prevent process.exit from killing the test runner
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

// ── Import after mocking ────────────────────────────────

import { startWorker } from '../daemon-worker.js';

// ── Tests ───────────────────────────────────────────────

describe('daemon-worker: startWorker()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      relay: 'wss://relay.kraki.chat',
      authMethod: 'github_token',
      device: { name: 'test-machine' },
    };
    mockChannelKey = null;
    mockExecSyncReturn = 'fake-token\n';
    mockExecSyncThrow = false;
    mockExit.mockClear();
    delete process.env.GITHUB_TOKEN;
    delete process.env.__CFBundleIdentifier;
  });

  it('scrubs the Launch Services bundle variable before adapters can spawn children', async () => {
    process.env.__CFBundleIdentifier = 'chat.kraki.cli';

    const { shutdown } = await startWorker();

    expect(process.env.__CFBundleIdentifier).toBeUndefined();
    await shutdown();
  });

  it('as the Mac app daemon: hydrates the login-shell env and skips CLI Launch Services upkeep', async () => {
    const checks = await import('../checks.js');
    process.env.KRAKI_MANAGED_BY = 'kraki-mac';
    try {
      const { shutdown } = await startWorker();
      expect(mockHydrateLoginShellEnv).toHaveBeenCalledTimes(1);
      expect(checks.ensureTccBundleRegistered).not.toHaveBeenCalled();
      expect(checks.cleanupStaleBundleEntries).not.toHaveBeenCalled();
      await shutdown();
    } finally {
      delete process.env.KRAKI_MANAGED_BY;
    }
  });

  it('as a leftover CLI job while Kraki for Mac owns the daemon: retires itself', async () => {
    mockPlatform = 'darwin';
    mockManagedBy = { by: 'kraki-mac', label: 'chat.kraki.mac.tentacle' };
    try {
      await startWorker();
      expect(mockRetireCliLaunchdJob).toHaveBeenCalledTimes(1);
      expect(mockExit).toHaveBeenCalledWith(0);
      expect(mockRelay.connect).not.toHaveBeenCalled();
    } finally {
      mockPlatform = null;
      mockManagedBy = null;
    }
  });

  it('as the Mac app daemon: never retires itself because of its own marker', async () => {
    mockPlatform = 'darwin';
    mockManagedBy = { by: 'kraki-mac', label: 'chat.kraki.mac.tentacle' };
    process.env.KRAKI_MANAGED_BY = 'kraki-mac';
    try {
      const { shutdown } = await startWorker();
      expect(mockRetireCliLaunchdJob).not.toHaveBeenCalled();
      await shutdown();
    } finally {
      delete process.env.KRAKI_MANAGED_BY;
      mockPlatform = null;
      mockManagedBy = null;
    }
  });

  it('as the CLI daemon: keeps its environment and Launch Services upkeep', async () => {
    const { shutdown } = await startWorker();
    expect(mockHydrateLoginShellEnv).not.toHaveBeenCalled();
    await shutdown();
  });

  it('loads config, resolves the saved Kraki token, starts adapter, connects relay', async () => {
    const { adapter, relay, shutdown } = await startWorker();

    expect(mockLoggerFns.info).toHaveBeenCalledWith(expect.stringContaining('Daemon starting'));
    expect(mockLoggerFns.debug).toHaveBeenCalledWith(expect.stringContaining('Resolved GitHub token'));
    expect(mockAdapter.start).toHaveBeenCalled();
    expect(mockRelay.connect).toHaveBeenCalled();
    expect(mockSaveDaemonReady).toHaveBeenCalledWith(process.pid);
    // The relay token is never exported to agent children.
    expect(process.env.GITHUB_TOKEN).toBeUndefined();

    await shutdown();
    expect(mockClearDaemonReady).toHaveBeenCalled();
    expect(mockClearDaemonIdentity).toHaveBeenCalled();
    expect(mockRelay.disconnect).toHaveBeenCalled();
    expect(mockAdapter.stop).toHaveBeenCalled();
  });

  it('starts the read-only account usage monitor and forwards readings to the relay', async () => {
    await startWorker();
    expect(mockUsageMonitor.start).toHaveBeenCalled();
    (mockUsageMonitor.onChange as (a: unknown[]) => void)([{ accountKey: 'k' }]);
    expect(mockRelay.updateAccountUsage).toHaveBeenCalledWith([{ accountKey: 'k' }]);
    expect(typeof mockRelay.usageHistoryReader).toBe('function');
    expect(mockRelay.setAccountUsageEnabled).toHaveBeenCalledWith(true);
    const refresh = mockRelay.setAccountUsageRefresher.mock.calls.at(-1)?.[0];
    expect(await refresh()).toEqual(mockUsageMonitor.accounts);
    expect(mockUsageMonitor.refresh).toHaveBeenCalledOnce();
  });

  it('does not start the usage monitor when accountUsage.enabled is false', async () => {
    const { AccountUsageMonitor } = await import('../account-usage.js');
    (AccountUsageMonitor as unknown as ReturnType<typeof vi.fn>).mockClear();
    mockConfig = { ...(mockConfig ?? {}), accountUsage: { enabled: false } };
    await startWorker();
    expect(AccountUsageMonitor).not.toHaveBeenCalled();
    expect(mockRelay.setAccountUsageRefresher).not.toHaveBeenCalled();
  });

  it('re-greets apps when an agent reports its model list recovered after startup', async () => {
    const detail = { id: 'anthropic/opus', name: 'Anthropic opus' };
    const adapterWithModels = mockAdapter as typeof mockAdapter & {
      listModelDetails?: ReturnType<typeof vi.fn>;
      onCapabilitiesChanged?: (() => void) | null;
    };
    adapterWithModels.listModelDetails = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([detail]);
    try {
      const { shutdown } = await startWorker();
      mockRelay.updateAgentCapabilities.mockClear();
      expect(adapterWithModels.onCapabilitiesChanged).toBeTypeOf('function');

      adapterWithModels.onCapabilitiesChanged?.();
      await vi.waitFor(() => expect(mockRelay.updateAgentCapabilities).toHaveBeenCalledTimes(1));
      const [agents] = mockRelay.updateAgentCapabilities.mock.calls[0] as [{ id: string; models?: string[] }[]];
      expect(agents).toContainEqual(expect.objectContaining({ id: 'copilot', models: ['anthropic/opus'], modelDetails: [detail] }));
      await shutdown();
    } finally {
      delete adapterWithModels.listModelDetails;
    }
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

  it('never uses the GitHub CLI token; relies on challenge auth without a saved token', async () => {
    mockSavedGitHubToken = null;
    try {
      await startWorker();
      expect(mockLoggerFns.info).toHaveBeenCalledWith(expect.stringContaining('No saved GitHub token'));
      const { execSync } = await import('node:child_process');
      expect(vi.mocked(execSync).mock.calls.some(([cmd]) => String(cmd).includes('gh auth token'))).toBe(false);
    } finally {
      mockSavedGitHubToken = 'fake-token';
    }
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
      expect.objectContaining({ relay: 'wss://relay.kraki.chat', device: 'test-machine' }),
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
