// Build the Kraki CLI (tentacle) as a Windows SEA and stage it in kraki/,
// which electron-builder ships as resources\kraki\kraki.exe — the Kraki built
// into the app (see src/tentacle.cjs). Run from packages/desktop.
//   KRAKI_EXE=path\to\kraki.exe  use an already built binary instead.
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const out = resolve(here, '../kraki');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
let exe = process.env.KRAKI_EXE;
if (!exe) {
  execSync('pnpm --filter @kraki/tentacle run build:binary:local', { cwd: root, stdio: 'inherit' });
  if (process.platform === 'win32') {
    exe = resolve(root, 'packages/tentacle/dist/sea/kraki-cli-windows-x64.exe');
  } else {
    execSync('node scripts/build-sea-windows-cross.mjs', { cwd: resolve(root, 'packages/tentacle'), stdio: 'inherit' });
    exe = resolve(root, 'packages/tentacle/dist/sea/kraki-cli-windows-x64.exe');
  }
}
copyFileSync(exe, resolve(out, 'kraki.exe'));
console.log('built-in Kraki staged at', resolve(out, 'kraki.exe'));
