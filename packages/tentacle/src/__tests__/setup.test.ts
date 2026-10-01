
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSelect = vi.fn();
const mockInput = vi.fn();
const mockCheckbox = vi.fn();
const mockConfirm = vi.fn();
const mockPassword = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: (...args: unknown[]) => mockInput(...args),
  checkbox: (...args: unknown[]) => mockCheckbox(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  password: (...args: unknown[]) => mockPassword(...args),
}));

vi.mock("ora", () => {
  const instance = { start: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), warn: vi.fn().mockReturnThis(), info: vi.fn().mockReturnThis() };
  const fn = Object.assign(vi.fn(() => instance), { __instance: instance });
  return { default: fn };
});

let mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];

vi.mock("ws", () => {
  const MockWS = vi.fn().mockImplementation(() => {
    const handlers: Record<string, Function> = {};
    return {
      on: (event: string, cb: Function) => {
        handlers[event] = cb;
        if (event === 'open') setTimeout(() => handlers['open']?.(), 10);
      },
      send: (data: string) => {
        const msg = JSON.parse(data);
        if (msg.type === 'auth_info' && handlers['message']) {
          setTimeout(() => {
            handlers['message'](JSON.stringify({
              type: 'auth_info_response',
              methods: mockRelayMethods,
            }));
          }, 5);
        }
      },
      close: vi.fn(),
    };
  });
  return { WebSocket: MockWS };
});

const mockExecSync = vi.fn();
const mockSpawn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: (...a: unknown[]) => mockExecSync(...a), spawn: (...a: unknown[]) => mockSpawn(...a) };
});

let mockMacApp: string | null = null;
vi.mock("../managed.js", () => ({
  findMacAppWithBuiltIn: () => mockMacApp,
}));

let mockPlatform: string | null = null;
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => (mockPlatform ?? actual.platform()) };
});

vi.mock("../banner.js", () => ({
  printAnimatedBanner: vi.fn(),
  printStaticBanner: vi.fn(),
}));

vi.mock("chalk", () => {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    get: (_t, prop) => (prop === 'hex' || prop === 'bgHex' ? () => proxy : proxy),
    apply: (_target, _thisArg, args) => {
      if (args.length === 1 && typeof args[0] === "string") return args[0];
      return proxy;
    },
  };
  const proxy: unknown = new Proxy(function(){} as (...args: unknown[]) => unknown, handler);
  return { default: proxy };
});

const mockSaveConfig = vi.fn();
const mockSaveChannelKey = vi.fn();
vi.mock("../config.js", () => ({
  DEFAULT_LOG_VERBOSITY: "normal",
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  saveChannelKey: (...args: unknown[]) => mockSaveChannelKey(...args),
  getOrCreateDeviceId: () => "dev_test123",
  getConfigPath: () => "/tmp/fake-kraki/config.json",
  getConfigDir: () => "/tmp/fake-kraki",
  loadChannelKey: () => null,
  loadConfig: () => mockExistingConfig,
  saveGitHubToken: vi.fn(),
}));

let mockExistingConfig: unknown = null;

const mockCheckGhAuth = vi.fn().mockReturnValue({ authenticated: true, username: 'testuser', token: 'fake-token' });
vi.mock("../checks.js", () => ({
  checkGhAuth: (...args: unknown[]) => mockCheckGhAuth(...args),
  SETUP_AGENTS: [
    { id: 'claude', name: 'Claude Code', bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup' },
    { id: 'codex', name: 'Codex', bin: 'codex', installUrl: 'https://developers.openai.com/codex/cli' },
    { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', installUrl: 'https://github.com/features/copilot/cli' },
    { id: 'pi', name: 'Pi', bin: 'pi', installUrl: 'https://github.com/earendil-works/pi#readme' },
  ],
  probeFda: vi.fn().mockResolvedValue('granted'),
  probeFdaAsApp: vi.fn().mockResolvedValue('granted'),
  pollFda: vi.fn().mockResolvedValue('granted'),
  ensureTccBundleRegistered: vi.fn(),
  openTccPane: vi.fn(),
  revealKrakiApp: vi.fn(),
  getKrakiAppBundlePath: vi.fn().mockReturnValue(null),
}));

// Agent check (normally `kraki agents --json` in a child process)
type Check = { id: string; name: string; status: string; models: number; sampleModels: string[]; installUrl: string; hint?: string };
const agent = (id: string, status: string, models = 3): Check => ({ id, name: id, status, models, sampleModels: [], installUrl: '' });
let agentRounds: Check[][] = [];
const mockAgentsCheck = vi.fn(async () => (agentRounds.length > 1 ? agentRounds.shift() : agentRounds[0]) ?? []);
vi.mock("../agents-check.js", () => ({
  runAgentsCheckChild: () => mockAgentsCheck(),
}));

// Mock pair module to avoid real WebSocket connection
vi.mock("../pair.js", () => ({
  requestPairingToken: vi.fn().mockRejectedValue(new Error("no relay")),
  buildPairingUrl: vi.fn().mockReturnValue("https://app.kraki.chat?token=test"),
  renderQrToTerminal: vi.fn().mockResolvedValue("[QR CODE]"),
}));

import { runSetup } from "../setup.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  agentRounds = [[agent('copilot', 'ready')]];
  mockExistingConfig = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  originalFetch = globalThis.fetch;
  // Remove KRAKI_RELAY_URL so login-first flow is used by default
  delete process.env.KRAKI_RELAY_URL;
  delete process.env.KRAKI_API_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.KRAKI_RELAY_URL;
  delete process.env.KRAKI_API_URL;
});

