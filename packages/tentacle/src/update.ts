/**
 * Self-update for Kraki tentacle.
 *
 * Supports two install methods:
 *   - npm global: runs `npm i -g @kraki/tentacle@latest`
 *   - SEA binary: downloads latest release binary from GitHub
 *
 * Also provides a background update check that caches results for 24h.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, unlinkSync, chmodSync, renameSync, copyFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest, type IncomingMessage, type RequestOptions as HttpRequestOptions } from 'node:http';
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { isSea } from 'node:sea';
import chalk from 'chalk';
import ora from 'ora';
import { getKrakiHome } from './config.js';

const GITHUB_REPO = 'corelli18512/kraki';
const NPM_PACKAGE = '@kraki/tentacle';
const CHECK_CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;

// ── Install method detection ────────────────────────────

export type InstallMethod = 'npm' | 'sea' | 'unknown';

export function detectInstallMethod(): InstallMethod {
  if (isSea()) return 'sea';
  const scriptPath = process.argv[1];
  if (!scriptPath) return 'unknown';
  let resolvedPath = scriptPath;
  try { resolvedPath = realpathSync(scriptPath); } catch { /* use original */ }
  if (resolvedPath.includes('node_modules') || resolvedPath.includes('.npm')) {
    return 'npm';
  }
  return 'unknown';
}

// ── Latest version fetching ─────────────────────────────

interface GitHubRelease {
  tag_name: string;
  assets?: Array<{ name: string; browser_download_url: string }>;
}

export function shouldBypassProxy(hostname: string, noProxyRaw = process.env.NO_PROXY ?? process.env.no_proxy ?? ''): boolean {
  if (!noProxyRaw) return false;

  const normalizedHost = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return noProxyRaw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;

      const hostPart = entry.startsWith('*.') ? entry.slice(2) : entry.startsWith('.') ? entry.slice(1) : entry;
      return normalizedHost === hostPart || normalizedHost.endsWith(`.${hostPart}`);
    });
}

export function getProxyForUrl(url: string): URL | null {
  const target = new URL(url);
  if (shouldBypassProxy(target.hostname)) {
    return null;
  }

  const rawProxy = target.protocol === 'https:'
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy;

  if (!rawProxy) return null;

  try {
    const parsed = new URL(rawProxy);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed;
    }
  } catch {
    // Ignore malformed proxy env values and fall back to direct networking.
  }
  return null;
}

function buildProxyAuthHeader(proxyUrl: URL): string | undefined {
  if (!proxyUrl.username && !proxyUrl.password) return undefined;
  const user = decodeURIComponent(proxyUrl.username);
  const pass = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function isRedirect(statusCode?: number): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308;
}

function getLocation(location: string | string[] | undefined): string | undefined {
  if (Array.isArray(location)) return location[0];
  return location;
}

function createDirectRequest(target: URL, onResponse: (res: IncomingMessage) => void) {
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = requestFn(target, {
    headers: { 'User-Agent': 'kraki-updater' },
    method: 'GET',
  }, onResponse);

  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    req.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
  });

  return req;
}

function createProxiedRequest(
  target: URL,
  proxyUrl: URL,
  onResponse: (res: IncomingMessage) => void,
  onError: (err: Error) => void,
) {
  const proxyAuth = buildProxyAuthHeader(proxyUrl);
  const proxyHeaders: Record<string, string> = {
    Host: `${target.hostname}:${target.port || '443'}`,
    'User-Agent': 'kraki-updater',
  };
  if (proxyAuth) {
    proxyHeaders['Proxy-Authorization'] = proxyAuth;
  }

  const options: HttpRequestOptions = {
    host: proxyUrl.hostname,
    port: proxyUrl.port ? Number(proxyUrl.port) : proxyUrl.protocol === 'https:' ? 443 : 80,
    method: 'CONNECT',
    path: `${target.hostname}:${target.port || '443'}`,
    headers: proxyHeaders,
  };

  const connectReq = (proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest)(options);
  connectReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
    connectReq.destroy(new Error(`Proxy connection timed out after ${REQUEST_TIMEOUT_MS}ms`));
  });

  connectReq.on('connect', (res, socket, head) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      onResponse(Object.assign(res, { statusCode: res.statusCode ?? 502 }));
      return;
    }

    if (head.length > 0) {
      socket.unshift(head);
    }

    const tunneledOptions: HttpsRequestOptions & { socket: typeof socket } = {
      agent: false,
      headers: { 'User-Agent': 'kraki-updater' },
      host: target.hostname,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      port: target.port ? Number(target.port) : 443,
      servername: target.hostname,
      socket,
    };
    const tunneledReq = httpsRequest(tunneledOptions, onResponse);

    tunneledReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
      tunneledReq.destroy(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
    });
    tunneledReq.on('error', (err) => {
      socket.destroy();
      onError(err);
    });
    tunneledReq.end();
  });

  return connectReq;
}

