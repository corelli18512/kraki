// request-update.mjs <source> <expectVersion> [deadlineSeconds] — POC trigger.
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [source, expectVersion, deadline] = process.argv.slice(2);
const home = process.env.KRAKI_HOME || join(homedir(), '.kraki');
mkdirSync(home, { recursive: true });
const req = { source, expectVersion, ...(deadline ? { deadlineSeconds: Number(deadline) } : {}) };
writeFileSync(join(home, 'remote-update-request.json'), JSON.stringify(req));
console.log('requested', req, new Date().toISOString());
