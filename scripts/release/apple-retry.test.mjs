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
test('retries a transient Apple network error, then succeeds', () => {
  const f = fake([[68, 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'], [0, 'The validate action worked!']]);
  const r = f.run();
  assert.equal(r.status, 0);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '2');
});
test('does not retry a real failure', () => {
  const f = fake([[65, 'CloudKit query for Kraki.app failed due to "Record not found".'], [0, 'ok']]);
  const r = f.run();
  assert.equal(r.status, 65);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '1');
});
test('gives up after the attempt limit', () => {
  const lost = [68, 'NSURLErrorDomain Code=-1005 network connection was lost'];
  const f = fake([lost, lost, lost, lost, lost, [0, 'ok']]);
  const r = f.run();
  assert.equal(r.status, 68);
  assert.equal(readFileSync(join(f.dir, 'n'), 'utf8'), '5');
});
