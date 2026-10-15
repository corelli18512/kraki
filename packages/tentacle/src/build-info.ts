import { readFileSync } from 'node:fs';
import { getVersion } from './config.js';

export interface BuildInfo {
  schemaVersion: number;
  component: string;
  version: string;
  channel: 'local' | 'ci' | 'release';
  repository?: string;
  commit?: string;
  ref?: string;
  workflow?: string;
  runId?: string;
  runAttempt?: string;
  runURL?: string;
  sourceURL?: string;
  provenanceURL?: string;
}

declare const __KRAKI_BUILD_INFO__: BuildInfo | undefined;

export function getBuildInfo(): BuildInfo & { platform: string; arch: string } {
  let info: BuildInfo = { schemaVersion: 1, component: 'cli', version: getVersion(), channel: 'local' };
  if (typeof __KRAKI_BUILD_INFO__ !== 'undefined') {
    info = __KRAKI_BUILD_INFO__;
  } else {
    try {
      // Generated next to compiled JS for npm. No runtime env overrides: this
      // describes the installed package, not whichever shell launched it.
      info = JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  // Universal macOS helpers share a SEA blob, so report the executing slice.
  return { ...info, platform: process.platform, arch: process.arch };
}

export function formatBuildInfo(info: ReturnType<typeof getBuildInfo>): string {
  const lines = [`Kraki ${info.version} (${info.platform}/${info.arch})`];
  if (info.channel === 'local') return [...lines, 'Build: local (no release provenance)'].join('\n');
  return [...lines,
    `Build: ${info.channel}`,
    `GitHub Run ID: ${info.runId} (attempt ${info.runAttempt})`,
    `Source commit: ${info.commit}`,
    `Build record: ${info.runURL}`,
    info.channel === 'release' ? `Build provenance: ${info.provenanceURL}` : 'Build provenance: unavailable for non-release builds',
    'Links identify the build; verify the downloaded artifact to validate its provenance.',
  ].join('\n');
}
