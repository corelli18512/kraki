
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelect = vi.fn();
const mockInput = vi.fn();

vi.mock("@inquirer/prompts", () => ({
  select: (...args: any[]) => mockSelect(...args),
  input: (...args: any[]) => mockInput(...args),
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
  const handler: ProxyHandler<any> = {
    get: () => proxy,
    apply: (_target, _thisArg, args) => {
      if (args.length === 1 && typeof args[0] === "string") return args[0];
      return proxy;
    },
  };
  const proxy: any = new Proxy(function(){} as any, handler);
  return { default: proxy };
});

const mockSaveConfig = vi.fn();
const mockSaveChannelKey = vi.fn();
vi.mock("../config.js", () => ({
  DEFAULT_LOG_VERBOSITY: "normal",
  saveConfig: (...args: any[]) => mockSaveConfig(...args),
  saveChannelKey: (...args: any[]) => mockSaveChannelKey(...args),
  getOrCreateDeviceId: () => "dev_test123",
  getConfigPath: () => "/tmp/fake-kraki/config.json",
  loadChannelKey: () => null,
}));

const mockWithRetry = vi.fn();
const mockCheckGhAuth = vi.fn().mockReturnValue({ authenticated: true, username: 'testuser', token: 'fake-token' });
vi.mock("../checks.js", () => ({
  checkGhAuth: (...args: any[]) => mockCheckGhAuth(...args),
  checkCopilotCli: vi.fn(),
  withRetry: (...args: any[]) => mockWithRetry(...args),
}));

// Mock pair module to avoid real WebSocket connection
vi.mock("../pair.js", () => ({
  requestPairingToken: vi.fn().mockRejectedValue(new Error("no relay")),
  buildPairingUrl: vi.fn().mockReturnValue("https://kraki.corelli.cloud?token=test"),
  renderQrToTerminal: vi.fn().mockResolvedValue("[QR CODE]"),
}));

import { runSetup } from "../setup.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("runSetup — official relay + github", () => {
  it("selects official → auto github auth → device name → saves", async () => {
    mockInput.mockResolvedValueOnce("wss://kraki.corelli.cloud"); // relay URL (accept default)
    // No auth select — GitHub is auto-detected from relay methods
    mockInput.mockResolvedValueOnce("my-laptop");              // device name
    mockWithRetry.mockResolvedValueOnce({ found: true, version: "1.0" });             // copilot check

    const result = await runSetup();
    expect(result).toEqual({
      relay: "wss://kraki.corelli.cloud",
      authMethod: "github_token",
      device: { name: "my-laptop", id: "dev_test123" },
      logging: { verbosity: "normal" },
    });
    expect(mockSaveConfig).toHaveBeenCalledWith(result);
  });
});

describe("runSetup — apikey auth", () => {
  it("selects custom → URL → apikey → saves", async () => {
    mockRelayMethods = ['apikey', 'open']; // no github — forces select prompt
    mockInput.mockResolvedValueOnce("ws://my-vps:4000");       // relay URL
    mockSelect.mockResolvedValueOnce("apikey");                // auth method
    mockInput.mockResolvedValueOnce("server-1");               // device name
    mockWithRetry.mockResolvedValueOnce({ found: true, version: "2.0" }); // copilot

    const result = await runSetup();
    expect(result.relay).toBe("ws://my-vps:4000");
    expect(result.authMethod).toBe("apikey");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge']; // reset
  });
});

describe("runSetup — open auth", () => {
  it("selects official → open → no key needed", async () => {
    mockRelayMethods = ['open']; // only open — auto-selects
    mockInput.mockResolvedValueOnce("wss://kraki.corelli.cloud");
    mockInput.mockResolvedValueOnce("dev-box");
    mockWithRetry.mockResolvedValueOnce({ found: true });

    const result = await runSetup();
    expect(result.authMethod).toBe("open");
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge']; // reset
  });
});

describe("runSetup — edge cases", () => {
  it("gracefully handles pairing failure", async () => {
    mockRelayMethods = ['open'];
    mockInput.mockResolvedValueOnce("wss://kraki.corelli.cloud");
    mockInput.mockResolvedValueOnce("dev");
    mockWithRetry.mockResolvedValueOnce({ found: true });

    // Should not throw even if pairing fails
    const result = await runSetup();
    expect(result).toBeTruthy();
    mockRelayMethods = ['github_token', 'open', 'pairing', 'challenge'];
  });
});
