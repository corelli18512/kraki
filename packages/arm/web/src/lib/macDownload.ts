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

export async function resolveMacDmgUrl(fetcher: typeof fetch = fetch): Promise<string> {
  try {
    const res = await fetcher('https://api.github.com/repos/corelli18512/kraki/releases?per_page=30', {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return MAC_RELEASES_PAGE;
    return pickMacDmg(await res.json() as Release[]) ?? MAC_RELEASES_PAGE;
  } catch {
    return MAC_RELEASES_PAGE;
  }
}

/** A Mac browser (not iPhone/iPad, which also report "Macintosh" when desktop-mode). */
export function isMacBrowser(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /Macintosh/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) < 2;
}
