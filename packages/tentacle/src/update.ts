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
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, unlinkSync, chmodSync, renameSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { get as httpsGet } from 'node:https';
import { createHash } from 'node:crypto';
import { isSea } from 'node:sea';
import chalk from 'chalk';
import ora from 'ora';
import { getKrakiHome } from './config.js';

const GITHUB_REPO = 'corelli18512/kraki';
const NPM_PACKAGE = '@kraki/tentacle';
const CHECK_CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function fetchJson(url: string): Promise<GitHubRelease> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'kraki-updater' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchJson(res.headers.location!).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const data = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
    const tag = data.tag_name as string;
    return tag.startsWith('v') ? tag.slice(1) : tag;
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
    const { isDaemonRunning, stopDaemon, startDaemon } = await import('./daemon.js');
    if (isDaemonRunning()) {
      console.log(chalk.dim('  Restarting daemon…'));
      stopDaemon();
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      if (config) {
        startDaemon(config);
        console.log(chalk.green('  ✔ Daemon restarted'));
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
  return `kraki-${platform}-${arch}${ext}`;
}

async function updateViaBinary(version: string): Promise<void> {
  const assetName = getPlatformAssetName();
  const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/v${version}`;

  const release = await fetchJson(releaseUrl);
  const asset = release.assets?.find((a) => a.name === assetName);
  if (!asset) {
    throw new Error(`No binary found for ${assetName} in release v${version}`);
  }

  const downloadUrl = asset.browser_download_url;
  const currentBinary = process.execPath;
  const tmpPath = currentBinary + '.update';

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

  // Replace current binary
  const backupPath = currentBinary + '.bak';
  try {
    renameSync(currentBinary, backupPath);
    renameSync(tmpPath, currentBinary);
    try { unlinkSync(backupPath); } catch { /* keep backup if delete fails */ }
  } catch (err) {
    try { renameSync(backupPath, currentBinary); } catch { /* ignore */ }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
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
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'kraki-updater' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchText(res.headers.location!).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'kraki-updater' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location!, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { unlinkSync(dest); reject(err); });
    }).on('error', reject);
  });
}
