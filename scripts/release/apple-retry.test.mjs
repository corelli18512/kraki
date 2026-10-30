import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('./apple-retry.sh', import.meta.url).pathname;
function fake(lines) {
  // A fake command that prints the next scripted outcome on each call.
  const dir = mkdtempSync(join(tmpdir(), 'apple-retry-'));
  writeFileSync(join(dir, 'n'), '0');
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(lines));
  const cmd = join(dir, 'cmd.mjs');
  writeFileSync(cmd, `import { readFileSync, writeFileSync } from 'node:fs';
const d = ${JSON.stringify(dir)}; const n = Number(readFileSync(d + '/n', 'utf8'));
writeFileSync(d + '/n', String(n + 1)); const [code, msg] = JSON.parse(readFileSync(d + '/plan.json', 'utf8'))[n];
console.log(msg); process.exit(code);`);
  return { dir, run: () => spawnSync('bash', [script, process.execPath, cmd], { encoding: 'utf8', env: { ...process.env, APPLE_RETRY_DELAY: '0' } }) };
}
const posix = { skip: process.platform === 'win32' && 'apple-retry.sh runs on the macOS release runners only' };
test('retries a transient Apple network error, then succeeds', posix, () => {
  const f = fake([[68, 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'], [0, 'The validate action worked!']]);
  const r = f.run();
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '2');
});
test('does not retry a real failure', posix, () => {
  const f = fake([[65, 'CloudKit query for Kraki.app failed due to "Record not found".'], [0, 'ok']]);
  const r = f.run();
  assert.equal(r.status, 65);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '1');
});
test('gives up after the attempt limit', posix, () => {
  const lost = [68, 'NSURLErrorDomain Code=-1005 network connection was lost'];
  const f = fake([lost, lost, lost, lost, lost, [0, 'ok']]);
  const r = f.run();
  assert.equal(r.status, 68);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '5');
});
test('release.yml staples the macOS x64 CLI bundle on arm64 before anything publishes it', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n'); // Windows checkouts are CRLF
  const job = (name) => workflow.split(new RegExp(`\\n  ${name}:\\n`))[1].split(/\n  [a-z-]+:\n/)[0];
  const staple = job('staple-macos-x64');
  assert.match(staple, /runs-on: macos-14\n/);
  assert.match(staple, /apple-retry\.sh xcrun stapler staple "\$APP"/);
  assert.match(staple, /apple-retry\.sh xcrun stapler validate "\$APP"/);
  assert.match(staple, /spctl -a -vvv --type exec "\$APP"/);
  // Stapling is mandatory for every publishing mode.
  assert.match(staple, /if: needs\.prepare\.outputs\.publish_mode == 'publish' \|\| needs\.prepare\.outputs\.publish_mode == 'prerelease' \|\|/);
  assert.match(staple, /name: build-kraki-cli-macos-x64-app-\$\{\{ github\.run_attempt \}\}/);
  // The Intel leg's unstapled bundle is never a release asset (publish downloads build-kraki-*).
  assert.match(job('build-binary'), /name: unstapled-kraki-macos-x64-app-/);
  for (const name of ['publish', 'publish-npm']) {
    assert.match(job(name), /- staple-macos-x64\n/, name);
    assert.match(job(name), /needs\.build-binary\.result == 'success' && needs\.staple-macos-x64\.result == 'success'/, name);
  }
});
