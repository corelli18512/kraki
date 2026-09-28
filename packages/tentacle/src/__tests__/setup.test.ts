
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

vi.mock("../banner.js", () => ({
  printAnimatedBanner: vi.fn(),
  printStaticBanner: vi.fn(),
}));

vi.mock("chalk", () => {
  const handler: ProxyHandler<(...args: unknown[]) => unknown> = {
    get: () => proxy,
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
}));

const mockCheckGhAuth = vi.fn().mockReturnValue({ authenticated: true, username: 'testuser', token: 'fake-token' });
// Default agent detection: only Copilot installed → runAgentStep leaves auto-detect.
let installedAgents: string[] = ['copilot'];
const mockCheckAgentCli = vi.fn((bin: string) => installedAgents.includes(bin) ? { found: true, version: '1.0.0' } : { found: false });
vi.mock("../checks.js", () => ({
  checkGhAuth: (...args: unknown[]) => mockCheckGhAuth(...args),
  checkAgentCli: (bin: string) => mockCheckAgentCli(bin),
  SETUP_AGENTS: [
    { id: 'claude', name: 'Claude Code', bin: 'claude', installUrl: 'https://code.claude.com/docs/en/setup' },
    { id: 'codex', name: 'Codex', bin: 'codex', installUrl: 'https://developers.openai.com/codex/cli' },
    { id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', installUrl: 'https://github.com/features/copilot/cli' },
    { id: 'pi', name: 'pi', bin: 'pi', installUrl: 'https://github.com/earendil-works/pi#readme' },
  ],
  probeFda: vi.fn().mockResolvedValue('granted'),
  probeFdaAsApp: vi.fn().mockResolvedValue('granted'),
  pollFda: vi.fn().mockResolvedValue('granted'),
  ensureTccBundleRegistered: vi.fn(),
  openTccPane: vi.fn(),
  revealKrakiApp: vi.fn(),
  getKrakiAppBundlePath: vi.fn().mockReturnValue(null),
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
  installedAgents = ['copilot'];
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

describe("runSetup — login-first flow (official relay)", () => {
  it('detects Codex in the official login-first wizard too', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error')) as typeof fetch;
    installedAgents = ['codex'];
    mockInput.mockResolvedValueOnce('codex-pc');
    const result = await runSetup();
    expect(mockCheckAgentCli).toHaveBeenCalledWith('codex');
    expect(result.authMethod).toBe('github_token');
    expect(result.agents).toBeUndefined();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Codex'));
  });

  it("authenticates → resolves region → verifies relay → device name → saves", async () => {
    // Mock fetch for /api/login/resolve
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/login/resolve')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            region: 'us',
            relayUrl: 'wss://kraki-us.corelli.cloud',
            user: { login: 'testuser' },
          }),
        });
      }
      if (typeof url === 'string' && url.includes('/api/config')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ githubClientId: 'test-client-id' }),
        });
      }
      return Promise.reject(new Error(`unmocked fetch: ${url}`));
    }) as typeof fetch;

    // device name prompt
    mockInput.mockResolvedValueOnce("my-laptop");

    const result = await runSetup();
    expect(result).toEqual({
      relay: "wss://kraki-us.corelli.cloud",
      authMethod: "github_token",
      device: { name: "my-laptop", id: "dev_test123" },
      logging: { verbosity: "normal" },
    });
    expect(mockSaveConfig).toHaveBeenCalledWith(result);
  });

  it("falls back to default relay if API is unreachable", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error")) as typeof fetch;

    // device name prompt
    mockInput.mockResolvedValueOnce("my-laptop");

    const result = await runSetup();
    expect(result.relay).toBe("wss://relay.kraki.chat");
    expect(result.authMethod).toBe("github_token");
  });
});

