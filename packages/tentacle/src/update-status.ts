/**
 * Is a newer Kraki available for this computer, and how is it installed?
 *
 * Reported to apps in `device_greeting.update` so they can show "Update
 * available" on the computer. The daemon checks shortly after start and then
 * every few hours; a failed check keeps the previous answer.
 *
 * Kraki for Mac's built-in tentacle is updated together with the app, so for
 * it the comparison is between Mac app builds (Sparkle appcast), not
 * tentacle versions. The Mac follows the update channel chosen in Kraki for
 * Mac (Settings › General › Updates): Stable reads the production appcast,
 * Dogfood the dogfood feed (which also lists the newest formal release).
 *
 * Mac versions are reported so that every app orders them like Sparkle does
 * (by build): a formal build is its version (`0.2.92`), a dogfood build
 * (CFBundleVersion `<formal build>.<N>`) is `<version>-dev.<N>`
 * (`0.2.92-dev.28`). Semver puts `0.2.92-dev.28` below `0.2.92` and below
 * `0.2.93-dev.35`, as Sparkle does with builds 93.28 < 94 < 94.35, so
 * released iPhone/Mac apps (prerelease-aware `KrakiVersion.isNewer`) compare
 * them correctly without knowing about builds. Web apps before 2026-11 ignore
 * the prerelease part.
 *
 * Kraki for Windows' built-in tentacle is likewise updated with the app: the
 * comparison is between Windows app versions (the version the app records in
 * managed-by.json against the newest formal `win-v*` release).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { isSea } from 'node:sea';
import type { DeviceUpdateInfo, KrakiInstallMethod } from '@kraki/protocol';
import { getVersion } from './config.js';
import { createLogger } from './logger.js';
import { loadManagedBy, sameWindowsPath, WINDOWS_APP_OWNER, type ManagedByMarker } from './managed.js';

const logger = createLogger('update-status');

export const MAC_APPCAST_URL = 'https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml';
/** Kraki for Mac's Dogfood channel (MacUpdateChannel.dogfoodFeedURL). */
export const MAC_DOGFOOD_APPCAST_URL = 'https://github.com/corelli18512/kraki/releases/download/dogfood-mac/appcast-dogfood.xml';
export type MacUpdateChannel = 'stable' | 'dogfood';
export const UPDATE_CHECK_FIRST_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;

export interface InstallInfo {
  method: KrakiInstallMethod;
  /** What an update replaces: binary, .app bundle, npm package dir, the Mac
   *  app, or Kraki for Windows' `Kraki.exe` (its directory is the install). */
  target?: string;
  /** Kraki for Mac's version as reported (`0.2.92`, or `0.2.92-dev.28` for a
   *  dogfood build), for `mac-app`; Kraki for Windows' version, for `windows-app`. */
  appVersion?: string;
  /** Kraki for Mac's CFBundleVersion (`94`, or `93.28` for a dogfood build). */
  appBuild?: string;
  /** Kraki for Mac's bundle identifier: where its update channel is stored. */
  appBundleId?: string;
}

/** `0.2.92` + `93.28` → `0.2.92-dev.28`; a formal build (`94`) keeps its version. */
export function macVersionLabel(version: string, build?: string): string {
  const n = build?.match(/^\d+\.(\d+)$/)?.[1];
  return n ? `${version}-dev.${n}` : version;
}

