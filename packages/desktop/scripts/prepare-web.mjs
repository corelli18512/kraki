// Build the Web client and copy it into app/ (served by the shell as
// app://kraki). Run from packages/desktop: `node scripts/prepare-web.mjs`.
import { execSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
execSync('pnpm --filter @kraki/arm-web build', { cwd: root, stdio: 'inherit' });
const out = resolve(here, '../app');
rmSync(out, { recursive: true, force: true });
cpSync(resolve(root, 'packages/arm/web/dist'), out, { recursive: true });
console.log('web app copied to', out);
