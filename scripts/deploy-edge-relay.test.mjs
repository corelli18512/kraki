// scripts/deploy-edge-relay.sh against a fake relay root (KRAKI_DEPLOY_ROOT):
// fake systemctl, curl, sqlite3, npm, kraki-watch and journalctl record what
// the script does; nothing touches a real host or service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = new URL('./deploy-edge-relay.sh', import.meta.url).pathname;
const posix = { skip: process.platform === 'win32' && 'the relay deploy script runs on Linux hosts' };

function put(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, mode);
}

/** The installed tree of one release, as npm --prefix leaves it. */
function release(root, version) {
  const modules = join(root, 'opt/kraki-head/releases', version, 'node_modules');
  put(join(modules, '@kraki/head/package.json'), JSON.stringify({ name: '@kraki/head', version }));
  put(join(modules, '@kraki/head/dist/cli.js'), '');
  for (const name of ['protocol', 'crypto', 'pulse']) put(join(modules, `@kraki/${name}/package.json`), JSON.stringify({ version: '0.1.0' }));
  put(join(modules, 'better-sqlite3/index.js'), 'module.exports = class { prepare() { return { get() { return 1; } }; } };');
}

/**
 * A relay running Head 0.21.0 from the per-release layout. The fake service
 * "runs" whatever release the drop-in names at restart; FAKE_* variables make
 * a given version fail its restart, its health or its WebSocket upgrade.
 */
function fakeRelay() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-edge-relay-'));
  const bin = join(root, 'fake-bin');
  const state = join(root, 'fake-state');
  mkdirSync(state, { recursive: true });
  const log = join(state, 'log');
  writeFileSync(log, '');
  release(root, '0.21.0');
  put(join(root, 'var/lib/kraki/kraki-relay.db'), 'live database');
  const dropin = join(root, 'etc/systemd/system/kraki-relay.service.d/zzz-head-release.conf');
  const original = `[Service]\nExecStart=\nExecStart="${root}/opt/node/bin/node" "${root}/opt/kraki-head/releases/0.21.0/node_modules/@kraki/head/dist/cli.js" "--port" "4000" "--db" "${root}/var/lib/kraki/kraki-relay.db"\n`;
  put(dropin, original);
  writeFileSync(join(state, 'running'), '0.21.0');
  writeFileSync(join(state, 'user_version'), '15');
  writeFileSync(join(state, 'integrity'), 'ok');

  const sh = (name, body, dir = bin) => put(join(dir, name), `#!/usr/bin/env bash\nset -u\nS=${JSON.stringify(state)}\n${body}\n`, 0o755);
  sh('node', `exec ${JSON.stringify(process.execPath)} "$@"`, join(root, 'opt/node/bin'));
  // npm --prefix DIR install ... @kraki/head@V
  sh('npm', `echo "npm $*" >> "$S/log"
[ -z "\${FAKE_NPM_FAIL:-}" ] || exit 1
prefix=""; spec=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix=$2; shift ;; @kraki/head@*) spec=$1 ;; esac; shift; done
v=\${FAKE_NPM_VERSION:-\${spec#@kraki/head@}}
m="$prefix/node_modules"; mkdir -p "$m/@kraki/head/dist" "$m/better-sqlite3"
for p in protocol crypto pulse; do mkdir -p "$m/@kraki/$p"; echo '{"version":"0.1.0"}' > "$m/@kraki/$p/package.json"; done
echo "{\\"name\\":\\"@kraki/head\\",\\"version\\":\\"$v\\"}" > "$m/@kraki/head/package.json"; : > "$m/@kraki/head/dist/cli.js"
echo 'module.exports = class { prepare() { return { get() { return 1; } }; } };' > "$m/better-sqlite3/index.js"`, join(root, 'opt/node/bin'));
  // Reads stdin, as any child could: over `bash -s` that would be the script.
  sh('kraki-watch', 'echo "kraki-watch $*" >> "$S/log"; cat >> "$S/kraki-watch-stdin"', join(root, 'usr/local/bin'));
  sh('systemctl', `echo "systemctl $*" >> "$S/log"
case "$1" in
  restart)
    v=$(sed -nE 's#.*/releases/([^/]+)/node_modules/@kraki/head/dist/cli.js.*#\\1#p' ${JSON.stringify(dropin)} | tail -1)
    echo "$v" > "$S/running"
    [ "$v" = "\${FAKE_SCHEMA_BUMP:-}" ] && echo 16 > "$S/user_version"
    [ "$v" != "\${FAKE_RESTART_FAILS:-}" ] ;;
  is-active) [ "$(cat "$S/running")" != "\${FAKE_RESTART_FAILS:-}" ] ;;
  *) exit 0 ;;
esac`);
  sh('curl', `url=""; ws=0
for a in "$@"; do case "$a" in http://*|https://*) url=$a ;; 'Upgrade: websocket') ws=1 ;; esac; done
echo "curl $url$([ $ws = 1 ] && echo ' (websocket)')" >> "$S/log"
v=$(cat "$S/running")
if [ $ws = 1 ]; then
  if [ "$v" = "\${FAKE_NO_WEBSOCKET:-}" ]; then printf 'HTTP/1.1 400 Bad Request\\r\\n\\r\\n'; exit 0; fi
  printf 'HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\n\\r\\n'; exit 28
fi
[ "$v" != "\${FAKE_UNHEALTHY:-}" ] || exit 22
printf '{"name":"@kraki/head","version":"%s","status":"ok"}' "$v"`);
  sh('sqlite3', `echo "sqlite3 $*" >> "$S/log"
case "$2" in
  .backup*) dest=\${2#.backup \\'}; cp "$1" "\${dest%\\'}" ;;
  'PRAGMA integrity_check;') cat "$S/integrity" ;;
  'PRAGMA user_version;') cat "$S/user_version" ;;
esac`);
  sh('journalctl', 'echo "(journal)"');
  sh('sleep', 'exit 0');

  const run = (args, env = {}) => {
    const r = spawnSync('bash', [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KRAKI_DEPLOY_ROOT: root, KRAKI_PUBLIC_URL: '', ...env },
    });
    return { ...r, log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  };
  const backups = () => (existsSync(join(root, 'opt/kraki-head/backups')) ? readdirSync(join(root, 'opt/kraki-head/backups')).sort() : []);
  return { root, dropin, original, run, backups, running: () => readFileSync(join(state, 'running'), 'utf8').trim(), state };
}