/** Sparkle's order for our CFBundleVersions: numeric, part by part. */
export function compareBuilds(a: string, b: string): number {
  const x = a.split('.').map((n) => Number.parseInt(n, 10) || 0), y = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The channel Kraki for Mac follows (its own defaults; Stable unless set). */
export function readMacUpdateChannel(bundleId: string | undefined): MacUpdateChannel {
  if (!bundleId || process.platform !== 'darwin') return 'stable';
  const r = spawnSync('/usr/bin/defaults', ['read', bundleId, 'mac.updateChannel'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && r.stdout.trim() === 'dogfood' ? 'dogfood' : 'stable';
}

export function readPlistString(plistPath: string, key: string): string | undefined {
  try {
    const xml = readFileSync(plistPath, 'utf8');
    const m = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    return m?.[1];
  } catch { return undefined; }
}

export interface DetectInputs {
  env?: NodeJS.ProcessEnv;
  sea?: boolean;
  platform?: NodeJS.Platform;
  execPath?: string;
  scriptPath?: string;
  readPackageName?: (dir: string) => string | undefined;
  readAppVersion?: (appPath: string) => string | undefined;
  readAppBuild?: (appPath: string) => string | undefined;
  readAppBundleId?: (appPath: string) => string | undefined;
  readManagedBy?: () => ManagedByMarker | null;
}

/** `…\Kraki\resources\kraki\kraki.exe` → `…\Kraki\Kraki.exe`. */
export function windowsAppFromDaemon(exe: string): string | undefined {
  const m = exe.match(/^(.+)([\\/])resources\2kraki\2kraki\.exe$/i);
  return m ? `${m[1]}${m[2]}Kraki.exe` : undefined;
}

/** The built-in kraki.exe of a Kraki for Windows install. */
export function windowsAppDaemon(appExe: string): string {
  const m = appExe.match(/^(.+)([\\/])[^\\/]+$/);
  return m ? [m[1], 'resources', 'kraki', 'kraki.exe'].join(m[2]) : appExe;
}

/**
 * Kraki for Windows records its path and version in managed-by.json
 * (packages/desktop src/tentacle.cjs). The version counts only when the marker
 * names the app this kraki.exe belongs to.
 */
function detectWindowsApp(exe: string, marker: ManagedByMarker | null): InstallInfo {
  const owned = marker?.by === WINDOWS_APP_OWNER ? marker : null;
  const target = windowsAppFromDaemon(exe) ?? owned?.appPath;
  const appVersion = owned?.appPath && owned.appVersion && target && sameWindowsPath(owned.appPath, target)
    ? owned.appVersion : undefined;
  return { method: 'windows-app', ...(target ? { target } : {}), ...(appVersion ? { appVersion } : {}) };
}

function defaultPackageName(dir: string): string | undefined {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return undefined;
  try { return (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name; } catch { return undefined; }
}

function realpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export function detectInstall(inputs: DetectInputs = {}): InstallInfo {
  const env = inputs.env ?? process.env;
  const sea = inputs.sea ?? isSea();
  const plat = inputs.platform ?? process.platform;
  const exe = inputs.execPath ?? realpath(process.execPath);
  const plist = (key: string) => (app: string) => readPlistString(join(app, 'Contents', 'Info.plist'), key);
  const readAppVersion = inputs.readAppVersion ?? plist('CFBundleShortVersionString');
  const readAppBuild = inputs.readAppBuild ?? plist('CFBundleVersion');
  const readAppBundleId = inputs.readAppBundleId ?? plist('CFBundleIdentifier');

  // …/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki
  if (env.KRAKI_MANAGED_BY === 'kraki-mac') {
    const parts = exe.split('/');
    const i = parts.lastIndexOf('Library');
    if (i > 2 && parts[i - 1] === 'Contents') {
      const app = parts.slice(0, i - 1).join('/');
      const version = readAppVersion(app);
      const build = readAppBuild(app);
      const bundleId = readAppBundleId(app);
      return {
        method: 'mac-app', target: app,
        appVersion: version && macVersionLabel(version, build),
        ...(build ? { appBuild: build } : {}),
        ...(bundleId ? { appBundleId: bundleId } : {}),
      };
    }
    return { method: 'mac-app' };
  }
  // …\Kraki\resources\kraki\kraki.exe, run by Kraki for Windows.
  if (env.KRAKI_MANAGED_BY === 'kraki-windows' || (sea && plat === 'win32' && /[\\/]resources[\\/]kraki[\\/]kraki\.exe$/i.test(exe))) {
    return detectWindowsApp(exe, (inputs.readManagedBy ?? (() => loadManagedBy()))());
  }
  if (sea) {
    if (plat === 'darwin') {
      const macos = dirname(exe);
      const app = dirname(dirname(macos));
      if (basename(macos) === 'MacOS' && app.endsWith('.app')) return { method: 'app-bundle', target: app };
    }
    return { method: 'binary', target: exe };
  }
  const script = inputs.scriptPath ?? realpath(process.argv[1] ?? '');
  const readName = inputs.readPackageName ?? defaultPackageName;
  let d = dirname(script);
  for (let k = 0; k < 4 && d && d !== dirname(d); k++) {
    if (readName(d) === '@kraki/tentacle') {
      return d.split(sep).includes('node_modules') || d.split('/').includes('node_modules')
        ? { method: 'npm', target: d }
        : { method: 'unknown' };
    }
    d = dirname(d);
  }
  return { method: 'unknown' };
}

/** Newest Kraki for Mac version in the Sparkle appcast (first item). */
export function parseAppcastLatest(xml: string): string | undefined {
  return xml.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/)?.[1]?.trim();
}

export interface AppcastItem {
  version: string;
  /** CFBundleVersion (`sparkle:version`). */
  build: string;
  url?: string;
}

export function parseAppcastItems(xml: string): AppcastItem[] {
  const items: AppcastItem[] = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0];
    const version = it.match(/<sparkle:shortVersionString>([^<]+)</)?.[1]?.trim();
    const build = it.match(/<sparkle:version>([^<]+)</)?.[1]?.trim()
      ?? it.match(/sparkle:version="([^"]+)"/)?.[1]?.trim();
    const url = it.match(/<enclosure\b[^>]*\burl="([^"]+)"/)?.[1];
    if (version && build) items.push({ version, build, ...(url ? { url } : {}) });
  }
  return items;
}

