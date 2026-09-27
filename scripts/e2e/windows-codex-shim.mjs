// Real Windows spawn smoke. Uses a tiny local JSON-RPC fixture, never Codex/login.
// Usage after building tentacle: node scripts/e2e/windows-codex-shim.mjs [tentacle-package-dir]
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') {
  console.log('SKIP: Windows-only command shim smoke');
  process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'kraki-codex-shim-'));
process.env.KRAKI_HOME = join(root, 'state');
const packageDir = process.argv[2] ?? fileURLToPath(new URL('../../packages/tentacle/', import.meta.url));
const { CodexRpcProcess } = await import(pathToFileURL(resolve(packageDir, 'dist/adapters/codex-rpc.js')).href);
const fixture = join(root, 'fake-server.cjs');
writeFileSync(fixture, `const rl = require('node:readline').createInterface({input:process.stdin});
rl.on('line', line => { const msg=JSON.parse(line); if(msg.id!==undefined) process.stdout.write(JSON.stringify({id:msg.id,result:{ok:true}})+'\\n'); });
`);
const bin = join(root, 'Codex bin with spaces');
mkdirSync(bin);
try {
  for (const ext of ['cmd', 'bat']) {
    const shim = join(bin, `codex.${ext}`);
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`);
    const rpc = new CodexRpcProcess({ command: shim, requestTimeoutMs: 5000 });
    try {
      rpc.start();
      assert.deepEqual(await rpc.request('initialize', {}), { ok: true });
      console.log(`PASS: .${ext} shim in a path containing spaces`);
    } finally {
      await rpc.stop();
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
