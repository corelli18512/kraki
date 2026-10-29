import { describe, it, expect } from 'vitest';
import { pickMacDmg, resolveMacDmgUrl, isMacBrowser, MAC_RELEASES_PAGE } from './macDownload';

const rel = (tag: string, assets: string[], extra: Partial<{ draft: boolean; prerelease: boolean }> = {}) => ({
  tag_name: tag, draft: false, prerelease: false, ...extra,
  assets: assets.map((name) => ({ name, browser_download_url: `https://x/${tag}/${name}` })),
});

describe('Kraki for Mac download link', () => {
  it('picks the newest published mac-v release that has Kraki.dmg', () => {
    expect(pickMacDmg([
      rel('v0.34.0', ['kraki-macos-arm64.app.tar.gz']),
      rel('mac-v0.2.50', ['Kraki.dmg'], { draft: true }),
      rel('mac-v0.2.49', ['Kraki.dmg', 'Kraki.app.zip']),
      rel('mac-v0.2.48', ['Kraki.app.zip']),
    ])).toBe('https://x/mac-v0.2.49/Kraki.dmg');
  });

  it('never links the dogfood release, even when the formal release is further down the list', async () => {
    const releases = [rel('dogfood-mac', ['Kraki.dmg', 'Kraki.app.zip', 'appcast-dogfood.xml'], { prerelease: true }),
      rel('dogfood-cli', ['kraki-macos-arm64.app.tar.gz'], { prerelease: true })];
    for (let n = 30; n > 0; n--) releases.push(rel(`win-v0.1.${n}`, ['Kraki-Setup-0.1.0-x64.exe']));
    releases.push(rel('v0.38.11', ['kraki-macos-arm64.app.tar.gz']), rel('mac-v0.2.91', ['Kraki.dmg']));
    expect(pickMacDmg(releases)).toBe('https://x/mac-v0.2.91/Kraki.dmg');
    let requested = '';
    const fetcher = (async (url: string) => {
      requested = url;
      return { ok: true, json: async () => releases };
    }) as unknown as typeof fetch;
    await expect(resolveMacDmgUrl(fetcher)).resolves.toBe('https://x/mac-v0.2.91/Kraki.dmg');
    expect(requested).toContain('per_page=100');
  });

  it('falls back to the releases page when no DMG is published or GitHub is unreachable', async () => {
    expect(pickMacDmg([rel('mac-v0.2.48', ['Kraki.app.zip'])])).toBeNull();
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(resolveMacDmgUrl(failing)).resolves.toBe(MAC_RELEASES_PAGE);
  });

  it('only offers it on a Mac, not an iPad in desktop mode', () => {
    expect(isMacBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(true);
    expect(isMacBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 })).toBe(false);
    expect(isMacBrowser({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)', maxTouchPoints: 0 })).toBe(false);
  });
});
