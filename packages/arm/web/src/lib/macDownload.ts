/**
 * Link to the newest Kraki for Mac disk image.
 *
 * GitHub's "latest release" is reserved for CLI tags (v*) — install scripts
 * resolve the CLI through it — so the Mac app (mac-v* tags) has no stable
 * `releases/latest/download/Kraki.dmg` URL. Resolve it from the release list;
 * fall back to the filtered releases page.
 */
export const MAC_RELEASES_PAGE = 'https://github.com/corelli18512/kraki/releases?q=mac-v&expanded=true';

interface ReleaseAsset { name: string; browser_download_url: string }
interface Release { tag_name: string; draft: boolean; prerelease: boolean; assets: ReleaseAsset[] }

export function pickMacDmg(releases: Release[]): string | null {
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith('mac-v')) continue;
    const dmg = r.assets.find((a) => a.name === 'Kraki.dmg');
    if (dmg) return dmg.browser_download_url;
  }
  return null;
}

export async function resolveMacDmgUrl(fetcher: typeof fetch = fetch, timeoutMs = 3000): Promise<string> {
  // Where api.github.com is blackholed (China, K-324) a click must not hang
  // until the browser gives up. AbortController, not AbortSignal.timeout:
  // Safari added that only in 16.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A full page: Windows, iOS build records and the dogfood releases
    // (docs/dogfood.md) can sit above the newest mac-v release.
    const res = await fetcher('https://api.github.com/repos/corelli18512/kraki/releases?per_page=100', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) return MAC_RELEASES_PAGE;
    return pickMacDmg(await res.json() as Release[]) ?? MAC_RELEASES_PAGE;
  } catch {
    return MAC_RELEASES_PAGE;
  } finally {
    clearTimeout(timer);
  }
}

/** A Mac browser (not iPhone/iPad, which also report "Macintosh" when desktop-mode). */
export function isMacBrowser(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) < 2;
}
