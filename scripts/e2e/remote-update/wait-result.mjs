// wait-result.mjs <seconds> <expected phase> — until remote-update/result.json is final.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [secs, expected] = process.argv.slice(2);
const path = join(process.env.KRAKI_HOME || join(homedir(), '.kraki'), 'remote-update', 'result.json');
const deadline = Date.now() + Number(secs) * 1000;
let last = '';
while (Date.now() < deadline) {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw !== last) { console.log(new Date().toISOString(), raw.trim()); last = raw; }
    const r = JSON.parse(raw);
    if (r.phase) {
      if (r.phase === expected) { console.log(`✅ ${expected}`); process.exit(0); }
      console.log(`❌ expected ${expected}, got ${r.phase}`); process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('❌ no result in time'); process.exit(1);
