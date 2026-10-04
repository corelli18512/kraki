// wait-result.mjs <seconds> [--expect-rollback] — until remote-update/result.json is final.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const secs = Number(process.argv[2]);
const expectRollback = process.argv.includes('--expect-rollback');
const home = process.env.KRAKI_HOME || join(homedir(), '.kraki');
const path = join(home, 'remote-update', 'result.json');
const deadline = Date.now() + secs * 1000;
let last = '';
while (Date.now() < deadline) {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    if (raw !== last) { console.log(new Date().toISOString(), raw.trim()); last = raw; }
    const r = JSON.parse(raw);
    if (r.ok === true) { if (expectRollback) { console.log('❌ expected a rollback'); process.exit(1); } console.log('✅ updated'); process.exit(0); }
    if (r.ok === false) {
      if (expectRollback && r.rolledBack) { console.log('✅ rolled back'); process.exit(0); }
      console.log('❌ failed'); process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log('❌ no result in time');
process.exit(1);
