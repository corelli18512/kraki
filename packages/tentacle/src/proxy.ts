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
 * Not supported: PAC scripts (automatic proxy configuration) and SOCKS
 * proxies, from the system settings or ALL_PROXY=socks5://…. Kraki connects
 * directly then; `unsupportedProxy()` names the setting so setup, `kraki
 * status`, `kraki doctor` and the daemon log can say so instead of failing
 * silently (K-328).
 *
 * `applyProcessProxy()` makes fetch()/http(s).request use it (Node's built-in
 * proxy support) and exports the variables to agent child processes.
 * WebSockets (the `ws` package) open their own sockets and ignore that, so
 * every `new WebSocket` passes `wsProxyOptions(url)` for an explicit CONNECT
 * agent. Without this, a proxied Mac could neither sign in nor connect.
 */

import { execFileSync } from 'node:child_process';
import http from 'node:http';
import tls from 'node:tls';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface ProxySettings {
  https?: string;
  http?: string;
  noProxy: string[];
  source: 'env' | 'macos-system' | 'windows-system';
}

function rawEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name] || env[name.toLowerCase()] || undefined;
}

const isSocksUrl = (value: string) => /^socks[a-z0-9]*:\/\//i.test(value.trim());

/** A usable (HTTP CONNECT) proxy variable; SOCKS values are ignored. Node's
 *  fetch would take socks5:// with a raw ExperimentalWarning, while the relay
 *  WebSocket cannot use it at all. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = rawEnvValue(env, name);
  return value && !isSocksUrl(value) ? value : undefined;
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

/** What a macOS proxy configuration without a web proxy uses instead, if anything. */
export function parseScutilUnsupported(text: string): string | null {
  if (parseScutilProxy(text)) return null;
  const on = (key: string) => new RegExp(`^\\s*${key}\\s*:\\s*1\\s*$`, 'm').test(text);
  if (on('ProxyAutoConfigEnable')) return 'automatic proxy configuration (PAC)';
  if (on('SOCKSEnable')) return 'SOCKS proxy';
  if (on('ProxyAutoDiscoveryEnable')) return 'automatic proxy discovery';
  return null;
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

/** What a Windows proxy configuration without a web proxy uses instead, if anything. */
export function parseWindowsUnsupported(text: string): string | null {
  if (parseWindowsProxy(text)) return null;
  const val = (name: string) => text.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi'))?.[1];
  if (val('AutoConfigURL')) return 'automatic proxy configuration (PAC)';
  const enable = val('ProxyEnable');
  if (enable && Number(enable) !== 0 && /(^|;)\s*socks=/i.test(val('ProxyServer') ?? '')) return 'SOCKS proxy';
  return null;
}

/**
 * A proxy setting Kraki cannot use (it connects directly instead), as a short
 * description, or null. Only when no usable proxy was found.
 */
export function unsupportedProxy(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  if (detectProxy(env, platform)) return null;
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY']) {
    const value = rawEnvValue(env, name);
    if (value && isSocksUrl(value)) return `SOCKS proxy (${name})`;
  }
  const out = systemProxyText(platform);
  if (out === null) return null;
  return platform === 'win32' ? parseWindowsUnsupported(out) : parseScutilUnsupported(out);
}

// One `scutil --proxy` / `reg query` per process: `kraki status --json` (polled
// by Kraki for Mac) asks detectProxy and unsupportedProxy, and the CLI's
// startup applyProcessProxy asked already. Proxy settings are read once per
// process anyway (proxySettings).
const systemProxyTexts = new Map<string, string | null>();

function systemProxyText(platform: string): string | null {
  if (platform !== 'darwin' && platform !== 'win32') return null;
  if (!systemProxyTexts.has(platform)) {
    let out: string | null = null;
    try {
      out = platform === 'win32'
        ? execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
          { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        : execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* no system proxy information */ }
    systemProxyTexts.set(platform, out);
  }
  return systemProxyTexts.get(platform) ?? null;
}

/** The one-line warning for an unsupported proxy setting. */
export function unsupportedProxyMessage(setting: string): string {
  return `Your network uses a ${setting}, which Kraki cannot use, so it connects directly. `
    + 'If that fails, set an HTTP proxy: HTTPS_PROXY=http://host:port (proxy apps usually offer an HTTP port too), '
    + 'or a web proxy in the system network settings.';
}

let cached: ProxySettings | null | undefined;

export function detectProxy(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ProxySettings | null {
  const https = envValue(env, 'HTTPS_PROXY') ?? envValue(env, 'ALL_PROXY');
  const httpUrl = envValue(env, 'HTTP_PROXY') ?? envValue(env, 'ALL_PROXY');
  if (https || httpUrl) {
    const noProxy = (envValue(env, 'NO_PROXY') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { https: https ?? httpUrl, http: httpUrl ?? https, noProxy, source: 'env' };
  }
  const out = systemProxyText(platform);
  if (out === null) return null;
  return platform === 'win32' ? parseWindowsProxy(out) : parseScutilProxy(out);
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


type CaStore = 'default' | 'system' | 'bundled' | 'extra';
interface TlsCaApi {
  getCACertificates?: (type?: CaStore) => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
}

/**
 * Also trust the operating system's certificate store (macOS Keychain,
 * Windows store; on Linux the OpenSSL default paths). Node trusts only its
 * bundled roots (plus NODE_EXTRA_CA_CERTS), so behind a corporate TLS proxy
 * whose root an MDM profile installed, every relay and sign-in connection
 * failed with an error only the daemon log showed. Adds to the default set,
 * never replaces it. Returns how many system roots were added, or null when
 * this Node cannot (older than 22.19 / 24.5) or reading the store failed.
 */
export function trustSystemCertificates(api: TlsCaApi = tls as unknown as TlsCaApi): number | null {
  if (!api.getCACertificates || !api.setDefaultCACertificates) return null;
  try {
    const current = api.getCACertificates('default');
    const known = new Set(current);
    const added = api.getCACertificates('system').filter((cert) => !known.has(cert));
    if (added.length > 0) api.setDefaultCACertificates([...current, ...added]);
    return added.length;
  } catch {
    return null;
  }
}
