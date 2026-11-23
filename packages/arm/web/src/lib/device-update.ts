import { t } from '../i18n';
// "Is a newer Kraki available on this computer?" — see protocol DeviceUpdateInfo.
// Tentacles ≥ 0.36 report it in device_greeting.update; older ones are compared
// with the newest tentacle any computer on the account has seen published.
import type { DeviceSummary, DeviceUpdateInfo } from '@kraki/protocol';

export interface AvailableUpdate {
  latest: string;
  /** Install method, or `legacy` when inferred for an older computer. */
  installedVia: string;
  remote: boolean;
  /** A Kraki for Windows whose built-in tentacle predates reporting the app's
   *  version: `latest` is a tentacle version. */
  tentacleVersions?: boolean;
}

/**
 * Kraki for Windows reports the app's version (`0.1.12`) since tentacle 0.39;
 * its older built-in tentacles reported their own, which is also the
 * greeting's `version`.
 */
function reportsTentacleVersion(info: DeviceUpdateInfo, tentacleVersion: string | undefined): boolean {
  return info.installedVia === 'windows-app' && info.current === tentacleVersion;
}

function split(v: string): { core: number[]; pre: string[] } {
  const [core, pre = ''] = v.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
  return { core: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] };
}

/** Semantic-version order, pre-releases included (`0.2.92-dev.28` < `0.2.92`),
 *  as the tentacle (`update.ts isNewer`) and iOS/Mac (`KrakiVersion.isNewer`). */
export function isNewerVersion(a: string, b: string): boolean {
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length, 3); i++) {
    const l = x.core[i] ?? 0;
    const r = y.core[i] ?? 0;
    if (l !== r) return l > r;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === 0 && y.pre.length > 0;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const l = x.pre[i];
    const r = y.pre[i];
    if (l === r) continue;
    const nl = /^\d+$/.test(l);
    const nr = /^\d+$/.test(r);
    if (nl && nr) return Number(l) > Number(r);
    if (nl !== nr) return nr; // alphanumeric outranks numeric
    return l > r;
  }
  return x.pre.length > y.pre.length;
}

export function knownLatestTentacle(updates: Map<string, DeviceUpdateInfo>): string | undefined {
  let best: string | undefined;
  for (const u of updates.values()) {
    if (u.latestTentacle && (!best || isNewerVersion(u.latestTentacle, best))) best = u.latestTentacle;
  }
  return best;
}

export function availableUpdate(
  device: DeviceSummary,
  updates: Map<string, DeviceUpdateInfo>,
  versions: Map<string, string>,
): AvailableUpdate | null {
  const info = updates.get(device.id);
  if (info) {
    if (!info.latest || !isNewerVersion(info.latest, info.current)) return null;
    return {
      latest: info.latest, installedVia: info.installedVia, remote: info.remote === true,
      ...(reportsTentacleVersion(info, versions.get(device.id)) ? { tentacleVersions: true } : {}),
    };
  }
  if (device.role !== 'tentacle') return null;
  const version = versions.get(device.id);
  const newest = knownLatestTentacle(updates);
  return version && newest && isNewerVersion(newest, version)
    ? { latest: newest, installedVia: 'legacy', remote: false }
    : null;
}

/** The apps that ship Kraki report their own version (`current`, `latest`):
 *  name the app with it. */
function productName(installedVia: string, tentacleVersions = false): string {
  if (installedVia === 'mac-app') return 'Kraki for Mac';
  if (installedVia === 'windows-app' && !tentacleVersions) return 'Kraki for Windows';
  return 'Kraki';
}

export function displayVersion(deviceId: string, updates: Map<string, DeviceUpdateInfo>, versions: Map<string, string>): string | undefined {
  const info = updates.get(deviceId);
  const v = versions.get(deviceId);
  if (info && productName(info.installedVia, reportsTentacleVersion(info, v)) !== 'Kraki') {
    return `${productName(info.installedVia)} ${info.current}`;
  }
  return v ? `Kraki ${v}` : undefined;
}

/** The version an update's `from`/`to` name: Kraki for Mac and Kraki for
 *  Windows report the app's (`current`), every other install its tentacle's
 *  (the greeting's `version`). */
export function reportedVersion(deviceId: string, updates: Map<string, DeviceUpdateInfo>, versions: Map<string, string>): string | undefined {
  const info = updates.get(deviceId);
  const v = versions.get(deviceId);
  if (info && productName(info.installedVia, reportsTentacleVersion(info, v)) !== 'Kraki') return info.current;
  return v;
}

export function updateTitle(u: AvailableUpdate): string {
  return t('devices:updateHelp.available', { product: productName(u.installedVia, u.tentacleVersions), version: u.latest });
}

export function updateHowTo(u: AvailableUpdate): string {
  if (u.installedVia === 'mac-app') return t('devices:updateHelp.mac');
  if (u.installedVia === 'windows-app') return t('devices:updateHelp.windows');
  if (u.installedVia === 'legacy') return t('devices:updateHelp.legacy');
  return t('devices:updateHelp.cli');
}

export type UpdatePhase = 'requested' | import('@kraki/protocol').DeviceUpdatePhase;

/** A remote update in flight or just finished (not persisted). */
export interface UpdateProgress {
  phase: UpdatePhase;
  requestId?: string;
  from?: string;
  to?: string;
  progress?: number;
  runningSessions?: number;
  error?: string;
  at: number;
}

export function isActivePhase(p: UpdatePhase): boolean {
  return p === 'requested' || p === 'waiting_idle' || p === 'downloading' || p === 'installing';
}
