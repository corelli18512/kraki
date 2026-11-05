/**
 * Unit tests for cli.ts — CLI entry point with subcommands.
 *
 * Since cli.ts calls main() on import, we test the individual
 * command functions by re-importing with different argv mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Suppress the unhandled rejection from cli.ts's main().catch() handler.
// When we mock process.exit as a no-op, Vitest's own interceptor still fires
// asynchronously after the test completes; we catch and ignore that here.
const rejectionHandler = (reason: unknown) => {
  if (reason instanceof Error && reason.message.includes('process.exit')) return;
  throw reason;
};
process.on('unhandledRejection', rejectionHandler);
afterAll(() => {
  process.removeListener('unhandledRejection', rejectionHandler);
});

// ── Mocks ───────────────────────────────────────────────

const mockConfigExists = vi.fn();
const mockLoadConfig = vi.fn();
const mockSaveConfig = vi.fn();
const mockGetConfigDir = vi.fn().mockReturnValue('/tmp/fake-kraki');
const mockGetConfigPath = vi.fn().mockReturnValue('/tmp/fake-kraki/config.json');
const mockGetKrakiHome = vi.fn().mockReturnValue('/tmp/fake-kraki');
const mockLoadChannelKey = vi.fn();
const mockSaveChannelKey = vi.fn();
const mockIsDaemonRunning = vi.fn();
const mockGetDaemonStatus = vi.fn();
const mockStartDaemon = vi.fn();
const mockStopDaemon = vi.fn();
const mockRunSetup = vi.fn();
const mockShowPairingQr = vi.fn();
const mockStartWorker = vi.fn();
const mockPrepareDaemonWorkerBootstrap = vi.fn();
const mockRunDaemonReleaseSmoke = vi.fn();

vi.mock('../config.js', () => ({
  configExists: (...args: unknown[]) => mockConfigExists(...args),
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  getConfigDir: (...args: unknown[]) => mockGetConfigDir(...args),
  getConfigPath: (...args: unknown[]) => mockGetConfigPath(...args),
  getKrakiHome: (...args: unknown[]) => mockGetKrakiHome(...args),
  getLogVerbosity: vi.fn((config: Record<string, unknown> | null) => (config?.logging as Record<string, unknown> | undefined)?.verbosity ?? 'normal'),
  getVersion: vi.fn(() => '1.2.3'),
  loadChannelKey: (...args: unknown[]) => mockLoadChannelKey(...args),
  saveChannelKey: (...args: unknown[]) => mockSaveChannelKey(...args),
  getOrCreateDeviceId: vi.fn(() => 'dev_test'),
  saveGitHubToken: vi.fn(),
  loadGitHubToken: vi.fn(() => null),
  loadDaemonPid: vi.fn(() => null),
  loadDaemonIdentity: vi.fn(() => null),
  DEFAULT_LOG_VERBOSITY: 'normal',
}));

vi.mock('../daemon.js', () => ({
  INTERNAL_DAEMON_WORKER_COMMAND: '__daemon-worker',
  INTERNAL_DAEMON_SMOKE_COMMAND: '__daemon-release-smoke',
  prepareDaemonWorkerBootstrap: (...args: unknown[]) => mockPrepareDaemonWorkerBootstrap(...args),
  isDaemonRunning: (...args: unknown[]) => mockIsDaemonRunning(...args),
  getDaemonStatus: (...args: unknown[]) => mockGetDaemonStatus(...args),
  startDaemon: (...args: unknown[]) => mockStartDaemon(...args),
  runDaemonReleaseSmoke: (...args: unknown[]) => mockRunDaemonReleaseSmoke(...args),
  stopDaemon: (...args: unknown[]) => mockStopDaemon(...args),
  getCliLaunchdJobState: () => mockGetCliLaunchdJobState(),
}));

const mockGetCliLaunchdJobState = vi.fn();
const mockLoadManagedBy = vi.fn();
const mockKickstart = vi.fn();
const mockIsManagedLoaded = vi.fn();
vi.mock('../managed.js', () => ({
  loadManagedBy: () => mockLoadManagedBy(),
  kickstartManagedDaemon: (...args: unknown[]) => mockKickstart(...args),
  isManagedDaemonLoaded: (...args: unknown[]) => mockIsManagedLoaded(...args),
  isMacAppManagedWorker: () => false,
  isWindowsAppManagedWorker: () => false,
  ownerName: (by: string) => (by === 'kraki-windows' ? 'Kraki for Windows' : 'Kraki for Mac'),
  WINDOWS_APP_OWNER: 'kraki-windows',
}));

vi.mock('../daemon-worker.js', () => ({
  startWorker: (...args: unknown[]) => mockStartWorker(...args),
}));

vi.mock('../banner.js', () => ({
  printAnimatedBanner: vi.fn(),
  printStaticBanner: vi.fn(),
}));

const mockResolveRelay = vi.fn();
const mockRelayAuthToken = vi.fn();
vi.mock('../setup.js', () => ({
  runSetup: (...args: unknown[]) => mockRunSetup(...args),
  relayAuthToken: (...args: unknown[]) => mockRelayAuthToken(...args),
  resolveRelay: (...args: unknown[]) => mockResolveRelay(...args),
  showPairingQr: (...args: unknown[]) => mockShowPairingQr(...args),
}));

const mockUnsupportedProxy = vi.fn<() => string | null>(() => null);
vi.mock('../proxy.js', async () => ({
  ...await vi.importActual<typeof import('../proxy.js')>('../proxy.js'),
  unsupportedProxy: () => mockUnsupportedProxy(),
}));

const mockRunSetupJson = vi.fn();
vi.mock('../setup-json.js', () => ({
  runSetupJson: (...args: unknown[]) => mockRunSetupJson(...args),
}));

vi.mock('../update.js', () => ({
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));

const mockSelect = vi.fn();
vi.mock('@inquirer/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: vi.fn(),
}));

// Mock chalk — returns strings through, handles .rgb()/.hex()/.bold etc chaining
vi.mock("chalk", () => {
  let lastStr = '';
  const p: unknown = new Proxy(function(){}, {
    get: (_t: unknown, prop: string | symbol) => {
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => lastStr;
      return p;
    },
    apply: (_t: unknown, _this: unknown, args: unknown[]) => {
      if (args.length >= 1 && typeof args[0] === 'string') lastStr = args[0];
      return p;
    },
  });
  return { default: p };
});

// Mock node:fs readFileSync so getVersion() works
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...rest: unknown[]) => {
      if (typeof path === 'string' && path.includes('package.json')) {
        return JSON.stringify({ version: '1.2.3' });
      }
      return actual.readFileSync(path, ...rest);
    }),
    existsSync: vi.fn(() => false),
  };
});

// Capture console output
let consoleOutput: string[];
let stdoutOutput: string[];
let stderrOutput: string[];
let originalArgv: string[];
let originalMetaFile: string | undefined;
let originalInstallMode: string | undefined;
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

beforeEach(() => {
  vi.resetAllMocks();
  consoleOutput = [];
  stdoutOutput = [];
  stderrOutput = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    stdoutOutput.push(String(chunk));
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrOutput.push(String(chunk));
    return true;
  }) as never);
  originalArgv = process.argv;
  originalMetaFile = process.env.KRAKI_META_FILE;
  originalInstallMode = process.env.KRAKI_INSTALL;
  delete process.env.KRAKI_META_FILE;
  delete process.env.KRAKI_INSTALL;
  // Reset mock defaults
  mockGetConfigDir.mockReturnValue('/tmp/fake-kraki');
  mockGetConfigPath.mockReturnValue('/tmp/fake-kraki/config.json');
  mockGetKrakiHome.mockReturnValue('/tmp/fake-kraki');
  mockLoadChannelKey.mockReset();
  mockStartWorker.mockReset();
  mockLoadManagedBy.mockReturnValue(null);
  mockGetCliLaunchdJobState.mockReturnValue({ label: 'cloud.corelli.kraki', plistExists: false, loaded: false });
});

afterEach(() => {
  process.exitCode = undefined;
  process.argv = originalArgv;
  if (originalMetaFile === undefined) delete process.env.KRAKI_META_FILE;
  else process.env.KRAKI_META_FILE = originalMetaFile;
  if (originalInstallMode === undefined) delete process.env.KRAKI_INSTALL;
  else process.env.KRAKI_INSTALL = originalInstallMode;
});

/**
 * Helper: set process.argv and import cli.ts fresh.
 * The module calls main() on import, so we await the module load
 * and catch any process.exit throws.
 */