const at = (log, prefix) => log.findIndex(line => line.startsWith(prefix));

test('deploys a new release next to the old one and switches the drop-in', posix, () => {
  const relay = fakeRelay();
  const r = relay.run(['0.22.0']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deploy OK: 0\.22\.0 .*Roll back with: deploy-edge-relay\.sh rollback 0\.21\.0/);
  assert.equal(readFileSync(relay.dropin, 'utf8'), relay.original.replaceAll('/releases/0.21.0/', '/releases/0.22.0/'));
  assert.equal(relay.running(), '0.22.0');
  // Backups: a checked database snapshot and the drop-in of the release it replaced.
  const [snapshot, saved] = relay.backups();
  assert.match(snapshot, /^head-pre-0\.22\.0-\d{8}-\d{6}\.db$/);
  assert.equal(readFileSync(join(relay.root, 'opt/kraki-head/backups', snapshot), 'utf8'), 'live database');
  assert.equal(saved, 'zzz-head-release.conf.0.21.0');
  assert.equal(readFileSync(join(relay.root, 'opt/kraki-head/backups', saved), 'utf8'), relay.original);
  assert.ok(r.log.some(line => line.startsWith('sqlite3 ') && line.endsWith(`${snapshot} PRAGMA integrity_check;`)));
  // The release is its own npm --prefix install, from the upstream registry.
  const npm = r.log.find(line => line.startsWith('npm '));
  assert.ok(npm.includes(`--prefix ${relay.root}/opt/kraki-head/releases/0.22.0.tmp install`), npm);
  assert.ok(npm.includes('--omit=dev --registry https://registry.npmjs.org @kraki/head@0.22.0'), npm);
  assert.equal(JSON.parse(readFileSync(join(relay.root, 'opt/kraki-head/releases/0.22.0/node_modules/@kraki/head/package.json'))).version, '0.22.0');
  assert.ok(existsSync(join(relay.root, 'opt/kraki-head/releases/0.21.0/node_modules/@kraki/head/dist/cli.js')), 'the old release stays');
  // kraki-watch hears about the restart first; systemd reloads the drop-in before the restart.
  assert.ok(at(r.log, 'kraki-watch maintenance 10') < at(r.log, 'systemctl daemon-reload'));
  assert.ok(at(r.log, 'systemctl daemon-reload') < at(r.log, 'systemctl restart kraki-relay'));
  // Verified: active, version on / and /healthz, WebSocket upgrade.
  const after = r.log.slice(at(r.log, 'systemctl restart'));
  for (const check of ['systemctl is-active --quiet kraki-relay', 'curl http://127.0.0.1:4000/', 'curl http://127.0.0.1:4000/healthz',
    'curl http://127.0.0.1:4000/ (websocket)']) assert.ok(after.includes(check), check);
});

