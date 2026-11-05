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

import { fetchLatestVersion, formatBytes, getProxyForUrl, isNewer, npmPrefixForPackageRoot, performUpdate, shouldBypassProxy, stopDaemonForUpdate, summarizeNpmError, updateViaNpm } from '../update.js';

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
        // GitHub's "latest" release, the first and only request.
        callback(createMockResponse(200, JSON.stringify({
          tag_name: 'v0.12.0',
          assets: [{ name: 'kraki-cli-macos-arm64', browser_download_url: 'https://example.com/bin' }],
        })));
      });
      expect(options.socket).toBeDefined();
      return req;
    });

    await expect(fetchLatestVersion()).resolves.toBe('0.12.0');
    expect(mockHttpRequest).toHaveBeenCalledOnce();
    expect(mockHttpsRequest).toHaveBeenCalledOnce();
  });
});

describe('update daemon stop gate', () => {
  it('does nothing when the daemon is already stopped', async () => {
    const stopDaemon = vi.fn();
    await stopDaemonForUpdate({ isDaemonRunning: () => false, stopDaemon }, 1, 1);
    expect(stopDaemon).not.toHaveBeenCalled();
  });

  it('refuses the update when daemon identity cannot be safely stopped', async () => {
    await expect(stopDaemonForUpdate({
      isDaemonRunning: () => true,
      stopDaemon: () => false,
    }, 1, 1)).rejects.toThrow('could not be safely identified and stopped');
  });

  it('refuses the update when the daemon remains alive after the stop window', async () => {
    await expect(stopDaemonForUpdate({
      isDaemonRunning: () => true,
      stopDaemon: () => true,
    }, 1, 2)).rejects.toThrow('did not exit');
  });

  it('continues only after the daemon is confirmed gone', async () => {
    let probes = 0;
    await expect(stopDaemonForUpdate({
      isDaemonRunning: () => probes++ < 2,
      stopDaemon: () => true,
    }, 1, 3)).resolves.toBeUndefined();
  });
});

describe('formatBytes', () => {
  it('formats < 1 KB as bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB without decimal', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('2 KB');
    expect(formatBytes(1024 * 1023)).toBe('1023 KB');
  });

  it('formats MB with 1 decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(121462912)).toBe('115.8 MB');
  });
});

// Dogfood releases (docs/dogfood.md) must never reach regular users.
describe('update ignores dogfood releases', () => {
  const cli = [{ name: 'kraki-cli-macos-arm64', browser_download_url: 'https://example.com/bin' }];
  const dogfoodCli = { tag_name: 'dogfood-cli', prerelease: true, assets: cli };
  const dogfoodMac = { tag_name: 'dogfood-mac', prerelease: true, assets: [] };

  /** Serve `latest` for releases/latest (an Error = HTTP 404) and `list` for the release list. */
  function serve(latest: object | Error, list: object[]) {
    const requested: string[] = [];
    mockHttpsRequest.mockImplementation((url: URL, _options: unknown, callback: (res: PassThrough) => void) => {
      requested.push(url.toString());
      const isLatest = url.pathname.endsWith('/releases/latest');
      return createMockRequest(() => callback(isLatest && latest instanceof Error
        ? createMockResponse(404, '{"message":"Not Found"}')
        : createMockResponse(200, JSON.stringify(isLatest ? latest : list))));
    });
    return requested;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
  });

  it('asks for GitHub\'s latest release first, whatever the list holds', async () => {
    const requested = serve({ tag_name: 'v0.38.11', prerelease: false, assets: cli }, [dogfoodCli, dogfoodMac]);
    await expect(fetchLatestVersion()).resolves.toBe('0.38.11');
    expect(requested).toEqual(['https://api.github.com/repos/corelli18512/kraki/releases/latest']);
  });

  it('falls back to a full page of releases when latest is not a CLI release or fails', async () => {
    const list = [dogfoodCli, dogfoodMac];
    // Even a prerelease that looks like a formal tag is skipped.
    list.push({ tag_name: 'v0.38.12-rc.1', prerelease: true, assets: cli });
    for (let n = 0; n < 30; n++) list.push({ tag_name: `win-v0.1.${n}`, prerelease: false, assets: [] });
    list.push({ tag_name: 'v0.38.11', prerelease: false, assets: cli });

    for (const latest of [{ tag_name: 'mac-v0.2.91', prerelease: false, assets: [] }, dogfoodCli, new Error('404')]) {
      const requested = serve(latest, list);
      await expect(fetchLatestVersion()).resolves.toBe('0.38.11');
      expect(requested).toHaveLength(2);
      expect(requested[1]).toContain('per_page=100');
    }
  });

  it('moves a tester on a dogfood build to the next formal release, never back', () => {
    expect(isNewer('0.38.12', '0.38.12-dev.57')).toBe(true);
    expect(isNewer('0.38.11', '0.38.12-dev.57')).toBe(false);
    expect(isNewer('0.38.12-dev.57', '0.38.11')).toBe(true);
  });
});