async function runCli(args: string[]): Promise<void> {
  process.argv = ['node', 'cli.js', ...args];
  vi.resetModules();
  try {
    await import('../cli.js');
    // Give the async main() a tick to complete
    await new Promise((r) => setTimeout(r, 50));
  } catch {
    // Swallow process.exit throws and any other import-time errors
  }
}

describe('CLI build-info', () => {
  it('prints machine-readable local build information without starting a daemon', async () => {
    await runCli(['build-info', '--json']);
    // The command lazy-loads its module. Under full-suite load a fixed 50 ms
    // sleep is not a completion signal; wait for the actual JSON response.
    const info = await vi.waitFor(() => JSON.parse(consoleOutput.join('\n')));
    expect(info.channel).toBe('local');
    expect(info.platform).toBe(process.platform);
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(mockRunSetup).not.toHaveBeenCalled();
  });
});

// ── --help ──────────────────────────────────────────────

describe('CLI --help', () => {
  it('prints help text', async () => {
    await runCli(['--help']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('kraki');
    expect(output).toContain('Get started');
    expect(output).toContain('stop');
    expect(output).toContain('status');
  });

  it('documents the new multi-agent / headless commands', async () => {
    await runCli(['--help']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('resolve-relay');
    expect(output).toContain('fda');
    expect(output).toContain('--agent');
    expect(output).toContain('status --json');
  });

  it('-h also prints help', async () => {
    await runCli(['-h']);
    expect(consoleOutput.join('\n')).toContain('Get started');
  });
});

// ── --version ───────────────────────────────────────────

describe('CLI --version', () => {
  it('prints the version number', async () => {
    await runCli(['--version']);
    expect(consoleOutput.join('\n')).toContain('1.2.3');
  });

  it('-v also prints version', async () => {
    await runCli(['-v']);
    expect(consoleOutput.join('\n')).toContain('1.2.3');
  });
});

describe('CLI internal daemon worker', () => {
  it('runs the hidden daemon worker command', async () => {
    await runCli(['__daemon-worker']);
    expect(mockPrepareDaemonWorkerBootstrap).toHaveBeenCalledOnce();
    expect(mockStartWorker).toHaveBeenCalled();
  });

  it('runs the hidden release smoke through the real daemon manager without pairing', async () => {
    const config = { relay: 'ws://127.0.0.1:1', authMethod: 'open', device: { name: 'smoke' } };
    mockLoadConfig.mockReturnValue(config);
    mockRunDaemonReleaseSmoke.mockResolvedValue(4567);

    await runCli(['__daemon-release-smoke']);

    expect(mockRunDaemonReleaseSmoke).toHaveBeenCalledWith(config);
    expect(mockShowPairingQr).not.toHaveBeenCalled();
    expect(stdoutOutput.join('')).toContain('daemon-release-smoke-ok pid=4567');
  });
});

// ── stop ────────────────────────────────────────────────

describe('CLI stop', () => {
  it('calls stopDaemon when daemon is running', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockStopDaemon.mockReturnValue(true);
    await runCli(['stop']);
    expect(mockStopDaemon).toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('stopped');
  });

  it('prints message when daemon is not running', async () => {
    mockIsDaemonRunning.mockReturnValue(false);
    await runCli(['stop']);
    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('not running');
  });

  it('prints failure message when stopDaemon returns false', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockStopDaemon.mockReturnValue(false);
    await runCli(['stop']);
    expect(consoleOutput.join('\n')).toContain('Failed');
  });

  it('exits non-zero when the daemon could not be stopped (K-267)', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockStopDaemon.mockReturnValue(false);
    await runCli(['stop']);
    expect(process.exitCode).toBe(1);
  });
});