/** The highest build in a feed: what Sparkle offers. */
export function newestAppcastItem(xml: string): AppcastItem | undefined {
  return parseAppcastItems(xml).reduce<AppcastItem | undefined>((best, it) => (!best || compareBuilds(it.build, best.build) > 0 ? it : best), undefined);
}

/** Where a Kraki for Mac version is downloaded from: a GitHub release asset of
 *  this repository, only `mac-v*` or `dogfood-mac`. */
export interface MacAppDownload {
  tag: string;
  asset: string;
  /** The CFBundleVersion the feed promised: the downloaded app must carry it. */
  build?: string;
}

export function macAppDownloadFromUrl(url: string | undefined): MacAppDownload | undefined {
  const m = url?.match(/^https:\/\/github\.com\/corelli18512\/kraki\/releases\/download\/((?:mac-v[0-9][0-9A-Za-z.-]*)|dogfood-mac)\/([A-Za-z0-9._-]+\.app\.zip)$/);
  return m ? { tag: m[1], asset: m[2] } : undefined;
}

/** Downloads of the versions the last check reported, by reported version. */
const macDownloads = new Map<string, MacAppDownload>();

/** Where to download `version` (as reported in `latest`); formal releases by tag otherwise. */
export function macAppDownload(version: string): MacAppDownload {
  return macDownloads.get(version) ?? { tag: `mac-v${version}`, asset: 'Kraki.app.zip' };
}

export interface CheckDeps {
  fetchLatestTentacle: () => Promise<string | null>;
  fetchText: (url: string) => Promise<string>;
  isNewer: (a: string, b: string) => boolean;
  /** Kraki for Mac's update channel (default: read from its defaults). */
  macChannel?: (bundleId: string | undefined) => MacUpdateChannel;
  /** Newest formal Kraki for Windows version (`win-v*` releases). */
  fetchLatestWindowsApp?: () => Promise<string | null>;
}

async function defaultDeps(): Promise<CheckDeps> {
  const u = await import('./update.js');
  return {
    // The GitHub API allows 60 unauthenticated requests an hour per IP, which
    // shared networks (offices, CI) run out of; npm publishes the same version
    // in the same release job, without such a limit.
    fetchLatestTentacle: async () => (await u.fetchLatestVersion())
      ?? (await u.fetchJson<{ version?: string }>('https://registry.npmjs.org/@kraki/tentacle/latest').then((j) => j.version ?? null, () => null)),
    fetchText: u.fetchText,
    isNewer: u.isNewer,
    fetchLatestWindowsApp: () => u.fetchLatestWindowsAppVersion(),
  };
}

