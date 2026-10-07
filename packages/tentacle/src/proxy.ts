/**
 * Proxy support for networks that only reach the internet through a proxy.
 *
 * Sources, first match wins:
 *  1. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY (+ NO_PROXY), any case.
 *  2. macOS: the system proxy (System Settings → Network → Proxies, also what
 *     Clash/Surge "system proxy" sets), read from `scutil --proxy`. Kraki for
 *     Mac's helper and launchd jobs never see shell variables, so this is the
 *     only way they learn about a proxy.
 *  3. Windows: the system proxy (Settings → Network → Proxy → manual proxy,
 *     also what Clash/v2rayN "system proxy" sets), read from the registry
 *     (HKCU\…\Internet Settings). Most users there never set HTTPS_PROXY.
 *     A PAC script (automatic setup) is not supported.
 *
 * `applyProcessProxy()` makes fetch()/http(s).request use it (Node's built-in
 * proxy support) and exports the variables to agent child processes.
 * WebSockets (the `ws` package) open their own sockets and ignore that, so
 * every `new WebSocket` passes `wsProxyOptions(url)` for an explicit CONNECT
 * agent. Without this, a proxied Mac could neither sign in nor connect.
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface ProxySettings {
  https?: string;
  http?: string;
  noProxy: string[];
  source: 'env' | 'macos-system' | 'windows-system';
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] || env[name.toLowerCase()] || undefined;
}

/** Parse `scutil --proxy` output. */
export function parseScutilProxy(text: string): ProxySettings | null {
  const val = (key: string) => text.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm'))?.[1];
  const url = (kind: 'HTTPS' | 'HTTP') => {
    if (val(`${kind}Enable`) !== '1') return undefined;
    const host = val(`${kind}Proxy`); const port = val(`${kind}Port`);
    return host ? `http://${host}${port ? `:${port}` : ''}` : undefined;
  };
  const https = url('HTTPS'); const httpUrl = url('HTTP');
  if (!https && !httpUrl) return null;
  const list = text.match(/ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  const noProxy = [...list.matchAll(/^\s*\d+\s*:\s*(\S+)/gm)].map((m) => m[1]);
  return { https: https ?? httpUrl, http: httpUrl ?? https, noProxy, source: 'macos-system' };
}

/** One `ProxyOverride` entry → a NO_PROXY rule (`127.*` → `127.0.0.0/8`). */
function overrideToNoProxy(entry: string): string | null {
  const e = entry.trim();
  if (!e || e === '<local>') return null;
  const ip = e.match(/^(\d+(?:\.\d+){0,3})\.\*$/);
  if (ip) {
    const parts = ip[1].split('.');
    return `${[...parts, ...Array(4 - parts.length).fill('0')].join('.')}/${parts.length * 8}`;
  }
  return e;
}

/** Parse `reg query "HKCU\…\Internet Settings"` output. */
export function parseWindowsProxy(text: string): ProxySettings | null {
  const val = (name: string) => text.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi'))?.[1];
  const enable = val('ProxyEnable');
  if (!enable || Number(enable) === 0) return null; // REG_DWORD prints 0x1
  const server = val('ProxyServer');
  if (!server) return null;
  const withScheme = (hp: string) => (/^[a-z]+:\/\//i.test(hp) ? hp : `http://${hp}`);
  let https: string | undefined; let httpUrl: string | undefined;
  if (server.includes('=')) {
    // "http=host:port;https=host:port;socks=host:port"
    for (const part of server.split(';')) {
      const [k, v] = part.split('=').map((x) => x.trim());
      if (!v) continue;
      if (k.toLowerCase() === 'https') https = withScheme(v);
      if (k.toLowerCase() === 'http') httpUrl = withScheme(v);
    }
  } else {
    https = httpUrl = withScheme(server.trim());
  }
  if (!https && !httpUrl) return null;
  const override = val('ProxyOverride') ?? '';
  const noProxy = override.split(';').map(overrideToNoProxy).filter((x): x is string => !!x);
  if (override.includes('<local>') && !noProxy.includes('localhost')) noProxy.push('localhost');
  return { https: https ?? httpUrl, http: httpUrl ?? https, noProxy, source: 'windows-system' };
}

let cached: ProxySettings | null | undefined;

export function detectProxy(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ProxySettings | null {
  const https = envValue(env, 'HTTPS_PROXY') ?? envValue(env, 'ALL_PROXY');
  const httpUrl = envValue(env, 'HTTP_PROXY') ?? envValue(env, 'ALL_PROXY');
  if (https || httpUrl) {
    const noProxy = (envValue(env, 'NO_PROXY') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { https: https ?? httpUrl, http: httpUrl ?? https, noProxy, source: 'env' };
  }
  if (platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return parseWindowsProxy(out);
    } catch {
      return null;
    }
  }
  if (platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return parseScutilProxy(out);
  } catch {
    return null;
  }
}

function proxySettings(): ProxySettings | null {
  if (cached === undefined) cached = detectProxy();
  return cached;
}

function ipv4ToInt(ip: string): number | null {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** NO_PROXY / macOS exception matching: '*', host, .suffix, *.suffix, a.b.c.d/nn. */
export function bypassesProxy(host: string, noProxy: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of noProxy) {
    const rule = raw.toLowerCase().trim();
    if (!rule) continue;
    if (rule === '*') return true;
    const cidr = rule.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidr) {
      const ip = ipv4ToInt(h); const base = ipv4ToInt(cidr[1]); const bits = Number(cidr[2]);
      if (ip !== null && base !== null) {
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        if (((ip & mask) >>> 0) === ((base & mask) >>> 0)) return true;
      }
      continue;
    }
    const suffix = rule.replace(/^\*?\./, '');
    if (h === suffix || h.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

/** The proxy URL to use for `url`, or undefined for a direct connection. */
export function proxyFor(url: string, settings: ProxySettings | null = proxySettings()): string | undefined {
  if (!settings) return undefined;
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (bypassesProxy(u.hostname, settings.noProxy)) return undefined;
  const secure = u.protocol === 'wss:' || u.protocol === 'https:';
  return secure ? settings.https : settings.http;
}

/** Extra options for `new WebSocket(url, …)`: a CONNECT agent when proxied. */
export function wsProxyOptions(url: string): { agent?: HttpsProxyAgent<string> } {
  const proxy = proxyFor(url);
  return proxy ? { agent: new HttpsProxyAgent(proxy) } : {};
}

/**
 * Route fetch()/http(s) through the proxy and pass it to agent child
 * processes. Call once at startup. No-op without a proxy.
 */
export function applyProcessProxy(env: NodeJS.ProcessEnv = process.env): ProxySettings | null {
  const settings = proxySettings();
  if (!settings) return null;
  if (settings.source !== 'env') {
    // Children (Copilot, Claude, Codex, Pi) read these variables.
    if (settings.https) env.HTTPS_PROXY = settings.https;
    if (settings.http) env.HTTP_PROXY = settings.http;
    if (settings.noProxy.length) env.NO_PROXY = settings.noProxy.join(',');
  }
  const setGlobal = (http as unknown as { setGlobalProxyFromEnv?: (e?: Record<string, string | undefined>) => void }).setGlobalProxyFromEnv;
  try {
    setGlobal?.({ HTTPS_PROXY: settings.https, HTTP_PROXY: settings.http, NO_PROXY: settings.noProxy.join(',') });
  } catch { /* older Node: env variables still reach children */ }
  return settings;
}