describe('CLI install mode', () => {
  it('finishes setup without starting a worker or issuing a pairing token', async () => {
    process.env.KRAKI_INSTALL = '1';
    mockLoadConfig.mockReturnValue({
      relay: 'wss://relay.test',
      authMethod: 'github',
      device: { name: 'laptop' },
    });

    await runCli(['start']);

    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(mockStartWorker).not.toHaveBeenCalled();
    expect(mockShowPairingQr).not.toHaveBeenCalled();
  });
});

describe('CLI restart', () => {
  it('exits non-zero without a config (K-267)', async () => {
    mockLoadConfig.mockReturnValue(null);
    await runCli(['restart']);
    expect(consoleOutput.join('\n')).toContain('no config found');
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('starts from existing config when the daemon is stopped', async () => {
    const config = { relay: 'wss://relay.test', authMethod: 'github', device: { name: 'laptop' } };
    mockLoadConfig.mockReturnValue(config);
    mockGetDaemonStatus.mockReturnValue({ running: false, pid: null });
    mockStartDaemon.mockResolvedValue(1234);

    await runCli(['restart']);

    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(mockStartDaemon).toHaveBeenCalledWith(config);
  });

  it('reports a background start failure and never runs the worker in the CLI process', async () => {
    const config = { relay: 'wss://relay.test', authMethod: 'github', device: { name: 'laptop' } };
    mockLoadConfig.mockReturnValue(config);
    mockGetDaemonStatus.mockReturnValue({ running: false, pid: null });
    mockStartDaemon.mockRejectedValue(new Error('background launch failed'));

    await runCli(['restart']);

    expect(mockStartDaemon).toHaveBeenCalledWith(config);
    expect(mockStartWorker).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('✖ background launch failed');
    expect(consoleOutput.join('\n')).toContain('background launch failed');
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('stops a running daemon before starting it again', async () => {
    const config = { relay: 'wss://relay.test', authMethod: 'github', device: { name: 'laptop' } };
    mockLoadConfig.mockReturnValue(config);
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 999_999_999 });
    mockStopDaemon.mockReturnValue(true);
    mockStartDaemon.mockResolvedValue(1234);

    await runCli(['restart']);

    expect(mockStopDaemon).toHaveBeenCalledOnce();
    expect(mockStartDaemon).toHaveBeenCalledWith(config);
  });
});

describe('CLI agent-session self-management guard', () => {
  for (const command of ['stop', 'restart', 'update']) {
    it(`denies kraki ${command} from an agent session with a reason`, async () => {
      process.env.KRAKI_META_FILE = '/tmp/session/.pi-adapter.json';
      await runCli([command]);

      expect(stderrOutput.join('')).toContain('would terminate the tentacle hosting this session');
      expect(mockStopDaemon).not.toHaveBeenCalled();
      expect(mockStartDaemon).not.toHaveBeenCalled();
    });
  }
});

// ── status ──────────────────────────────────────────────

describe('CLI status', () => {
  it('shows running status with config', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 42 });
    mockLoadConfig.mockReturnValue({
      relay: 'wss://relay.test',
      authMethod: 'github',
      device: { name: 'laptop' },
      logging: { verbosity: 'normal' },
    });
    await runCli(['status']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('running');
    expect(output).toContain('42');
    expect(output).toContain('relay.test');
    expect(output).toContain('normal');
  });

  it('warns about a PAC or SOCKS proxy Kraki cannot use (K-328)', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: false, pid: null });
    mockLoadConfig.mockReturnValue(null);
    mockUnsupportedProxy.mockReturnValue('SOCKS proxy (ALL_PROXY)');
    await runCli(['status']);
    expect(consoleOutput.join('\n')).toContain('SOCKS proxy (ALL_PROXY), which Kraki cannot use');
    consoleOutput = [];
    stdoutOutput = [];
    await runCli(['status', '--json']);
    expect(JSON.parse(stdoutOutput.join('').trim()).unsupportedProxy).toBe('SOCKS proxy (ALL_PROXY)');
  });

  it('shows stopped status when no daemon', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: false, pid: null });
    mockLoadConfig.mockReturnValue(null);
    await runCli(['status']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('stopped');
  });

  it('emits machine-readable JSON with --json', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 42 });
    mockLoadConfig.mockReturnValue({
      relay: 'wss://relay.test',
      authMethod: 'github_token',
      device: { name: 'laptop', id: 'dev_1' },
      agents: ['claude'],
      logging: { verbosity: 'normal' },
    });
    await runCli(['status', '--json']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.ok).toBe(true);
    expect(json.daemon).toMatchObject({ running: true, pid: 42, owner: null, managedLabel: null });
    expect(json.config.exists).toBe(true);
    expect(json.config.relay).toBe('wss://relay.test');
    expect(json.config.agents).toEqual(['claude']);
  });
});