describe('performUpdate exit code', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('exits non-zero when the update check fails (K-267)', async () => {
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    mockHttpsRequest.mockImplementation((_url: URL, _options: unknown, callback: (res: PassThrough) => void) =>
      createMockRequest(() => callback(createMockResponse(500, '{"message":"down"}'))));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await performUpdate('0.1.0');
    expect(process.exitCode).toBe(1);
  });
});

describe('npm update targets the running install (K-274)', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  function npmInstall(version: string) {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'kraki-npm-prefix-')));
    const root = join(prefix, 'lib', 'node_modules', '@kraki', 'tentacle');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli.js'), '');
    const setVersion = (v: string) => writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@kraki/tentacle', version: v }));
    setVersion(version);
    return { prefix, root, script: join(root, 'dist', 'cli.js'), setVersion };
  }

  it('finds the npm prefix of a global install', () => {
    expect(npmPrefixForPackageRoot('/opt/homebrew/lib/node_modules/@kraki/tentacle')).toBe('/opt/homebrew');
    expect(npmPrefixForPackageRoot('/home/u/.nvm/versions/node/v22.1.0/lib/node_modules/@kraki/tentacle')).toBe('/home/u/.nvm/versions/node/v22.1.0');
    expect(npmPrefixForPackageRoot('/repo/packages/tentacle')).toBeNull();
  });

  it('installs into the prefix this kraki runs from', async () => {
    const install = npmInstall('0.1.0');
    const commands: string[] = [];
    await updateViaNpm('0.2.0', { scriptPath: install.script, exec: (cmd) => { commands.push(cmd); install.setVersion('0.2.0'); } });
    expect(commands).toEqual([`npm install -g --prefix ${JSON.stringify(install.prefix)} @kraki/tentacle@0.2.0`]);
  });

  it('fails instead of reporting success when this kraki was not updated', async () => {
    const install = npmInstall('0.1.0');
    await expect(updateViaNpm('0.2.0', { scriptPath: install.script, exec: () => {} }))
      .rejects.toThrow(/still 0\.1\.0/);
  });

  it('does not report a pnpm update as failed because the old .pnpm version directory remains', async () => {
    const prefix = realpathSync(mkdtempSync(join(tmpdir(), 'kraki-pnpm-')));
    const root = join(prefix, '.pnpm', '@kraki+tentacle@0.1.0', 'node_modules', '@kraki', 'tentacle');
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'cli.js'), '');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@kraki/tentacle', version: '0.1.0' }));
    const commands: string[] = [];
    await updateViaNpm('0.2.0', { scriptPath: join(root, 'dist', 'cli.js'), exec: (cmd) => { commands.push(cmd); } });
    expect(commands).toEqual(['pnpm add -g @kraki/tentacle@0.2.0']);
  });

  it('turns an EACCES failure into one actionable line', async () => {
    const install = npmInstall('0.1.0');
    const stderr = ['npm error code EACCES', 'npm error syscall mkdir', 'npm error path /usr/local/lib/node_modules/@kraki',
      ...Array.from({ length: 35 }, (_, i) => `npm error line ${i}`), 'npm error A complete log of this run can be found in: /x.log'].join('\n');
    const failure = await updateViaNpm('0.2.0', {
      scriptPath: install.script,
      exec: () => { throw Object.assign(new Error('Command failed'), { stderr }); },
    }).catch((err: Error) => err);
    expect((failure as Error).message).toContain('permission denied');
    expect((failure as Error).message.split('\n')).toHaveLength(1);
    expect(summarizeNpmError('npm error code E404\nnpm error 404 Not Found\nnpm error A complete log of this run can be found in: /x', null))
      .toBe('npm error code E404 npm error 404 Not Found');
  });
});