function mockOfficialApi(region = 'us', relayUrl = 'wss://kraki-us.corelli.cloud') {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/api/login/resolve')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, region, relayUrl, user: { login: 'testuser' } }) });
    }
    if (typeof url === 'string' && url.includes('/api/config')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ githubClientId: 'test-client-id' }) });
    }
    return Promise.reject(new Error(`unmocked fetch: ${url}`));
  }) as typeof fetch;
}

describe("runSetup — official service (same steps as Kraki for Mac)", () => {
  it("checks agents, signs in, resolves the region's relay and saves — no prompts when all is ready", async () => {
    mockOfficialApi();
    const result = await runSetup();
    expect(result).toEqual({
      relay: "wss://kraki-us.corelli.cloud",
      authMethod: "github_token",
      device: { name: expect.any(String), id: "dev_test123" },
      logging: { verbosity: "normal" },
    });
    expect(mockAgentsCheck).toHaveBeenCalledTimes(1);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockInput).not.toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalledWith(result);
  });

  it("checks agents before signing in", async () => {
    mockOfficialApi();
    const order: string[] = [];
    mockAgentsCheck.mockImplementationOnce(async () => { order.push('agents'); return [agent('codex', 'ready')]; });
    mockCheckGhAuth.mockImplementationOnce(() => { order.push('signin'); return { authenticated: true, username: 'u', token: 't' }; });
    await runSetup();
    expect(order).toEqual(['agents', 'signin']);
  });

  it("keeps the device name of an existing setup", async () => {
    mockOfficialApi();
    mockExistingConfig = { device: { name: 'studio', id: 'dev_old' }, logging: { verbosity: 'verbose' } };
    const result = await runSetup();
    expect(result.device.name).toBe('studio');
    expect(result.logging).toEqual({ verbosity: 'verbose' });
  });

  it("falls back to the default relay if the API is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as typeof fetch;
    const result = await runSetup();
    expect(result.relay).toBe("wss://relay.kraki.chat");
    expect(result.authMethod).toBe("github_token");
  });

  it("never pins agents in config (the daemon auto-detects)", async () => {
    mockOfficialApi();
    agentRounds = [[agent('claude', 'ready'), agent('codex', 'ready')]];
    const result = await runSetup();
    expect(result.agents).toBeUndefined();
  });
});

describe("runSetup — GitHub device code", () => {
  it("copies the code, opens GitHub and signs in once approved", async () => {
    delete process.env.SSH_CONNECTION; delete process.env.SSH_TTY;
    mockPlatform = 'darwin';
    mockCheckGhAuth.mockReturnValueOnce({ authenticated: false });
    let polls = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      if (url.includes('/api/config')) return ok({ githubClientId: 'cid' });
      if (url.includes('/login/device/code')) return ok({ device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 60, interval: 0 });
      if (url.includes('/login/oauth/access_token')) return ok(++polls < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_x' });
      if (url.includes('api.github.com/user')) return ok({ login: 'octo' });
      if (url.includes('/api/login/resolve')) return ok({ ok: true, region: 'us', relayUrl: 'wss://r', user: { login: 'octo' } });
      return Promise.reject(new Error(url));
    }) as typeof fetch;

    const result = await runSetup();
    expect(result.relay).toBe('wss://r');
    expect(mockExecSync).toHaveBeenCalledWith('pbcopy', expect.objectContaining({ input: 'ABCD-1234' }));
    expect(mockSpawn).toHaveBeenCalledWith('open', ['https://github.com/login/device'], expect.objectContaining({ detached: true }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('ABCD-1234'));
    mockPlatform = null;
  });
});

