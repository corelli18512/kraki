import { describe, expect, it } from 'vitest';
import type { DeviceSummary, DeviceUpdateInfo } from '@kraki/protocol';
import { availableUpdate, displayVersion, isNewerVersion, updateHowTo, updateTitle } from './device-update';

const t = (id: string): DeviceSummary => ({ id, name: id, role: 'tentacle', online: true });

describe('device-update', () => {
  it('compares versions numerically', () => {
    expect(isNewerVersion('0.36.0', '0.35.12')).toBe(true);
    expect(isNewerVersion('0.35.12', '0.35.10-poc')).toBe(true);
    expect(isNewerVersion('0.2.9', '0.2.10')).toBe(false);
    expect(isNewerVersion('0.36.0', '0.36.0')).toBe(false);
  });
  it('orders pre-releases as semver does, like the tentacle and iOS/Mac', () => {
    // A dogfood build sorts below its release and among its own builds.
    expect(isNewerVersion('0.2.92', '0.2.92-dev.28')).toBe(true);
    expect(isNewerVersion('0.2.92-dev.28', '0.2.92')).toBe(false);
    expect(isNewerVersion('0.2.93-dev.36', '0.2.93-dev.35')).toBe(true);
    expect(isNewerVersion('0.2.93-dev.35', '0.2.93-dev.36')).toBe(false);
    expect(isNewerVersion('0.2.93-dev.35', '0.2.92')).toBe(true);
    expect(isNewerVersion('1.2.0-beta.10', '1.2.0-beta.9')).toBe(true);
    expect(isNewerVersion('1.2.0-rc.1', '1.2.0-beta.3')).toBe(true);
    expect(isNewerVersion('1.2.0-beta', '1.2.0-beta')).toBe(false);
    expect(isNewerVersion('1.2.0-beta.1', '1.2.0-beta')).toBe(true);
    // Alphanumeric identifiers outrank numeric ones.
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-1')).toBe(true);
  });
  it('offers a Mac on Dogfood the newer dogfood build', () => {
    const u = new Map<string, DeviceUpdateInfo>([['m', { installedVia: 'mac-app', current: '0.2.93-dev.35', latest: '0.2.93-dev.36' }]]);
    expect(availableUpdate(t('m'), u, new Map())?.latest).toBe('0.2.93-dev.36');
  });
  it('uses the reported update', () => {
    const u = new Map<string, DeviceUpdateInfo>([['a', { installedVia: 'npm', current: '0.35.12', latest: '0.36.0', latestTentacle: '0.36.0' }]]);
    expect(availableUpdate(t('a'), u, new Map())).toEqual({ latest: '0.36.0', installedVia: 'npm', remote: false });
  });
  it('infers an update for a computer that predates reporting', () => {
    const u = new Map<string, DeviceUpdateInfo>([['new', { installedVia: 'binary', current: '0.36.0', latestTentacle: '0.36.0' }]]);
    const v = new Map([['old', '0.35.9']]);
    const r = availableUpdate(t('old'), u, v);
    expect(r?.installedVia).toBe('legacy');
    expect(updateHowTo(r!)).toContain('kraki update');
    expect(availableUpdate(t('new'), u, v)).toBeNull();
  });
  it('shows Kraki for Mac versions for the built-in tentacle', () => {
    const u = new Map<string, DeviceUpdateInfo>([['m', { installedVia: 'mac-app', current: '0.2.68', latest: '0.2.70' }]]);
    expect(displayVersion('m', u, new Map([['m', '0.35.12']]))).toBe('Kraki for Mac 0.2.68');
    expect(updateHowTo(availableUpdate(t('m'), u, new Map())!)).toContain('Check for Updates');
  });
});

describe('Kraki for Windows', () => {
  it('names Kraki for Windows with the app\'s version', () => {
    const u = new Map<string, DeviceUpdateInfo>([['w', { installedVia: 'windows-app', current: '0.1.11', latest: '0.1.12', latestTentacle: '0.39.0', remote: true }]]);
    const v = new Map([['w', '0.39.0']]);
    expect(displayVersion('w', u, v)).toBe('Kraki for Windows 0.1.11');
    const a = availableUpdate(t('w'), u, v)!;
    expect(a).toEqual({ latest: '0.1.12', installedVia: 'windows-app', remote: true });
    expect(updateTitle(a)).toBe('Kraki for Windows 0.1.12 is available');
    expect(updateHowTo(a)).toContain('Kraki for Windows');
  });
  it('an older built-in tentacle reported its own version: still "Kraki"', () => {
    const u = new Map<string, DeviceUpdateInfo>([['w', { installedVia: 'windows-app', current: '0.38.11', latest: '0.39.0', latestTentacle: '0.39.0', remote: false, remoteBlock: 'unsupported' }]]);
    const v = new Map([['w', '0.38.11']]);
    expect(displayVersion('w', u, v)).toBe('Kraki 0.38.11');
    const a = availableUpdate(t('w'), u, v)!;
    expect(updateTitle(a)).toBe('Kraki 0.39.0 is available');
    expect(updateHowTo(a)).toContain('Kraki for Windows');
  });
});

describe('remote update progress', () => {
  it('a greeting from the new version marks the update done', async () => {
    const { useStore } = await import('../hooks/useStore');
    const s = useStore.getState();
    s.setUpdateProgress('pc', { phase: 'installing', from: '0.35.12', to: '0.36.0', at: Date.now() });
    s.setDeviceUpdate('pc', { installedVia: 'binary', current: '0.36.0', latestTentacle: '0.36.0' });
    expect(useStore.getState().updateProgress.get('pc')?.phase).toBe('updated');
  });
});
