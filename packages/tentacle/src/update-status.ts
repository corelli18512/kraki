/**
 * Is a newer Kraki available for this computer, and how is it installed?
 *
 * Reported to apps in `device_greeting.update` so they can show "Update
 * available" on the computer. The daemon checks shortly after start and then
 * every few hours; a failed check keeps the previous answer.
 *
 * Kraki for Mac's built-in tentacle is updated together with the app, so for
 * it the comparison is between Mac app versions (Sparkle appcast), not
 * tentacle versions.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { isSea } from 'node:sea';
import type { DeviceUpdateInfo, KrakiInstallMethod } from '@kraki/protocol';
import { getVersion } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('update-status');

export const MAC_APPCAST_URL = 'https://raw.githubusercontent.com/corelli18512/kraki/mac-updates/appcast.xml';
export const UPDATE_CHECK_FIRST_DELAY_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 3600_000;

export interface InstallInfo {
  method: KrakiInstallMethod;
  /** What an update replaces: binary, .app bundle, npm package dir, or the Mac app. */
  target?: string;
  /** Kraki for Mac's version, for `mac-app`. */
  appVersion?: string;
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
  const readAppVersion = inputs.readAppVersion
    ?? ((app: string) => readPlistString(join(app, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'));

  // …/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki
  if (env.KRAKI_MANAGED_BY === 'kraki-mac') {
    const parts = exe.split('/');
    const i = parts.lastIndexOf('Library');
    if (i > 2 && parts[i - 1] === 'Contents') {
      const app = parts.slice(0, i - 1).join('/');
      return { method: 'mac-app', target: app, appVersion: readAppVersion(app) };
    }
    return { method: 'mac-app' };
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

export interface CheckDeps {
  fetchLatestTentacle: () => Promise<string | null>;
  fetchText: (url: string) => Promise<string>;
  isNewer: (a: string, b: string) => boolean;
}

async function defaultDeps(): Promise<CheckDeps> {
  const u = await import('./update.js');
  return { fetchLatestTentacle: u.fetchLatestVersion, fetchText: u.fetchText, isNewer: u.isNewer };
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
    let latestApp: string | undefined;
    try { latestApp = parseAppcastLatest(await d.fetchText(MAC_APPCAST_URL)); } catch { /* keep undefined */ }
    if (!latestApp && !latestTentacle) return null;
    return {
      installedVia: 'mac-app',
      current,
      ...(latestApp && d.isNewer(latestApp, current) ? { latest: latestApp } : {}),
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