describe("runSetup — direct flow (KRAKI_RELAY_URL set)", () => {
  it('detects Codex-only installs without requiring Copilot', async () => {
    process.env.KRAKI_RELAY_URL = 'ws://localhost:4791';
    mockRelayMethods = ['open'];
    installedAgents = ['codex'];
    mockInput.mockResolvedValueOnce('ws://localhost:4791').mockResolvedValueOnce('codex-pc');
    const result = await runSetup();
    expect(mockCheckAgentCli).toHaveBeenCalledWith('codex');
    expect(mockCheckbox).not.toHaveBeenCalled();
    expect(result.agents).toBeUndefined(); // auto-detect, including future installs
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });

  it('offers Codex alongside Copilot and persists the selection', async () => {
    process.env.KRAKI_RELAY_URL = 'ws://localhost:4791';
    mockRelayMethods = ['open'];
    installedAgents = ['copilot', 'codex'];
    mockCheckbox.mockResolvedValueOnce(['codex']);
    mockInput.mockResolvedValueOnce('ws://localhost:4791').mockResolvedValueOnce('codex-pc');
    const result = await runSetup();
    expect(mockCheckbox).toHaveBeenCalledWith(expect.objectContaining({
      choices: [
        { name: 'Codex', value: 'codex', checked: true },
        { name: 'GitHub Copilot CLI', value: 'copilot', checked: true },
      ],
    }));
    expect(result.agents).toEqual(['codex']);
    expect(mockSaveConfig).toHaveBeenCalledWith(result);
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });

  it("uses custom relay URL with apikey auth", async () => {
    process.env.KRAKI_RELAY_URL = "ws://my-vps:4000";
    mockRelayMethods = ['apikey', 'open'];
    mockInput.mockResolvedValueOnce("ws://my-vps:4000");       // relay URL
    mockSelect.mockResolvedValueOnce("apikey");                // auth method
    mockInput.mockResolvedValueOnce("server-1");               // device name

    const result = await runSetup();
    expect(result.relay).toBe("ws://my-vps:4000");
    expect(result.authMethod).toBe("apikey");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });

  it("uses custom relay with open auth (auto-selected)", async () => {
    process.env.KRAKI_RELAY_URL = "wss://my-relay.example.com";
    mockRelayMethods = ['open'];
    mockInput.mockResolvedValueOnce("wss://my-relay.example.com");
    mockInput.mockResolvedValueOnce("dev-box");

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
    mockInput.mockResolvedValueOnce("dev");

    const result = await runSetup();
    expect(result).toBeTruthy();
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});

describe("runSetup — agents step", () => {
  function directRelay() {
    process.env.KRAKI_RELAY_URL = "ws://lab:4600";
    mockRelayMethods = ['open'];
  }
  afterEach(() => { mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge']; });

  it("does not require Copilot on a self-hosted relay (Codex-only machine)", async () => {
    directRelay();
    installedAgents = ['codex'];
    mockInput.mockResolvedValueOnce("ws://lab:4600").mockResolvedValueOnce("mac");

    const result = await runSetup();
    expect(result.agents).toBeUndefined();
    expect(mockCheckbox).not.toHaveBeenCalled();
  });

  it("finishes setup when no agent is installed yet", async () => {
    directRelay();
    installedAgents = [];
    mockInput.mockResolvedValueOnce("ws://lab:4600").mockResolvedValueOnce("mac");

    const result = await runSetup();
    expect(result.agents).toBeUndefined();
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it("offers every installed agent and keeps auto-detect when all stay checked", async () => {
    directRelay();
    installedAgents = ['claude', 'codex', 'pi'];
    mockInput.mockResolvedValueOnce("ws://lab:4600").mockResolvedValueOnce("mac");
    mockCheckbox.mockResolvedValueOnce(['claude', 'codex', 'pi']);

    const result = await runSetup();
    const choices = (mockCheckbox.mock.calls[0][0] as { choices: { value: string }[] }).choices.map((c) => c.value);
    expect(choices).toEqual(['claude', 'codex', 'pi']);
    expect(result.agents).toBeUndefined();
  });

  it("pins the subset the user picked", async () => {
    directRelay();
    installedAgents = ['claude', 'codex'];
    mockInput.mockResolvedValueOnce("ws://lab:4600").mockResolvedValueOnce("mac");
    mockCheckbox.mockResolvedValueOnce(['codex']);

    const result = await runSetup();
    expect(result.agents).toEqual(['codex']);
  });

  it("keeps a ws:// relay default instead of switching it to TLS", async () => {
    directRelay();
    mockInput.mockImplementationOnce(async (opts: { default?: string }) => opts.default ?? '').mockResolvedValueOnce("mac");

    const result = await runSetup();
    expect(result.relay).toBe("ws://lab:4600");
  });
});
