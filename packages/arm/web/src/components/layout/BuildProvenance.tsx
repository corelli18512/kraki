import type { DesktopBuildInfo } from '../../lib/desktop';

export function buildLinks(info?: DesktopBuildInfo) {
  if (info?.schemaVersion !== 1 || !['ci', 'release'].includes(info.channel)
    || info.repository !== 'corelli18512/kraki'
    || !/^[a-f0-9]{40}$/.test(info.commit ?? '')
    || !/^[1-9][0-9]*$/.test(info.runId ?? '') || !/^[1-9][0-9]*$/.test(info.runAttempt ?? '')
    || info.workflow !== '.github/workflows/windows-release.yml') return null;
  const root = 'https://github.com/corelli18512/kraki';
  const run = `${root}/actions/runs/${info.runId}/attempts/${info.runAttempt}`;
  return { run, source: `${root}/commit/${info.commit}`, provenance: info.channel === 'release' ? `${run}#summary` : null };
}

export function BuildProvenance({ info }: { info?: DesktopBuildInfo }) {
  const links = buildLinks(info);
  const rows = links ? [
    ['GitHub Run ID', `${info?.runId}${info?.runAttempt === '1' ? '' : ` · attempt ${info?.runAttempt}`}`, links.run],
    ['Source commit', info?.commit?.slice(0, 8), links.source],
    ...(links.provenance ? [['Build provenance', 'View on GitHub', links.provenance]] : []),
  ] : [];
  return (
    <div className="kp-build-source" aria-label="Build source">
      {rows.length ? rows.map(([label, value, href]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer">
          <span>{label}</span><span>{value}<span aria-hidden="true"> ↗</span></span>
        </a>
      )) : <div><span>Build</span><span>{info?.channel === 'local' ? 'Local build' : 'Build record unavailable'}</span></div>}
    </div>
  );
}
