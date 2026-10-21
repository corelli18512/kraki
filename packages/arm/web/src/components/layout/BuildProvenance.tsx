import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('settings');
  const links = buildLinks(info);
  const rows = links ? [
    [t('build.runId'), `${info?.runId}${info?.runAttempt === '1' ? '' : t('build.attempt', { attempt: info?.runAttempt })}`, links.run],
    [t('build.commit'), info?.commit?.slice(0, 8), links.source],
    ...(links.provenance ? [[t('build.provenance'), t('build.view'), links.provenance]] : []),
  ] : [];
  return (
    <div className="kp-build-source" aria-label={t('build.source')}>
      {rows.length ? rows.map(([label, value, href]) => (
        <a key={label} href={href} target="_blank" rel="noreferrer">
          <span>{label}</span><span>{value}<span aria-hidden="true"> ↗</span></span>
        </a>
      )) : <div><span>{t('build.label')}</span><span>{info?.channel === 'local' ? t('build.local') : t('build.unavailable')}</span></div>}
    </div>
  );
}
