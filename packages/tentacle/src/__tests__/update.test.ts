import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHttpRequest = vi.fn();
const mockHttpsRequest = vi.fn();

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http');
  return {
    ...actual,
    request: (...args: unknown[]) => mockHttpRequest(...args),
  };
});

vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:https')>('node:https');
  return {
    ...actual,
    request: (...args: unknown[]) => mockHttpsRequest(...args),
  };
});

import { fetchLatestVersion, getProxyForUrl, shouldBypassProxy } from '../update.js';

function createMockResponse(statusCode: number, body: string, headers: Record<string, string> = {}) {
  const res = new PassThrough() as PassThrough & {
    statusCode: number;
    headers: Record<string, string>;
  };
  res.statusCode = statusCode;
  res.headers = headers;
  queueMicrotask(() => {
    res.end(body);
  });
  return res;
}

function createMockRequest(onEnd: () => void) {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const req = {
    _handlers: handlers,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = cb;
      return req;
    }),
    setTimeout: vi.fn((_ms: number, _cb: () => void) => req),
    end: vi.fn(() => onEnd()),
    destroy: vi.fn((err?: Error) => {
      if (err) handlers.error?.(err);
    }),
  };
  return req;
}

describe('update proxy support', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('matches NO_PROXY entries for exact hosts and suffixes', () => {
    expect(shouldBypassProxy('api.github.com', 'api.github.com')).toBe(true);
    expect(shouldBypassProxy('release-assets.githubusercontent.com', '.githubusercontent.com')).toBe(true);
    expect(shouldBypassProxy('release-assets.githubusercontent.com', '*.githubusercontent.com')).toBe(true);
    expect(shouldBypassProxy('github.com', 'localhost,127.0.0.1')).toBe(false);
  });

  it('selects HTTPS_PROXY for GitHub updater requests', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1081';

    expect(getProxyForUrl('https://api.github.com/repos/corelli18512/kraki/releases?per_page=20')?.toString())
      .toBe('http://127.0.0.1:1081/');
  });

  it('bypasses the proxy when NO_PROXY matches the target host', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1081';
    process.env.NO_PROXY = 'api.github.com';

    expect(getProxyForUrl('https://api.github.com/repos/corelli18512/kraki/releases?per_page=20')).toBeNull();
  });

  it('routes GitHub API requests through the configured HTTP proxy', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1081';

    mockHttpRequest.mockImplementation((options: { host: string; port: number; method: string; path: string }) => {
      const req = createMockRequest(() => {
        const socket = { destroy: vi.fn(), unshift: vi.fn() };
        req._handlers.connect?.({ statusCode: 200, headers: {} }, socket, Buffer.alloc(0));
      });
      expect(options.host).toBe('127.0.0.1');
      expect(options.port).toBe(1081);
      expect(options.method).toBe('CONNECT');
      expect(options.path).toBe('api.github.com:443');
      return req;
    });

    mockHttpsRequest.mockImplementation((options: { socket?: unknown }, callback: (res: PassThrough) => void) => {
      const req = createMockRequest(() => {
        callback(createMockResponse(200, JSON.stringify([
          {
            tag_name: 'v0.12.0',
            assets: [{ name: 'kraki-cli-macos-arm64', browser_download_url: 'https://example.com/bin' }],
          },
        ])));
      });
      expect(options.socket).toBeDefined();
      return req;
    });

    await expect(fetchLatestVersion()).resolves.toBe('0.12.0');
    expect(mockHttpRequest).toHaveBeenCalledOnce();
    expect(mockHttpsRequest).toHaveBeenCalledOnce();
  });
});