test('runs piped into bash -s, as over ssh, without a child eating the script', posix, () => {
  const relay = fakeRelay();
  const r = spawnSync('bash', ['-s', '0.22.0'], {
    input: readFileSync(script),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${relay.root}/fake-bin:${process.env.PATH}`, KRAKI_DEPLOY_ROOT: relay.root, KRAKI_PUBLIC_URL: '' },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deploy OK: 0\.22\.0/);
  assert.equal(readFileSync(join(relay.state, 'kraki-watch-stdin'), 'utf8'), '');
});

test('also checks /healthz and the WebSocket upgrade through the public URL when given', posix, () => {
  const relay = fakeRelay();
  const r = relay.run(['0.22.0'], { KRAKI_PUBLIC_URL: 'https://cn.relay.example/' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.log.includes('curl https://cn.relay.example/healthz'));
  assert.ok(r.log.includes('curl https://cn.relay.example/ (websocket)'));
});

for (const [name, env] of [
  ['the restart fails', { FAKE_RESTART_FAILS: '0.22.0' }],
  ['the new version does not answer health checks', { FAKE_UNHEALTHY: '0.22.0' }],
  ['the new version refuses WebSocket upgrades', { FAKE_NO_WEBSOCKET: '0.22.0' }],
]) {
  test(`rolls back to the previous drop-in when ${name}`, posix, () => {
    const relay = fakeRelay();
    const r = relay.run(['0.22.0'], env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /==> ROLLBACK to 0\.21\.0/);
    assert.match(r.stdout, /rolled back to 0\.21\.0/);
    assert.equal(readFileSync(relay.dropin, 'utf8'), relay.original);
    assert.equal(relay.running(), '0.21.0');
    assert.equal(r.log.filter(line => line === 'systemctl restart kraki-relay').length, 2);
    assert.equal(r.log.filter(line => line === 'systemctl daemon-reload').length, 2);
  });
}

test('a rollback after a schema change keeps the live database and names the snapshot', posix, () => {
  const relay = fakeRelay();
  const r = relay.run(['0.22.0'], { FAKE_UNHEALTHY: '0.22.0', FAKE_SCHEMA_BUMP: '0.22.0' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /0\.22\.0 moved the database schema \(15 -> 16\)/);
  assert.match(r.stderr, /pre-deploy snapshot is .*head-pre-0\.22\.0-/);
  assert.equal(readFileSync(join(relay.root, 'var/lib/kraki/kraki-relay.db'), 'utf8'), 'live database');
});

for (const [name, args, env, message] of [
  ['the snapshot fails its integrity check', ['0.22.0'], { _: 'integrity' }, /integrity check of .* failed/],
  ['npm installs another version', ['0.22.0'], { FAKE_NPM_VERSION: '0.21.9' }, /has @kraki\/head 0\.21\.9, not 0\.22\.0/],
  ['npm fails', ['0.22.0'], { FAKE_NPM_FAIL: '1' }, /^/],
  ['it already runs that version', ['0.21.0'], {}, /already runs 0\.21\.0/],
  ['the version is not one', ['latest'], {}, /not a version: latest/],
]) {
  test(`changes nothing on the service when ${name}`, posix, () => {
    const relay = fakeRelay();
    if (env._ === 'integrity') writeFileSync(join(relay.state, 'integrity'), '*** in database main ***');
    const r = relay.run(args, env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, message);
    assert.equal(readFileSync(relay.dropin, 'utf8'), relay.original);
    assert.ok(!r.log.some(line => line.startsWith('systemctl') || line.startsWith('kraki-watch')), r.log.join('\n'));
  });
}

test('refuses a host without the per-release drop-in', posix, () => {
  const relay = fakeRelay();
  put(relay.dropin, '[Service]\nExecStart=\nExecStart=/usr/local/bin/kraki-relay --port 4000\n');
  const r = relay.run(['0.22.0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no ExecStart="\.\.\." in|does not run Head from/);
  assert.deepEqual(r.log, []);
});

test('rollback switches back to a saved release and keeps the one it leaves', posix, () => {
  const relay = fakeRelay();
  assert.equal(relay.run(['0.22.0']).status, 0);
  const deployed = readFileSync(relay.dropin, 'utf8');
  const r = relay.run(['rollback', '0.21.0']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /rollback OK: 0\.21\.0/);
  assert.equal(readFileSync(relay.dropin, 'utf8'), relay.original);
  assert.equal(relay.running(), '0.21.0');
  assert.equal(readFileSync(join(relay.root, 'opt/kraki-head/backups/zzz-head-release.conf.0.22.0'), 'utf8'), deployed);
  assert.ok(at(r.log, 'kraki-watch maintenance 10') < at(r.log, 'systemctl restart kraki-relay'));
  assert.ok(r.log.includes('curl http://127.0.0.1:4000/healthz'));
  // And forward again.
  assert.equal(relay.run(['rollback', '0.22.0']).status, 0);
  assert.equal(readFileSync(relay.dropin, 'utf8'), deployed);
});

test('rollback to a release without a saved drop-in lists the saved ones', posix, () => {
  const relay = fakeRelay();
  assert.equal(relay.run(['0.22.0']).status, 0);
  const r = relay.run(['rollback', '0.20.0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no saved drop-in for 0\.20\.0\. Saved:\n {2}0\.21\.0/);
});

test('without the test root it refuses to run unless root', posix, () => {
  if (process.getuid?.() === 0) return;
  const r = spawnSync('bash', [script, '0.22.0'], { encoding: 'utf8', env: { ...process.env, KRAKI_DEPLOY_ROOT: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run as root on the relay host/);
});

test('usage', posix, () => {
  const relay = fakeRelay();
  for (const args of [[], ['rollback'], ['0.22.0', 'extra']]) {
    const r = relay.run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: deploy-edge-relay\.sh <version> \| deploy-edge-relay\.sh rollback <version>/);
  }
});