function sendRequest(url: string, redirects = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects while fetching ${url}`));
      return;
    }

    const target = new URL(url);
    const proxyUrl = getProxyForUrl(url);
    const req = proxyUrl ? createProxiedRequest(target, proxyUrl, (res) => {
      const location = getLocation(res.headers.location);
      if (isRedirect(res.statusCode) && location) {
        res.resume();
        sendRequest(new URL(location, target).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      resolve(res);
    }, reject) : createDirectRequest(target, (res) => {
      const location = getLocation(res.headers.location);
      if (isRedirect(res.statusCode) && location) {
        res.resume();
        sendRequest(new URL(location, target).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      resolve(res);
    });

    req.on('error', reject);
    req.end();
  });
}

function readResponseText(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await sendRequest(url);
  if (res.statusCode !== 200) {
    throw new Error(`HTTP ${res.statusCode}`);
  }

  const data = await readResponseText(res);
  return JSON.parse(data) as T;
}

function fetchJsonArray(url: string): Promise<GitHubRelease[]> {
  return fetchJson<GitHubRelease[]>(url);
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const releases = await fetchJsonArray(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`);
    for (const r of releases) {
      const tag = r.tag_name;
      // Support both v* and tentacle-v* tag formats
      if (tag.startsWith('v')) {
        const version = tag.slice(1);
        // Skip non-tentacle releases (e.g. head-v*, web-v*)
        if (/^\d+\.\d+\.\d+/.test(version)) {
          // Only consider releases with CLI binary assets
          const hasBinary = r.assets?.some(a => a.name.startsWith('kraki-cli-'));
          if (hasBinary) return version;
        }
      } else if (tag.startsWith('tentacle-v')) {
        return tag.slice('tentacle-v'.length);
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Cached update check (for startup hint) ──────────────

interface UpdateCheckCache {
  latestVersion: string;
  checkedAt: number;
}

function getCachePath(): string {
  return join(getKrakiHome(), CHECK_CACHE_FILE);
}

function readCache(): UpdateCheckCache | null {
  try {
    const data = JSON.parse(readFileSync(getCachePath(), 'utf8'));
    if (Date.now() - data.checkedAt < CHECK_INTERVAL_MS) {
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(latestVersion: string): void {
  try {
    mkdirSync(getKrakiHome(), { recursive: true });
    writeFileSync(getCachePath(), JSON.stringify({ latestVersion, checkedAt: Date.now() }));
  } catch { /* ignore */ }
}

/**
 * Check for update with a timeout. Returns the latest version if newer, null otherwise.
 * Uses cache if available, otherwise fetches with a 2s timeout.
 */
export async function checkForUpdate(currentVersion: string, timeoutMs = 2000): Promise<string | null> {
  // Check cache first (instant)
  const cached = readCache();
  if (cached) {
    return isNewer(cached.latestVersion, currentVersion) ? cached.latestVersion : null;
  }

  // Fetch with timeout
  try {
    const latest = await Promise.race([
      fetchLatestVersion(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (latest) {
      writeCache(latest);
      return isNewer(latest, currentVersion) ? latest : null;
    }
  } catch { /* silent */ }
  return null;
}

function isNewer(latest: string, current: string): boolean {
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

// ── Update command ──────────────────────────────────────

export async function performUpdate(currentVersion: string): Promise<void> {
  const spinner = ora({ text: 'Checking for updates…', indent: 2 }).start();

  const latest = await fetchLatestVersion();
  if (!latest) {
    spinner.fail('Could not check for updates');
    return;
  }

  if (!isNewer(latest, currentVersion)) {
    spinner.succeed(`Already on the latest version (${currentVersion})`);
    return;
  }

  const method = detectInstallMethod();
  spinner.text = `Updating ${currentVersion} → ${latest}…`;

  try {
    switch (method) {
      case 'npm':
        await updateViaNpm(latest);
        break;
      case 'sea':
        await updateViaBinary(latest);
        break;
      default:
        spinner.fail('Cannot determine install method. Update manually.');
        return;
    }

    spinner.succeed(`Updated ${chalk.dim(currentVersion)} → ${chalk.green(latest)}`);
    writeCache(latest);

    // Restart daemon if running
    const { isDaemonRunning, stopDaemon, startDaemon, MacOSCodeSignatureError } = await import('./daemon.js');
    if (isDaemonRunning()) {
      console.log(chalk.dim('  Restarting daemon…'));
      stopDaemon();
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      if (config) {
        try {
          await startDaemon(config);
          console.log(chalk.green('  ✔ Daemon restarted'));
        } catch (restartErr) {
          if (restartErr instanceof MacOSCodeSignatureError) {
            console.log(chalk.yellow('  ⚠ macOS blocked the daemon — run `kraki start` to launch in foreground'));
          } else {
            console.log(chalk.red(`  Failed to restart daemon: ${(restartErr as Error).message}`));
          }
        }
      }
    }
  } catch (err) {
    spinner.fail(`Update failed: ${(err as Error).message}`);
  }
}

// ── npm update ──────────────────────────────────────────

async function updateViaNpm(version: string): Promise<void> {
  // Detect npm vs pnpm
  const scriptPath = process.argv[1] ?? '';
  const usePnpm = scriptPath.includes('.pnpm') || scriptPath.includes('pnpm');
  const cmd = usePnpm
    ? `pnpm add -g ${NPM_PACKAGE}@${version}`
    : `npm install -g ${NPM_PACKAGE}@${version}`;

  execSync(cmd, { stdio: 'pipe', encoding: 'utf8' });
}

// ── SEA binary update ───────────────────────────────────

function getPlatformAssetName(): string {
  const platform = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : process.platform;
  const arch = process.arch;
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `kraki-cli-${platform}-${arch}${ext}`;
}

async function updateViaBinary(version: string): Promise<void> {
  const assetName = getPlatformAssetName();
  // Try v* tag first, fall back to tentacle-v*
  let release: GitHubRelease;
  try {
    release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`);
  } catch {
    release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/tentacle-v${version}`);
  }

  const asset = release.assets?.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`No binary found for ${assetName} in release v${version}`);
  }

  const downloadUrl = asset.browser_download_url;
  const currentBinary = process.execPath;

  // Download to OS temp dir (always user-writable)
  const tmpPath = join(tmpdir(), assetName + '.update');

  // Download binary
  await downloadFile(downloadUrl, tmpPath);

  // Verify checksum if SHA256SUMS is available
  const checksumAsset = release.assets?.find((a) => a.name === 'SHA256SUMS.txt');
  if (checksumAsset) {
    const checksumData = await fetchText(checksumAsset.browser_download_url);
    const expectedHash = parseChecksum(checksumData, assetName);
    if (expectedHash) {
      const actualHash = hashFile(tmpPath);
      if (actualHash !== expectedHash) {
        unlinkSync(tmpPath);
        throw new Error(`Checksum mismatch for ${assetName}: expected ${expectedHash.slice(0, 12)}…, got ${actualHash.slice(0, 12)}…`);
      }
    }
  }

  // Make executable
  if (process.platform !== 'win32') {
    chmodSync(tmpPath, 0o755);
  }

  // Replace current binary — try direct first, sudo fallback for system dirs
  replaceBinary(tmpPath, currentBinary);
}

function replaceBinary(source: string, target: string): void {
  const backupPath = target + '.bak';

  try {
    renameSync(target, backupPath);
  } catch (err: unknown) {
    if (isPermissionError(err)) {
      replaceBinaryElevated(source, target);
      return;
    }
    try { unlinkSync(source); } catch { /* ignore */ }
    throw err;
  }

  try {
    // rename won't work cross-filesystem (tmpdir vs install dir), use copy
    copyFileSync(source, target);
    if (process.platform !== 'win32') chmodSync(target, 0o755);
    try { unlinkSync(source); } catch { /* ignore */ }
    try { unlinkSync(backupPath); } catch { /* ignore */ }
  } catch (err) {
    // Restore backup
    try { renameSync(backupPath, target); } catch { /* ignore */ }
    try { unlinkSync(source); } catch { /* ignore */ }
    throw err;
  }
}

function replaceBinaryElevated(source: string, target: string): void {
  try {
    execSync(
      `sudo cp "${source}" "${target}" && sudo chmod 755 "${target}"`,
      { stdio: 'inherit' },
    );
    try { unlinkSync(source); } catch { /* ignore */ }
  } catch {
    try { unlinkSync(source); } catch { /* ignore */ }
    throw new Error(
      `Permission denied. To fix, reinstall to a user-writable location:\n` +
      `  curl -fsSL https://kraki.corelli.cloud/install.sh | bash`,
    );
  }
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

function hashFile(path: string): string {
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

function parseChecksum(checksumData: string, assetName: string): string | null {
  for (const line of checksumData.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === assetName) {
      return parts[0];
    }
  }
  return null;
}

function fetchText(url: string): Promise<string> {
  return sendRequest(url).then(async (res) => {
    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return readResponseText(res);
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await sendRequest(url);
  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  const file = createWriteStream(dest);
  try {
    await pipeline(res, file);
  } catch (err) {
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }
}