/**
 * One check. Returns null when nothing could be learnt (offline, rate
 * limited); the caller keeps its previous answer then.
 */
export async function checkUpdateStatus(
  install: InstallInfo = detectInstall(),
  tentacleVersion: string = getVersion(),
  deps?: CheckDeps,
  now: () => Date = () => new Date(),
  remote: Pick<DeviceUpdateInfo, 'remote' | 'remoteBlock'> = {},
): Promise<DeviceUpdateInfo | null> {
  const d = deps ?? await defaultDeps();
  const latestTentacle = (await d.fetchLatestTentacle().catch(() => null)) ?? undefined;
  if (install.method === 'mac-app') {
    const current = install.appVersion;
    if (!current) return null;
    const channel = (d.macChannel ?? readMacUpdateChannel)(install.appBundleId);
    let newest: AppcastItem | undefined;
    try {
      newest = newestAppcastItem(await d.fetchText(channel === 'dogfood' ? MAC_DOGFOOD_APPCAST_URL : MAC_APPCAST_URL));
    } catch { /* keep undefined */ }
    if (!newest && !latestTentacle) return null;
    let latest: string | undefined;
    if (newest) {
      const label = macVersionLabel(newest.version, newest.build);
      // By build, as Sparkle decides; an app that predates appBuild compares versions.
      const newer = install.appBuild ? compareBuilds(newest.build, install.appBuild) > 0 : d.isNewer(label, current);
      if (newer) {
        latest = label;
        const download = macAppDownloadFromUrl(newest.url);
        if (download) macDownloads.set(label, { ...download, build: newest.build });
      }
    }
    return {
      installedVia: 'mac-app',
      current,
      ...(latest ? { latest } : {}),
      ...(latestTentacle ? { latestTentacle } : {}),
      ...remote,
      checkedAt: now().toISOString(),
    };
  }
  // Without the app's version (no managed-by.json for this install), report
  // tentacle versions as tentacles before 0.39 did; it can't be updated remotely then.
  if (install.method === 'windows-app' && install.appVersion) {
    const current = install.appVersion;
    const newest = (await d.fetchLatestWindowsApp?.().catch(() => null)) ?? undefined;
    if (!newest && !latestTentacle) return null;
    return {
      installedVia: 'windows-app',
      current,
      ...(newest && d.isNewer(newest, current) ? { latest: newest } : {}),
      ...(latestTentacle ? { latestTentacle } : {}),
      ...remote,
      checkedAt: now().toISOString(),
    };
  }
  if (!latestTentacle) return null;
  return {
    installedVia: install.method,
    current: tentacleVersion,
    ...(d.isNewer(latestTentacle, tentacleVersion) ? { latest: latestTentacle } : {}),
    latestTentacle,
    ...remote,
    checkedAt: now().toISOString(),
  };
}

/** Check now-ish and then periodically; call `onChange` when the answer changes. */
export function watchUpdateStatus(
  onChange: (info: DeviceUpdateInfo) => void,
  install: InstallInfo = detectInstall(),
  remote: () => Pick<DeviceUpdateInfo, 'remote' | 'remoteBlock'> = () => ({}),
): { stop: () => void; checkNow: () => Promise<void> } {
  let last = '';
  const run = async () => {
    try {
      const info = await checkUpdateStatus(install, getVersion(), undefined, undefined, remote());
      if (!info) return;
      if (info.latestTentacle) {
        const { writeCache } = await import('./update.js');
        writeCache(info.latestTentacle);
      }
      const key = JSON.stringify({ ...info, checkedAt: undefined });
      if (key !== last) {
        last = key;
        logger.info({ update: info }, 'Update status');
        onChange(info);
      }
    } catch (err) {
      logger.debug({ err }, 'Update check failed');
    }
  };
  const first = setTimeout(run, UPDATE_CHECK_FIRST_DELAY_MS);
  const every = setInterval(run, UPDATE_CHECK_INTERVAL_MS);
  first.unref(); every.unref();
  return { stop: () => { clearTimeout(first); clearInterval(every); }, checkNow: run };
}
