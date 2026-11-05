import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const installerPaths = [
  resolve(import.meta.dirname, '../../../../install.sh'),
  resolve(import.meta.dirname, '../../../arm/web/public/install.sh'),
];

for (const installerPath of installerPaths) {
  const installer = readFileSync(installerPath, 'utf8');

  describe(`daemon startup contract: ${installerPath}`, () => {
    it('delegates startup to the background-only CLI daemon manager', () => {
      expect(installer).toContain('"${INSTALL_DIR}/${BINARY_NAME}" start');
      expect(installer).not.toMatch(/\bnohup\b/);
      expect(installer).not.toMatch(/\bopen\s+-n\s+-a\b/);
      expect(installer).not.toContain('__daemon-worker');
    });
  });

  // docs/dogfood.md: testers opt into the dogfood channel or pin a release
  // tag; everyone else gets "latest", which GitHub never assigns to a prerelease.
  describe(`release selection: ${installerPath}`, () => {
    const functions = installer.replace(/\nmain\n*$/, '\n');
    const resolveVersion = (env: Record<string, string> = {}) => spawnSync('sh', ['-c', `${functions}\nfetch_latest_version\necho "VERSION=$VERSION"`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });

    it('installs a pinned release tag without asking for the latest', () => {
      const result = resolveVersion({ KRAKI_VERSION: 'v0.38.11' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('VERSION=v0.38.11');
    });

    it('installs the rolling dogfood-cli release on the dogfood channel', () => {
      const result = resolveVersion({ KRAKI_CHANNEL: 'dogfood' });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('VERSION=dogfood-cli');
    });

    it('rejects an unknown channel and a channel combined with a pinned tag', () => {
      const unknown = resolveVersion({ KRAKI_CHANNEL: 'nightly' });
      expect(unknown.status).toBe(1);
      expect(unknown.stdout).toContain('Unknown KRAKI_CHANNEL');
      const both = resolveVersion({ KRAKI_CHANNEL: 'dogfood', KRAKI_VERSION: 'v0.38.11' });
      expect(both.status).toBe(1);
      expect(both.stdout).toContain('not both');
    });

    it('rejects a tag that could escape the download URL', () => {
      const result = resolveVersion({ KRAKI_VERSION: '../../evil' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Invalid KRAKI_VERSION');
    });

    it('defaults to the latest release and always verifies checksums of the chosen release', () => {
      expect(installer).toContain('releases/latest');
      expect(installer).toContain('releases/download/${VERSION}/SHA256SUMS.txt');
      expect(installer.indexOf('verify_checksum "$TMP"')).toBeGreaterThan(installer.indexOf('install() {'));
    });
  });

  // K-276 / K-358: installer rough edges, exercised on the real functions
  // with stubbed commands.
  describe(`installer behaviour: ${installerPath}`, () => {
    const functions = installer.replace(/\nmain\n*$/, '\n');
    const run = (script: string, env: Record<string, string> = {}) => spawnSync('sh', ['-c', `${functions}\n${script}`], {
      encoding: 'utf8', env: { PATH: process.env.PATH, ...env },
    });
    const stubBin = (dir: string, name: string, body: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };

    it('points Linux arm64 to npm instead of a raw 404 (K-276)', () => {
      const bin = mkdtempSync(join(tmpdir(), 'kraki-inst-uname-'));
      stubBin(bin, 'uname', '[ "$1" = "-s" ] && echo Linux || echo aarch64');
      const result = run('detect_platform; echo "ASSET=$ASSET"', { PATH: `${bin}:${process.env.PATH}` });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('npm install -g @kraki/tentacle');
      expect(result.stdout).not.toContain('ASSET=');
    });

    it('removes the download when the final move fails (K-276)', () => {
      if (process.getuid?.() === 0) return; // chmod does not block root's move
      const root = mkdtempSync(join(tmpdir(), 'kraki-inst-tmp-'));
      const tmp = join(root, 'tmp');
      const dest = join(root, 'ro');
      mkdirSync(tmp);
      mkdirSync(dest);
      chmodSync(dest, 0o555);
      const result = run([
        'curl() { while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { echo binary > "$2"; }; shift; done; }',
        'verify_checksum() { :; }',
        'stop_running_daemon() { :; }',
        'sudo() { return 1; }',
        `mktemp() { mkdir ${tmp}/download && echo ${tmp}/download; }`,
        'PLATFORM=linux; ARCH=x64; ASSET=kraki-cli-linux-x64; VERSION=v0.0.1',
        `INSTALL_DIR=${dest}`,
        'install',
      ].join('\n'), { HOME: root });
      chmodSync(dest, 0o755);
      expect(result.status).not.toBe(0);
      expect(readdirSync(tmp)).toEqual([]);
    });

    it('does not add the PATH line again when the profile names it as $HOME/… (K-276)', () => {
      const home = mkdtempSync(join(tmpdir(), 'kraki-inst-home-'));
      const profile = join(home, '.bashrc');
      writeFileSync(profile, 'export PATH="$HOME/.local/bin:$PATH"\n');
      const result = run('INSTALL_DIR="$HOME/.local/bin"; ensure_path_configured', { HOME: home, SHELL: '/bin/bash' });
      expect(result.status).toBe(0);
      expect(readFileSync(profile, 'utf8')).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
    });

    describe('start_daemon (K-358)', () => {
      // Each `status` call prints the next line of `statuses` (the last one
      // repeats); `restartExit` is the stubbed `kraki restart` exit code.
      const startWith = (statuses: string | string[], restartExit = 0) => {
        const dir = mkdtempSync(join(tmpdir(), 'kraki-inst-start-'));
        const calls = join(dir, 'calls');
        const lines = Array.isArray(statuses) ? statuses : [statuses];
        writeFileSync(join(dir, 'statuses'), `${lines.join('\n')}\n`);
        stubBin(dir, 'kraki', [
          `echo "$1" >> ${calls}`,
          'if [ "$1" = status ]; then',
          `  n=$(grep -c '^status$' ${calls}); total=$(wc -l < ${dir}/statuses)`,
          '  [ "$n" -gt "$total" ] && n=$total',
          `  sed -n "\${n}p" ${dir}/statuses`,
          'fi',
          `[ "$1" = restart ] && exit ${restartExit}`,
          'exit 0',
        ].join('\n'));
        const result = run(`sleep() { :; }\nINSTALL_DIR=${dir}; BINARY_NAME=kraki; start_daemon`);
        expect(result.status).toBe(0);
        const all = readFileSync(calls, 'utf8').trim().split('\n');
        return { calls: all.filter((c) => c !== 'status'), statusCalls: all.filter((c) => c === 'status').length, stdout: result.stdout };
      };
      const status = (daemon: string) => `{"ok":true,"version":"0.39.0","daemon":{${daemon}}}`;

      it('restarts a daemon still running the old version', () => {
        expect(startWith(status('"running":true,"pid":458,"managedLabel":null,"daemonVersion":"0.30.0"')).calls).toEqual(['restart']);
      });

      it('restarts a running daemon whose version is unknown', () => {
        expect(startWith(status('"running":true,"pid":458,"managedLabel":null,"daemonVersion":null')).calls).toEqual(['restart']);
      });

      it('just starts when the daemon is stopped or already on the new version', () => {
        expect(startWith(status('"running":false,"pid":null,"managedLabel":null,"daemonVersion":null')).calls).toEqual(['start']);
        expect(startWith(status('"running":true,"pid":458,"managedLabel":null,"daemonVersion":"0.39.0"')).calls).toEqual(['start']);
      });

      it('waits for a just-started daemon to report its PID before deciding', () => {
        const result = startWith([
          status('"running":true,"pid":null,"managedLabel":null,"daemonVersion":null'),
          status('"running":true,"pid":null,"managedLabel":null,"daemonVersion":null'),
          status('"running":true,"pid":458,"managedLabel":null,"daemonVersion":"0.39.0"'),
        ]);
        expect(result.statusCalls).toBe(3);
        expect(result.calls).toEqual(['start']);
      });

      it('gives up waiting after about 10 s and does not fail the install when restart fails', () => {
        const result = startWith(status('"running":true,"pid":null,"managedLabel":null,"daemonVersion":null'), 1);
        expect(result.statusCalls).toBe(11);
        expect(result.calls).toEqual(['restart']);
        expect(result.stdout).toContain('Run: kraki restart');
      });

      it('leaves a daemon managed by Kraki for Mac or Windows to its app', () => {
        expect(startWith(status('"running":true,"pid":458,"managedLabel":"chat.kraki.mac","daemonVersion":"0.30.0"')).calls).toEqual(['start']);
      });
    });
  });
}
