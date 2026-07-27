/**
 * Regression tests for the macOS TCC launch mechanism.
 *
 * "TCC permissions reset on every update" was diagnosed and fixed six times
 * (#123, #133, #138, #142, and two TCC-warmup commits) and relapsed every time.
 * The reason it kept coming back is that the thing that actually causes it — HOW
 * the daemon process is launched — was never asserted anywhere.
 *
 * Measured behaviour these tests lock in (verified on macOS 26.5):
 *
 *   bundle launched by execve of Contents/MacOS/<bin>
 *     -> NSRunningApplication(processIdentifier:) == nil
 *     -> lsappinfo info -only bundleid <pid> == NULL
 *     -> no Launch Services identity, so TCC keys the grant by absolute path
 *        (client_type=1) and revalidates cdhash -> every update breaks it
 *
 *   same bundle launched via `open`
 *     -> NSRunningApplication resolves, lsappinfo reports the bundle id
 *     -> TCC keys the grant by bundle id against a cdhash-free Designated
 *        Requirement -> the grant survives updates
 *
 * Info.plist flags do NOT change this: LSBackgroundOnly and LSUIElement both
 * behave identically under each launch method.
 */

import { describe, it, expect } from 'vitest';
import { buildLaunchdPlist, INTERNAL_DAEMON_WORKER_COMMAND } from '../daemon.js';

const BASE = {
  label: 'cloud.corelli.kraki',
  execPath: '/Users/u/.local/share/kraki/Kraki.app/Contents/MacOS/kraki',
  bootstrapLogPath: '/Users/u/.kraki/logs/daemon-bootstrap.log',
  workingDirectory: '/Users/u',
  envEntries: [
    ['NODE_ENV', 'production'],
    ['LOG_LEVEL', 'info'],
  ] as [string, string][],
};
const BUNDLE = '/Users/u/.local/share/kraki/Kraki.app';

/** Extract ProgramArguments in order. */
function programArgs(plist: string): string[] {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return [];
  return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(m => m[1]);
}

describe('buildLaunchdPlist — bundled install (the TCC-critical path)', () => {
  const plist = buildLaunchdPlist({ ...BASE, appBundle: BUNDLE });
  const args = programArgs(plist);

  it('launches through LaunchServices, not by execve of the raw Mach-O', () => {
    expect(args[0]).toBe('/usr/bin/open');
    // The regression to guard against: the executable path appearing as argv[0],
    // which is what leaves the daemon without a Launch Services identity.
    expect(args[0]).not.toBe(BASE.execPath);
  });

  it('targets the .app bundle with -a so the process inherits the bundle id', () => {
    const i = args.indexOf('-a');
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe(BUNDLE);
  });

  it('passes -W so launchd still supervises the daemon lifetime', () => {
    // Without -W, `open` returns immediately and launchd loses track of the
    // daemon entirely — it would never notice a crash.
    expect(args).toContain('-W');
  });

  it('passes -n so a stale instance is never silently reactivated', () => {
    expect(args).toContain('-n');
  });

  it('still reaches the daemon-worker entry point', () => {
    const i = args.indexOf('--args');
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toBe(INTERNAL_DAEMON_WORKER_COMMAND);
    // --args must come last: `open` treats everything after it as app argv.
    expect(i + 2).toBe(args.length);
  });

  it('forwards environment by name, never embedding values in argv', () => {
    // `open --env NAME` copies NAME from open's environment. NAME=VALUE would
    // expose proxy credentials/tokens in the long-lived `open -W` argv.
    expect(args).toContain('--env');
    expect(args).toContain('NODE_ENV');
    expect(args).toContain('LOG_LEVEL');
    expect(args).not.toContain('NODE_ENV=production');
    expect(args).not.toContain('LOG_LEVEL=info');
  });

  it('does not leak environment values into the long-lived open command line', () => {
    const secret = 'github_pat_super_secret';
    const secretPlist = buildLaunchdPlist({
      ...BASE,
      appBundle: BUNDLE,
      envEntries: [['HTTPS_PROXY', 'http://user:pass@proxy'], ['GH_TOKEN', secret]],
    });
    const secretArgs = programArgs(secretPlist);
    expect(secretArgs).toContain('HTTPS_PROXY');
    expect(secretArgs).toContain('GH_TOKEN');
    expect(secretArgs.join(' ')).not.toContain('user:pass');
    expect(secretArgs.join(' ')).not.toContain(secret);
  });

  it('redirects the daemon stdio, which LaunchServices also does not inherit', () => {
    const o = args.indexOf('--stdout');
    const e = args.indexOf('--stderr');
    expect(o).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(0);
    expect(args[o + 1]).toBe(BASE.bootstrapLogPath);
    expect(args[e + 1]).toBe(BASE.bootstrapLogPath);
  });

  it('uses KeepAlive=true because `open -W` exits 0 even on SIGKILL', () => {
    // Verified: `open -W` returns status 0 when the app it waits on is killed,
    // so KeepAlive/SuccessfulExit=false would never restart a crashed daemon.
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).not.toMatch(/<key>SuccessfulExit<\/key>/);
  });

  it('throttles restarts so an unlaunchable bundle cannot spin', () => {
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });
});

describe('buildLaunchdPlist — non-bundled install (fallback)', () => {
  const plist = buildLaunchdPlist({ ...BASE, appBundle: null });
  const args = programArgs(plist);

  it('execs the binary directly when there is no bundle to launch', () => {
    expect(args).toEqual([BASE.execPath, INTERNAL_DAEMON_WORKER_COMMAND]);
  });

  it('keeps the original exit-code KeepAlive semantics', () => {
    // Here the job really is the daemon, so exit status is meaningful again.
    expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });
});

describe('buildLaunchdPlist — general', () => {
  it('is well-formed and escapes XML metacharacters in every interpolated field', () => {
    const plist = buildLaunchdPlist({
      ...BASE,
      appBundle: '/Apps/A & B.app',
      label: 'x<y>z',
      envEntries: [['V', 'a&b<c>d']],
    });
    expect(plist).toContain('/Apps/A &amp; B.app');
    expect(plist).toContain('x&lt;y&gt;z');
    expect(plist).toContain('<key>V</key>');
    expect(plist).toContain('<string>a&amp;b&lt;c&gt;d</string>');
    // No raw & survived (every & must be part of an entity).
    expect(plist).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });

  it('sets RunAtLoad so the daemon comes back after a reboot', () => {
    const plist = buildLaunchdPlist({ ...BASE, appBundle: BUNDLE });
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });
});