describe("runSetup — coding agents", () => {
  beforeEach(() => mockOfficialApi());

  it("waits on 'Check again' until an agent is ready", async () => {
    agentRounds = [[agent('codex', 'not_installed')], [agent('codex', 'ready')]];
    mockSelect.mockResolvedValueOnce('again');
    await runSetup();
    expect(mockAgentsCheck).toHaveBeenCalledTimes(2);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect((mockSelect.mock.calls[0][0] as { choices: { value: string }[] }).choices[0].value).toBe('again');
  });

  it("lets the user continue without any agent", async () => {
    agentRounds = [[]];
    mockSelect.mockResolvedValueOnce('continue');
    const result = await runSetup();
    expect(mockSaveConfig).toHaveBeenCalledWith(result);
  });

  it("offers Continue first when one agent is ready and another needs sign-in", async () => {
    agentRounds = [[agent('claude', 'ready'), { ...agent('codex', 'needs_login', 0), hint: 'Run `codex login` in Terminal.' }]];
    mockSelect.mockResolvedValueOnce('continue');
    await runSetup();
    expect((mockSelect.mock.calls[0][0] as { choices: { value: string }[] }).choices[0].value).toBe('continue');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Run `codex login` in Terminal.'));
  });

  it("lists every supported agent, installed or not", async () => {
    agentRounds = [[agent('codex', 'ready', 7)]];
    await runSetup();
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    for (const name of ['Claude Code', 'Codex', 'GitHub Copilot CLI', 'Pi']) {
      expect(lines.some((l) => l.includes(name))).toBe(true);
    }
    expect(lines.some((l) => l.includes('7 models'))).toBe(true);
  });
});

describe("runSetup — direct flow (KRAKI_RELAY_URL set)", () => {
  it("uses custom relay URL with apikey auth", async () => {
    process.env.KRAKI_RELAY_URL = "ws://my-vps:4000";
    mockRelayMethods = ['apikey', 'open'];
    mockInput.mockResolvedValueOnce("ws://my-vps:4000");       // relay URL
    mockSelect.mockResolvedValueOnce("apikey");                // auth method

    const result = await runSetup();
    expect(result.relay).toBe("ws://my-vps:4000");
    expect(result.authMethod).toBe("apikey");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });

  it("uses custom relay with open auth (auto-selected)", async () => {
    process.env.KRAKI_RELAY_URL = "wss://my-relay.example.com";
    mockRelayMethods = ['open'];
    mockInput.mockResolvedValueOnce("wss://my-relay.example.com");

    const result = await runSetup();
    expect(result.authMethod).toBe("open");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});

describe("runSetup — edge cases", () => {
  it("gracefully handles pairing failure", async () => {
    process.env.KRAKI_RELAY_URL = "wss://relay.kraki.chat";
    mockRelayMethods = ['open'];
    mockInput.mockResolvedValueOnce("wss://relay.kraki.chat");

    const result = await runSetup();
    expect(result).toBeTruthy();
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});

describe("runSetup — self-hosted relay", () => {
  beforeEach(() => {
    process.env.KRAKI_RELAY_URL = "ws://lab:4600";
    mockRelayMethods = ['open'];
  });
  afterEach(() => { mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge']; });

  it("keeps a ws:// relay default instead of switching it to TLS", async () => {
    mockInput.mockImplementationOnce(async (opts: { default?: string }) => opts.default ?? '');
    const result = await runSetup();
    expect(result.relay).toBe("ws://lab:4600");
  });

  it("asks for the relay, then checks agents", async () => {
    const order: string[] = [];
    mockInput.mockImplementationOnce(async () => { order.push('relay'); return 'ws://lab:4600'; });
    mockAgentsCheck.mockImplementationOnce(async () => { order.push('agents'); return [agent('pi', 'ready')]; });
    await runSetup();
    expect(order).toEqual(['relay', 'agents']);
  });
});

describe("runSetup — Kraki for Mac already installed", () => {
  beforeEach(() => {
    mockPlatform = "darwin";
    mockMacApp = "/Applications/Kraki.app";
    process.env.KRAKI_RELAY_URL = "ws://lab:4600";
    mockRelayMethods = ['open'];
  });
  afterEach(() => {
    mockPlatform = null;
    mockMacApp = null;
    delete process.env.KRAKI_INSTALL;
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });

  it("stops before setup when the user keeps Kraki for Mac", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    await expect(runSetup()).rejects.toMatchObject({ name: 'ExitPromptError' });
    expect(mockConfirm).toHaveBeenCalledWith(expect.objectContaining({ default: false }));
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("continues when the user wants the command-line version too", async () => {
    mockConfirm.mockResolvedValueOnce(true);
    mockInput.mockResolvedValueOnce("ws://lab:4600");
    const result = await runSetup();
    expect(result.relay).toBe("ws://lab:4600");
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it("does not ask again when install.sh already asked", async () => {
    process.env.KRAKI_INSTALL = "1";
    mockInput.mockResolvedValueOnce("ws://lab:4600");
    await runSetup();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
