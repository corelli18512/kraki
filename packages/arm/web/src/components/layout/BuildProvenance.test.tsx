import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BuildProvenance, buildLinks } from './BuildProvenance';
import type { DesktopBuildInfo } from '../../lib/desktop';

const info: DesktopBuildInfo = {
  schemaVersion: 1, channel: 'release', repository: 'corelli18512/kraki', commit: 'a'.repeat(40),
  workflow: '.github/workflows/windows-release.yml', runId: '12345678901', runAttempt: '2',
};

describe('desktop build provenance', () => {
  it('shows this build and rerun links without claiming verification', () => {
    render(<BuildProvenance info={info} />);
    expect(screen.getByRole('link', { name: /GitHub Run ID/ })).toHaveAttribute('href', 'https://github.com/corelli18512/kraki/actions/runs/12345678901/attempts/2');
    expect(screen.getByRole('link', { name: /Source commit/ })).toHaveAttribute('href', `https://github.com/corelli18512/kraki/commit/${info.commit}`);
    expect(screen.getByRole('link', { name: /Build provenance/ })).toHaveTextContent('View on GitHub');
  });
  it('local builds have no misleading proof link', () => {
    render(<BuildProvenance info={{ schemaVersion: 1, channel: 'local' }} />);
    expect(screen.getByText('Local build')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
  it('CI dry runs do not claim a release attestation', () => expect(buildLinks({ ...info, channel: 'ci' })?.provenance).toBeNull());
  it('rejects unrecognized identities and injected URLs', () => {
    for (const change of [{ repository: 'evil/kraki' }, { commit: 'main' }, { runId: '../1' },
      { runAttempt: '0' }, { workflow: '.github/workflows/ci.yml' }, { schemaVersion: 2 }]) {
      expect(buildLinks({ ...info, ...change })).toBeNull();
    }
  });
});
