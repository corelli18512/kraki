// wait-online.mjs <kraki> <version> <seconds> — until `kraki status --json` says connected at <version>.
import { spawnSync } from 'node:child_process';
const [kraki, version, secs] = process.argv.slice(2);
const deadline = Date.now() + Number(secs) * 1000;
let last = '';
while (Date.now() < deadline) {
  const r = spawnSync(kraki, ['status', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20000 });
  let d = {};
  try { d = JSON.parse(r.stdout).daemon ?? {}; } catch {}
  const line = `running=${d.running} relay=${d.relayState} version=${d.daemonVersion}`;
  if (line !== last) { console.log(new Date().toISOString(), line); last = line; }
  if (d.running && d.relayState === 'connected' && d.daemonVersion === version) { console.log(`✅ online at ${version}`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log(`❌ not online at ${version} within ${secs}s`);
process.exit(1);
