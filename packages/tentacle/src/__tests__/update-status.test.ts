import { describe, expect, it } from 'vitest';
import {
  checkUpdateStatus, compareBuilds, detectInstall, MAC_APPCAST_URL, MAC_DOGFOOD_APPCAST_URL, macAppDownload,
  macAppDownloadFromUrl, macVersionLabel, newestAppcastItem, parseAppcastLatest, type CheckDeps,
} from '../update-status.js';
import { isNewer } from '../update.js';

const now = () => new Date('2026-10-05T00:00:00Z');
function deps(tentacle: string | null, appcast?: string | Error): CheckDeps {
  return {
    fetchLatestTentacle: async () => tentacle,
    fetchText: async () => { if (appcast instanceof Error) throw appcast; return appcast ?? ''; },
    isNewer,
  };
}
const APPCAST = '<rss><channel><item><sparkle:version>72</sparkle:version><sparkle:shortVersionString>0.2.70</sparkle:shortVersionString></item>'
  + '<item><sparkle:version>71</sparkle:version><sparkle:shortVersionString>0.2.69</sparkle:shortVersionString></item></channel></rss>';

describe('detectInstall', () => {
  it('Kraki for Windows: the built-in kraki.exe updates with the app', () => {
    expect(detectInstall({ env: { KRAKI_MANAGED_BY: 'kraki-windows' }, sea: true, platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Kraki\\resources\\kraki\\kraki.exe' }).method).toBe('windows-app');
    expect(detectInstall({ env: {}, sea: true, platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\Kraki\\resources\\kraki\\kraki.exe' }).method).toBe('windows-app');
    expect(detectInstall({ env: {}, sea: true, platform: 'win32', execPath: 'C:\\Users\\a\\kraki-cli\\kraki.exe' }).method).toBe('binary');
  });

  it('Kraki for Mac helper → mac-app, with the app version', () => {
    const r = detectInstall({
      env: { KRAKI_MANAGED_BY: 'kraki-mac' }, sea: true, platform: 'darwin',
      execPath: '/Applications/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki',
      readAppVersion: (app) => (app === '/Applications/Kraki.app' ? '0.2.68' : undefined),
      readAppBuild: () => '70', readAppBundleId: () => 'chat.kraki.mac',
    });
    expect(r).toEqual({ method: 'mac-app', target: '/Applications/Kraki.app', appVersion: '0.2.68', appBuild: '70', appBundleId: 'chat.kraki.mac' });
  });
  it('a dogfood Kraki for Mac build reports <version>-dev.<N>', () => {
    const r = detectInstall({
      env: { KRAKI_MANAGED_BY: 'kraki-mac' }, sea: true, platform: 'darwin',
      execPath: '/Applications/Kraki.app/Contents/Library/Helpers/Kraki.app/Contents/MacOS/kraki',
      readAppVersion: () => '0.2.92', readAppBuild: () => '93.28', readAppBundleId: () => 'chat.kraki.mac',
    });
    expect(r).toMatchObject({ method: 'mac-app', appVersion: '0.2.92-dev.28', appBuild: '93.28' });
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

// The real feeds on 2026-11-23: production lists 0.2.92 (94); the dogfood feed
// lists the newest dogfood build first and the newest formal release.
const item = (v: string, b: string, url: string) =>
  `<item><title>Version ${v}</title><sparkle:version>${b}</sparkle:version><sparkle:shortVersionString>${v}</sparkle:shortVersionString>`
  + `<enclosure url="${url}" length="1" type="application/octet-stream" sparkle:edSignature="x"/></item>`;
const REL = 'https://github.com/corelli18512/kraki/releases/download';
const PROD = `<rss><channel>${item('0.2.92', '94', `${REL}/mac-v0.2.92/Kraki.app.zip`)}${item('0.2.91', '93', `${REL}/mac-v0.2.91/Kraki.app.zip`)}</channel></rss>`;
const DOGFOOD = `<rss><channel>${item('0.2.93', '94.35', `${REL}/dogfood-mac/Kraki-94.35.app.zip`)}${item('0.2.92', '94', `${REL}/mac-v0.2.92/Kraki.app.zip`)}</channel></rss>`;
function feeds(channel: 'stable' | 'dogfood'): CheckDeps {
  return {
    fetchLatestTentacle: async () => '0.39.0',
    fetchText: async (url) => (url === MAC_DOGFOOD_APPCAST_URL ? DOGFOOD : url === MAC_APPCAST_URL ? PROD : ''),
    isNewer,
    macChannel: () => channel,
  };
}
const dogfoodMac = { method: 'mac-app' as const, appVersion: '0.2.92-dev.28', appBuild: '93.28', appBundleId: 'chat.kraki.mac' };

describe('Kraki for Mac update channels (builds)', () => {
  it('orders builds as Sparkle does and labels dogfood builds', () => {
    expect(compareBuilds('94.35', '94')).toBeGreaterThan(0);
    expect(compareBuilds('94', '93.28')).toBeGreaterThan(0);
    expect(compareBuilds('94', '94')).toBe(0);
    expect(macVersionLabel('0.2.92', '93.28')).toBe('0.2.92-dev.28');
    expect(macVersionLabel('0.2.92', '94')).toBe('0.2.92');
    // The labels sort like the builds, also for apps that only compare versions.
    expect(isNewer('0.2.92', '0.2.92-dev.28')).toBe(true);
    expect(isNewer('0.2.93-dev.35', '0.2.92')).toBe(true);
    expect(isNewer('0.2.93-dev.36', '0.2.93-dev.35')).toBe(true);
  });
  it('Dogfood channel: a dogfood Mac is offered the newest dogfood build, from dogfood-mac', async () => {
    const r = await checkUpdateStatus(dogfoodMac, '0.39.0-dev.28', feeds('dogfood'), now);
    expect(r).toMatchObject({ installedVia: 'mac-app', current: '0.2.92-dev.28', latest: '0.2.93-dev.35' });
    expect(macAppDownload('0.2.93-dev.35')).toEqual({ tag: 'dogfood-mac', asset: 'Kraki-94.35.app.zip', build: '94.35' });
  });
  it('Stable channel on a dogfood build: offered the formal release with the same version (higher build)', async () => {
    const r = await checkUpdateStatus(dogfoodMac, '0.39.0-dev.28', feeds('stable'), now);
    expect(r?.latest).toBe('0.2.92');
    expect(macAppDownload('0.2.92')).toEqual({ tag: 'mac-v0.2.92', asset: 'Kraki.app.zip', build: '94' });
  });
  it('up to date on the channel: no latest', async () => {
    const r = await checkUpdateStatus({ ...dogfoodMac, appVersion: '0.2.93-dev.35', appBuild: '94.35' }, '0.39.1-dev.35', feeds('dogfood'), now);
    expect(r?.latest).toBeUndefined();
    const f = await checkUpdateStatus({ method: 'mac-app', appVersion: '0.2.92', appBuild: '94' }, '0.39.0', feeds('stable'), now);
    expect(f?.latest).toBeUndefined();
  });
  it('picks the highest build, not the first item', () => {
    const xml = `<rss><channel>${item('0.2.92', '94', `${REL}/mac-v0.2.92/Kraki.app.zip`)}${item('0.2.93', '94.35', `${REL}/dogfood-mac/Kraki-94.35.app.zip`)}</channel></rss>`;
    expect(newestAppcastItem(xml)?.build).toBe('94.35');
  });
  it('downloads only from this repository\'s mac-v* or dogfood-mac releases', () => {
    expect(macAppDownloadFromUrl(`${REL}/dogfood-mac/Kraki-94.35.app.zip`)).toEqual({ tag: 'dogfood-mac', asset: 'Kraki-94.35.app.zip' });
    expect(macAppDownloadFromUrl(`${REL}/v0.39.0/Kraki.app.zip`)).toBeUndefined();
    expect(macAppDownloadFromUrl('https://github.com/evil/kraki/releases/download/dogfood-mac/Kraki-1.app.zip')).toBeUndefined();
    expect(macAppDownloadFromUrl('https://example.com/Kraki.app.zip')).toBeUndefined();
    expect(macAppDownloadFromUrl(`${REL}/dogfood-mac/../x/Kraki.app.zip`)).toBeUndefined();
    expect(macAppDownload('9.9.9')).toEqual({ tag: 'mac-v9.9.9', asset: 'Kraki.app.zip' });
  });
});