// ── Ownership by Kraki for Mac ──────────────────────────

describe('CLI when the daemon is managed by Kraki for Mac', () => {
  const marker = { by: 'kraki-mac', label: 'chat.kraki.mac.tentacle', appPath: '/Applications/Kraki.app', updatedAt: '' };
  const config = {
    relay: 'wss://relay.test',
    authMethod: 'github_token',
    device: { name: 'laptop', id: 'dev_1' },
  };

  beforeEach(() => {
    mockLoadManagedBy.mockReturnValue(marker);
    mockLoadConfig.mockReturnValue(config);
  });

  it('start never installs a second launchd job', async () => {
    mockIsDaemonRunning.mockReturnValue(false);
    mockGetDaemonStatus.mockReturnValue({ running: false, pid: null });
    await runCli(['start']);
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('managed by Kraki for Mac');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('start while the app runs Kraki says the app manages it', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 77 });
    await runCli(['start']);
    expect(mockStartDaemon).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('managed by Kraki for Mac');
  });

  it('stop refuses instead of signalling a KeepAlive job', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 77 });
    await runCli(['stop']);
    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('Login Items');
    process.exitCode = 0;
  });

  it('restart kickstarts the Mac app job in place', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 77 });
    mockIsManagedLoaded.mockReturnValue(true);
    mockKickstart.mockReturnValue(true);
    await runCli(['restart']);
    expect(mockKickstart).toHaveBeenCalledWith('chat.kraki.mac.tentacle');
    expect(mockStopDaemon).not.toHaveBeenCalled();
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('update defers to the Mac app', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 77 });
    await runCli(['update']);
    expect(consoleOutput.join('\n')).toContain('Check for Updates');
    process.exitCode = 0;
  });

  it('status --json reports the Mac app as owner', async () => {
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 77 });
    await runCli(['status', '--json']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.daemon).toMatchObject({ owner: 'kraki-mac', managedLabel: 'chat.kraki.mac.tentacle' });
  });
});

