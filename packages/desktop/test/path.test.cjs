const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { mergePath, parseRegistryPath } = require('../src/tentacle.cjs');

test('PATH from the registry is merged without repeats', () => {
  assert.equal(mergePath('C:\\a;C:\\b\\', 'c:\\B;;C:\\c', ''), 'C:\\a;C:\\b\\;C:\\c');
  const out = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\tools\r\n';
  process.env.USERPROFILE ??= 'C:\\Users\\x';
  assert.equal(parseRegistryPath(out), `${process.env.USERPROFILE}\\bin;C:\\tools`);
  assert.equal(parseRegistryPath(''), '');
});

// `reg query` ran synchronously for every child process (every status poll),
// blocking the main process and with it the window: clicks were missed.
test('the main process never waits on child processes synchronously', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/tentacle.cjs'), 'utf8');
  assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync)\b/);
});
