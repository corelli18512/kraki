
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSelect = vi.fn();
const mockInput = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  input: (...args: unknown[]) => mockInput(...args),
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
  loadChannelKey: () => null,
}));

const mockWithRetry = vi.fn();
const mockCheckGhAuth = vi.fn().mockReturnValue({ authenticated: true, username: 'testuser', token: 'fake-token' });
vi.mock("../checks.js", () => ({
  checkGhAuth: (...args: unknown[]) => mockCheckGhAuth(...args),
  checkCopilotCli: vi.fn(),
  withRetry: (...args: unknown[]) => mockWithRetry(...args),
}));

// Mock pair module to avoid real WebSocket connection
vi.mock("../pair.js", () => ({
  requestPairingToken: vi.fn().mockRejectedValue(new Error("no relay")),
  buildPairingUrl: vi.fn().mockReturnValue("https://kraki.corelli.cloud?token=test"),
  renderQrToTerminal: vi.fn().mockResolvedValue("[QR CODE]"),
}));

import { runSetup } from "../setup.js";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
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
  it("authenticates → resolves region → verifies relay → device name → saves", async () => {
    // Mock fetch for /api/login/resolve
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/login/resolve')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            region: 'us',
            relayUrl: 'wss://relay-us.kraki.corelli.cloud',
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
    mockWithRetry.mockResolvedValueOnce({ found: true, version: "1.0" });

    const result = await runSetup();
    expect(result).toEqual({
      relay: "wss://relay-us.kraki.corelli.cloud",
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
    mockWithRetry.mockResolvedValueOnce({ found: true, version: "1.0" });

    const result = await runSetup();
    expect(result.relay).toBe("wss://kraki.corelli.cloud");
    expect(result.authMethod).toBe("github_token");
  });
});

describe("runSetup — direct flow (KRAKI_RELAY_URL set)", () => {
  it("uses custom relay URL with apikey auth", async () => {
    process.env.KRAKI_RELAY_URL = "ws://my-vps:4000";
    mockRelayMethods = ['apikey', 'open'];
    mockInput.mockResolvedValueOnce("ws://my-vps:4000");       // relay URL
    mockSelect.mockResolvedValueOnce("apikey");                // auth method
    mockInput.mockResolvedValueOnce("server-1");               // device name
    mockWithRetry.mockResolvedValueOnce({ found: true, version: "2.0" });

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
    mockWithRetry.mockResolvedValueOnce({ found: true });

    const result = await runSetup();
    expect(result.authMethod).toBe("open");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});

describe("runSetup — edge cases", () => {
  it("gracefully handles pairing failure", async () => {
    process.env.KRAKI_RELAY_URL = "wss://kraki.corelli.cloud";
    mockRelayMethods = ['open'];
    mockInput.mockResolvedValueOnce("wss://kraki.corelli.cloud");
    mockInput.mockResolvedValueOnce("dev");
    mockWithRetry.mockResolvedValueOnce({ found: true });

    const result = await runSetup();
    expect(result).toBeTruthy();
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});
