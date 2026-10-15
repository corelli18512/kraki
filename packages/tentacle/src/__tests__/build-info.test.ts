import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBuildInfo, getBuildInfo, type BuildInfo } from '../build-info.js';

vi.mock('node:fs', () => ({ readFileSync: vi.fn(() => { throw Object.assign(new Error('not generated'), { code: 'ENOENT' }); }) }));
vi.mock('../config.js', () => ({ getVersion: () => '1.2.3' }));
afterEach(() => vi.unstubAllEnvs());

describe('build identity', () => {
  it('source builds are local and ignore runtime GitHub environment variables', () => {
    vi.stubEnv('GITHUB_RUN_ID', '999');
    vi.stubEnv('KRAKI_BUILD_CHANNEL', 'release');
    const info = getBuildInfo();
    expect(info.channel).toBe('local');
    expect(info.version).toBe('1.2.3');
    expect(info.runId).toBeUndefined();
    expect(info.platform).toBe(process.platform);
    expect(info.arch).toBe(process.arch);
    expect(formatBuildInfo(info)).toContain('local (no release provenance)');
  });
  it('prints build links without claiming verification', () => {
    const info: BuildInfo = { schemaVersion: 1, component: 'cli', channel: 'release', version: '1.2.3',
      runId: '123', runAttempt: '2', commit: 'a'.repeat(40), runURL: 'https://example.invalid/run', provenanceURL: 'https://example.invalid/proof' };
    const output = formatBuildInfo({ ...info, platform: 'win32', arch: 'x64' });
    expect(output).toContain('GitHub Run ID: 123 (attempt 2)');
    expect(output).toContain('verify the downloaded artifact');
    expect(formatBuildInfo({ ...info, channel: 'ci', platform: 'darwin', arch: 'arm64' })).toContain('unavailable for non-release');
  });
});
