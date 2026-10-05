import { describe, expect, it } from 'vitest';
import { checkUpdateStatus, detectInstall, parseAppcastLatest, type CheckDeps } from '../update-status.js';
import { isNewer } from '../update.js';

const now = () => new Date('2026-10-05T00:00:00Z');
function deps(tentacle: string | null, appcast?: string | Error): CheckDeps {
  return {
    fetchLatestTentacle: async () => tentacle,
    fetchText: async () => { if (appcast instanceof Error) throw appcast; return appcast ?? ''; },
    isNewer,
  };
}
const APPCAST = '<rss><channel><item><sparkle:shortVersionString>0.2.70</sparkle:shortVersionString></item>'
  + '<item><sparkle:shortVersionString>0.2.69</sparkle:shortVersionString></item></channel></rss>';

describe('detectInstall', () => {
  it('Kraki for Mac helper → mac-app, with the app version', () => {
    const r = detectInstall({
      env: { KRAKI_MANAGED_BY: 'kraki-mac' }, sea: true, platform: 'darwin',
      execPath: '/Applications/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki',
      readAppVersion: (app) => (app === '/Applications/Kraki.app' ? '0.2.68' : undefined),
    });
    expect(r).toEqual({ method: 'mac-app', target: '/Applications/Kraki.app', appVersion: '0.2.68' });
  });
  it('CLI .app bundle on macOS → app-bundle', () => {
    expect(detectInstall({ env: {}, sea: true, platform: 'darwin', execPath: '/Users/a/.kraki/app/Kraki.app/Contents/MacOS/kraki' }))
      .toEqual({ method: 'app-bundle', target: '/Users/a/.kraki/app/Kraki.app' });
  });
  it('single executable → binary', () => {
    expect(detectInstall({ env: {}, sea: true, platform: 'linux', execPath: '/home/a/.local/bin/kraki' }))
      .toEqual({ method: 'binary', target: '/home/a/.local/bin/kraki' });
  });
  it('global npm package → npm', () => {
    const r = detectInstall({
      env: {}, sea: false, platform: 'linux', scriptPath: '/usr/lib/node_modules/@kraki/tentacle/dist/cli.js',
      readPackageName: (d) => (d === '/usr/lib/node_modules/@kraki/tentacle' ? '@kraki/tentacle' : undefined),
    });
    expect(r).toEqual({ method: 'npm', target: '/usr/lib/node_modules/@kraki/tentacle' });
  });
  it('a source checkout → unknown', () => {
    const r = detectInstall({
      env: {}, sea: false, platform: 'linux', scriptPath: '/src/kraki/packages/tentacle/dist/cli.js',
      readPackageName: (d) => (d === '/src/kraki/packages/tentacle' ? '@kraki/tentacle' : undefined),
    });
    expect(r.method).toBe('unknown');
  });
});

describe('checkUpdateStatus', () => {
  it('CLI with a newer release reports latest', async () => {
    expect(await checkUpdateStatus({ method: 'binary' }, '0.35.12', deps('0.36.0'), now)).toEqual({
      installedVia: 'binary', current: '0.35.12', latest: '0.36.0', latestTentacle: '0.36.0', checkedAt: '2026-10-05T00:00:00.000Z',
    });
  });
  it('CLI up to date: no latest, still reports latestTentacle', async () => {
    const r = await checkUpdateStatus({ method: 'npm' }, '0.36.0', deps('0.36.0'), now);
    expect(r?.latest).toBeUndefined();
    expect(r?.latestTentacle).toBe('0.36.0');
  });
  it('Mac app compares app versions from the appcast', async () => {
    const r = await checkUpdateStatus({ method: 'mac-app', appVersion: '0.2.68' }, '0.35.12', deps('0.36.0', APPCAST), now);
    expect(r).toMatchObject({ installedVia: 'mac-app', current: '0.2.68', latest: '0.2.70', latestTentacle: '0.36.0' });
  });
  it('Mac app already on the newest app: no latest even if a tentacle is newer', async () => {
    const r = await checkUpdateStatus({ method: 'mac-app', appVersion: '0.2.70' }, '0.35.12', deps('0.36.0', APPCAST), now);
    expect(r?.latest).toBeUndefined();
  });
  it('nothing learnt (offline) → null, so the previous answer is kept', async () => {
    expect(await checkUpdateStatus({ method: 'binary' }, '0.35.12', deps(null), now)).toBeNull();
    expect(await checkUpdateStatus({ method: 'mac-app', appVersion: '0.2.68' }, '0.35.12', deps(null, new Error('x')), now)).toBeNull();
  });
});

describe('parseAppcastLatest', () => {
  it('takes the first item', () => expect(parseAppcastLatest(APPCAST)).toBe('0.2.70'));
  it('empty feed', () => expect(parseAppcastLatest('<rss/>')).toBeUndefined());
});