// ── resolve-relay ───────────────────────────────────────

describe('CLI resolve-relay', () => {
  it('prints resolved relay as JSON', async () => {
    mockResolveRelay.mockResolvedValue({
      ok: true,
      relayUrl: 'wss://kraki-us.example',
      region: 'us',
      user: 'octocat',
    });
    await runCli(['resolve-relay', '--json', '--github-token', 'tok123']);
    expect(mockResolveRelay).toHaveBeenCalledWith('tok123');
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json).toMatchObject({
      ok: true,
      relayUrl: 'wss://kraki-us.example',
      region: 'us',
      user: 'octocat',
    });
  });

  it('exits non-zero on resolve failure', async () => {
    mockResolveRelay.mockResolvedValue({
      ok: false,
      relayUrl: 'wss://relay.kraki.chat',
      fallback: true,
      error: 'network error',
    });
    await runCli(['resolve-relay', '--json', '--github-token', 'tok']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.ok).toBe(false);
    expect(json.fallback).toBe(true);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('CLI connect (interactive)', () => {
  it('exits non-zero when the pairing token cannot be created (K-267)', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockLoadConfig.mockReturnValue({ relay: 'wss://relay.test', authMethod: 'open', device: { name: 'x' } });
    mockRelayAuthToken.mockRejectedValue(new Error('relay down'));
    await runCli(['connect']);
    await vi.waitFor(() => expect(consoleOutput.join('\n')).toContain('relay down'));
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('exits non-zero when the daemon runs without a config (K-267)', async () => {
    mockIsDaemonRunning.mockReturnValue(true);
    mockLoadConfig.mockReturnValue(null);
    await runCli(['connect']);
    expect(consoleOutput.join('\n')).toContain('No config found');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('CLI auth', () => {
  it('names github.com when GitHub cannot be reached (K-324)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })) as typeof fetch;
    try {
      await runCli(['auth', '--client-id', 'cid']);
      await vi.waitFor(() => expect(stderrOutput.join('')).toContain('Could not reach github.com (ENOTFOUND)'));
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('CLI relay-info', () => {
  it('exits non-zero when the relay cannot be reached (K-267)', async () => {
    // A port that was just freed: the connection is refused.
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    await runCli(['relay-info', `ws://127.0.0.1:${port}`]);
    await vi.waitFor(() => expect(stdoutOutput.join('')).toContain('"ok":false'), { timeout: 6000 });
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});

describe('CLI setup --json', () => {
  it('exits with the setup result once its last event is written, even while stdin stays open (K-273)', async () => {
    mockRunSetupJson.mockResolvedValue(1);
    await runCli(['setup', '--json', '--oauth']);
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(1));
  });

  it('exits 0 after a successful setup', async () => {
    mockRunSetupJson.mockResolvedValue(0);
    await runCli(['setup', '--json']);
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(0));
  });
});

// ── setup --headless ────────────────────────────────────

describe('CLI setup --headless', () => {
  it('errors as JSON when --relay is missing', async () => {
    await runCli(['setup', '--headless']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json).toEqual({ ok: false, error: '--relay is required', code: 'missing_relay' });
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('rejects an invalid --agent value', async () => {
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--agent', 'bogus']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.ok).toBe(false);
    expect(json.code).toBe('bad_agent');
  });

  it('writes config and pins the chosen agent', async () => {
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--agent', 'claude', '--device-name', 'box']);
    expect(mockSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        relay: 'wss://r',
        agents: ['claude'],
        device: expect.objectContaining({ name: 'box' }),
      }),
    );
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.ok).toBe(true);
    expect(json.agents).toEqual(['claude']);
  });

  it('accepts --agent pi (K-272)', async () => {
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--agent', 'pi']);
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ agents: ['pi'] }));
    expect(JSON.parse(stdoutOutput.join('').trim()).ok).toBe(true);
  });

  it('rejects an unknown --auth without saving a config (K-272)', async () => {
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--auth', 'bogus']);
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json).toMatchObject({ ok: false, code: 'bad_auth' });
    expect(mockSaveConfig).not.toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  for (const relay of ['https://relay.example', 'wss://', 'wss://relay example', 'ws:// ']) {
    it(`rejects --relay "${relay}" without saving a config (K-272)`, async () => {
      await runCli(['setup', '--headless', '--relay', relay]);
      const json = JSON.parse(stdoutOutput.join('').trim());
      expect(json).toMatchObject({ ok: false, code: 'bad_relay' });
      expect(mockSaveConfig).not.toHaveBeenCalled();
    });
  }

  it('treats a bare relay host as wss:// like the wizard (K-272)', async () => {
    await runCli(['setup', '--headless', '--relay', ' relay.example:4000 ']);
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ relay: 'wss://relay.example:4000' }));
  });

  it('saves --api-key as the channel key for an API-key relay (K-126/K-272)', async () => {
    await runCli(['setup', '--headless', '--relay', 'ws://127.0.0.1:4000', '--auth', 'apikey', '--api-key', 'sekret']);
    expect(mockSaveChannelKey).toHaveBeenCalledWith('sekret');
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'apikey', relay: 'ws://127.0.0.1:4000' }));
  });

  it('refuses --auth apikey with no key (K-272)', async () => {
    mockLoadChannelKey.mockReturnValue(null);
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--auth', 'apikey']);
    expect(JSON.parse(stdoutOutput.join('').trim())).toMatchObject({ ok: false, code: 'missing_api_key' });
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it('omits agents (auto) when --agent is auto', async () => {
    await runCli(['setup', '--headless', '--relay', 'wss://r', '--agent', 'auto']);
    const cfg = mockSaveConfig.mock.calls[0][0];
    expect(cfg.agents).toBeUndefined();
    const json = JSON.parse(stdoutOutput.join('').trim());
    expect(json.agents).toBe('auto');
  });
});

// ── logs ────────────────────────────────────────────────

describe('CLI logs', () => {
  it('prints message when no log directory exists', async () => {
    // existsSync is already mocked to return false
    await runCli(['logs']);
    expect(consoleOutput.join('\n')).toContain('No log directory');
  });
});

// ── config ──────────────────────────────────────────────

describe('CLI config', () => {
  it('prints config JSON when config exists', async () => {
    const cfg = { relay: 'wss://relay.test', authMethod: 'github', device: { name: 'x' }, logging: { verbosity: 'normal' } };
    mockLoadConfig.mockReturnValue(cfg);
    await runCli(['config']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('relay.test');
    expect(output).toContain('github');
  });

  it('prints message when no config', async () => {
    mockLoadConfig.mockReturnValue(null);
    await runCli(['config']);
    expect(consoleOutput.join('\n')).toContain('No config found');
  });

  for (const args of [['config'], ['config', 'log'], ['config', 'remote-update', 'on']]) {
    it(`kraki ${args.join(' ')} exits non-zero without a config (K-267)`, async () => {
      mockLoadConfig.mockReturnValue(null);
      await runCli(args);
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockSaveConfig).not.toHaveBeenCalled();
    });
  }

  it('shows current log verbosity', async () => {
    mockLoadConfig.mockReturnValue({
      relay: 'wss://relay.test',
      authMethod: 'github',
      device: { name: 'x' },
      logging: { verbosity: 'normal' },
    });
    await runCli(['config', 'log']);
    expect(consoleOutput.join('\n')).toContain('Log verbosity: normal');
  });

  it('updates log verbosity', async () => {
    mockLoadConfig.mockReturnValue({
      relay: 'wss://relay.test',
      authMethod: 'github',
      device: { name: 'x' },
      logging: { verbosity: 'normal' },
    });
    await runCli(['config', 'log', 'verbose']);
    expect(mockSaveConfig).toHaveBeenCalledWith({
      relay: 'wss://relay.test',
      authMethod: 'github',
      device: { name: 'x' },
      logging: { verbosity: 'verbose' },
    });
    expect(consoleOutput.join('\n')).toContain('Log verbosity set to verbose');
  });
});

// ── config reset ────────────────────────────────────────

describe('CLI config reset', () => {
  it('deletes config and runs setup', async () => {
    mockRunSetup.mockResolvedValue({ relay: 'wss://new', authMethod: 'github', device: { name: 'n' } });
    await runCli(['config', 'reset']);
    expect(mockRunSetup).toHaveBeenCalled();
  });
});

// ── default (no args) ───────────────────────────────────

describe('CLI default (no args)', () => {
  const cancelled = () => Object.assign(new Error('User force closed the prompt'), { name: 'ExitPromptError' });

  it('exits 130 when install.sh setup is cancelled, so the installer does not start Kraki (K-276)', async () => {
    process.env.KRAKI_INSTALL = '1';
    mockLoadConfig.mockReturnValue(null);
    mockRunSetup.mockRejectedValue(cancelled());
    await runCli([]);
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(130));
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });

  it('tells Linux users Kraki does not come back by itself after a restart (K-276)', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      mockLoadConfig.mockReturnValue({ relay: 'wss://r', authMethod: 'github', device: { name: 'x' } });
      mockIsDaemonRunning.mockReturnValue(false);
      mockStartDaemon.mockResolvedValue(99);
      await runCli(['start']);
      await vi.waitFor(() => expect(consoleOutput.join('\n')).toContain('After a restart, run'));
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('still exits 0 when an interactive prompt is cancelled outside the installer', async () => {
    mockLoadConfig.mockReturnValue(null);
    mockRunSetup.mockRejectedValue(cancelled());
    await runCli([]);
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(0));
  });

  it('starts daemon when config exists and daemon not running', async () => {
    mockLoadConfig.mockReturnValue({
      relay: 'wss://r',
      authMethod: 'github',
      device: { name: 'x' },
      logging: { verbosity: 'normal' },
    });
    mockIsDaemonRunning.mockReturnValue(false);
    mockStartDaemon.mockReturnValue(99);
    await runCli([]);
    expect(mockStartDaemon).toHaveBeenCalled();
    expect(consoleOutput.join('\n')).toContain('99');
  });

  it('runs setup when no config exists', async () => {
    mockLoadConfig
      .mockReturnValueOnce(null)   // first call in cmdStart: loadConfig()
      .mockReturnValueOnce(null);  // possibly called again
    mockRunSetup.mockResolvedValue({
      relay: 'wss://r',
      authMethod: 'github',
      device: { name: 'x' },
      logging: { verbosity: 'normal' },
    });
    mockIsDaemonRunning.mockReturnValue(false);
    mockStartDaemon.mockReturnValue(77);
    await runCli([]);
    expect(mockRunSetup).toHaveBeenCalled();
  });

  it('shows QR when daemon already running', async () => {
    mockLoadConfig.mockReturnValue({
      relay: 'wss://r',
      authMethod: 'github_token',
      device: { name: 'x' },
      logging: { verbosity: 'normal' },
    });
    mockIsDaemonRunning.mockReturnValue(true);
    mockGetDaemonStatus.mockReturnValue({ running: true, pid: 55 });

    await runCli([]);
    expect(consoleOutput.join('\n')).toContain('already running');
    expect(mockStartDaemon).not.toHaveBeenCalled();
  });
});

// ── unknown command ─────────────────────────────────────

describe('CLI unknown command', () => {
  it('prints error and help for unknown commands', async () => {
    await runCli(['nonexistent']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('Unknown command');
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
