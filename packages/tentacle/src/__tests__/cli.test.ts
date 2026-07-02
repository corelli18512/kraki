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
const mockIsDaemonRunning = vi.fn();
const mockGetDaemonStatus = vi.fn();
const mockStartDaemon = vi.fn();
const mockStopDaemon = vi.fn();
const mockRunSetup = vi.fn();
const mockStartWorker = vi.fn();

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
  getOrCreateDeviceId: vi.fn(() => 'dev_test'),
  saveGitHubToken: vi.fn(),
  loadGitHubToken: vi.fn(() => null),
  DEFAULT_LOG_VERBOSITY: 'normal',
}));

vi.mock('../daemon.js', () => ({
  INTERNAL_DAEMON_WORKER_COMMAND: '__daemon-worker',
  isDaemonRunning: (...args: unknown[]) => mockIsDaemonRunning(...args),
  getDaemonStatus: (...args: unknown[]) => mockGetDaemonStatus(...args),
  startDaemon: (...args: unknown[]) => mockStartDaemon(...args),
  stopDaemon: (...args: unknown[]) => mockStopDaemon(...args),
}));

vi.mock('../daemon-worker.js', () => ({
  startWorker: (...args: unknown[]) => mockStartWorker(...args),
}));

vi.mock('../banner.js', () => ({
  printAnimatedBanner: vi.fn(),
  printStaticBanner: vi.fn(),
}));

const mockResolveRelay = vi.fn();
vi.mock('../setup.js', () => ({
  runSetup: (...args: unknown[]) => mockRunSetup(...args),
  resolveRelay: (...args: unknown[]) => mockResolveRelay(...args),
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
let originalArgv: string[];
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

beforeEach(() => {
  vi.resetAllMocks();
  consoleOutput = [];
  stdoutOutput = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutOutput.push(String(chunk));
    return true;
  }) as never);
  originalArgv = process.argv;
  // Reset mock defaults
  mockGetConfigDir.mockReturnValue('/tmp/fake-kraki');
  mockGetConfigPath.mockReturnValue('/tmp/fake-kraki/config.json');
  mockGetKrakiHome.mockReturnValue('/tmp/fake-kraki');
  mockLoadChannelKey.mockReset();
  mockStartWorker.mockReset();
});

afterEach(() => {
  process.argv = originalArgv;
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

// ── --help ──────────────────────────────────────────────

describe('CLI --help', () => {
  it('prints help text', async () => {
    await runCli(['--help']);
    const output = consoleOutput.join('\n');
    expect(output).toContain('kraki');
    expect(output).toContain('Usage:');
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
    expect(consoleOutput.join('\n')).toContain('Usage:');
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
    expect(mockStartWorker).toHaveBeenCalled();
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
    expect(json.daemon).toEqual({ running: true, pid: 42 });
    expect(json.config.exists).toBe(true);
    expect(json.config.relay).toBe('wss://relay.test');
    expect(json.config.agents).toEqual(['claude']);
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
