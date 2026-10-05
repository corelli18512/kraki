// "Is a newer Kraki available on this computer?" — see protocol DeviceUpdateInfo.
// Tentacles ≥ 0.36 report it in device_greeting.update; older ones are compared
// with the newest tentacle any computer on the account has seen published.
import type { DeviceSummary, DeviceUpdateInfo } from '@kraki/protocol';

export interface AvailableUpdate {
  latest: string;
  /** Install method, or `legacy` when inferred for an older computer. */
  installedVia: string;
  remote: boolean;
}

function parts(v: string): number[] {
  return v.split('-', 1)[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
}

export function isNewerVersion(a: string, b: string): boolean {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const l = x[i] ?? 0;
    const r = y[i] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
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
    return info.latest && isNewerVersion(info.latest, info.current)
      ? { latest: info.latest, installedVia: info.installedVia, remote: info.remote === true }
      : null;
  }
  if (device.role !== 'tentacle') return null;
  const version = versions.get(device.id);
  const newest = knownLatestTentacle(updates);
  return version && newest && isNewerVersion(newest, version)
    ? { latest: newest, installedVia: 'legacy', remote: false }
    : null;
}

export function displayVersion(deviceId: string, updates: Map<string, DeviceUpdateInfo>, versions: Map<string, string>): string | undefined {
  const info = updates.get(deviceId);
  if (info?.installedVia === 'mac-app') return `Kraki for Mac ${info.current}`;
  const v = versions.get(deviceId);
  return v ? `Kraki ${v}` : undefined;
}

export function updateTitle(u: AvailableUpdate): string {
  return `${u.installedVia === 'mac-app' ? 'Kraki for Mac' : 'Kraki'} ${u.latest} is available`;
}

export function updateHowTo(u: AvailableUpdate): string {
  if (u.installedVia === 'mac-app') return 'Open Kraki on that Mac and choose Kraki → Check for Updates…';
  if (u.installedVia === 'legacy') return 'Update Kraki on that computer: Check for Updates in Kraki for Mac, or run `kraki update`.';
  return 'Run `kraki update` on that computer.';
}
