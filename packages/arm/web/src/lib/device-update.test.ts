import { describe, expect, it } from 'vitest';
import type { DeviceSummary, DeviceUpdateInfo } from '@kraki/protocol';
import { availableUpdate, displayVersion, isNewerVersion, updateHowTo } from './device-update';

const t = (id: string): DeviceSummary => ({ id, name: id, role: 'tentacle', online: true });

describe('device-update', () => {
  it('compares versions numerically, ignoring a pre-release suffix', () => {
    expect(isNewerVersion('0.36.0', '0.35.12')).toBe(true);
    expect(isNewerVersion('0.35.12', '0.35.10-poc')).toBe(true);
    expect(isNewerVersion('0.2.9', '0.2.10')).toBe(false);
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

describe('remote update progress', () => {
  it('a greeting from the new version marks the update done', async () => {
    const { useStore } = await import('../hooks/useStore');
    const s = useStore.getState();
    s.setUpdateProgress('pc', { phase: 'installing', from: '0.35.12', to: '0.36.0', at: Date.now() });
    s.setDeviceUpdate('pc', { installedVia: 'binary', current: '0.36.0', latestTentacle: '0.36.0' });
    expect(useStore.getState().updateProgress.get('pc')?.phase).toBe('updated');
  });
});
