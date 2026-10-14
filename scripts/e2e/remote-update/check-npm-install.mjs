// Import the installed worker without starting it: fail with the actual module
// error rather than waiting 30 s for a supervisor that keeps restarting it.
// Keep this script as argv[1], NOT daemon-worker.js (which auto-starts).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = spawnSync('npm', ['root', '-g'], {
  encoding: 'utf8', shell: process.platform === 'win32', timeout: 30_000,
});
if (root.error) throw root.error;
if (root.status !== 0) throw new Error(root.stderr);
const pkg = join(root.stdout.trim(), '@kraki', 'tentacle');
console.log(`npm package: ${pkg}`);
const tree = spawnSync('npm', ['ls', '--prefix', pkg, '--omit=dev', '--all', '--json'], {
  encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
});
if (tree.error) throw tree.error;
if (tree.status !== 0) throw new Error(`Incomplete npm runtime dependency tree:\n${tree.stderr}\n${tree.stdout}`);
console.log('npm runtime dependency tree complete');
await import(pathToFileURL(join(pkg, 'dist', 'daemon-worker.js')).href);
console.log('npm daemon-worker imports OK (worker not started)');
