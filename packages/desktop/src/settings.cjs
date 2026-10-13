// OS preference helpers; selected external CLI is never used to take ownership.
const { execFile } = require('node:child_process');
const { existsSync, statSync } = require('node:fs');
const path = require('node:path');

function exec(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 5000, maxBuffer: 65536 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout).trim())));
}
function isKrakiExecutable(file) {
  try { return /^kraki(?:\.exe)?$/i.test(path.basename(file)) && existsSync(file) && statSync(file).isFile(); } catch { return false; }
}
async function probeCli(selected) {
  const file = selected || (await exec(process.platform === 'win32' ? 'where.exe' : 'which', ['kraki'])).split(/\r?\n/)[0];
  if (!isKrakiExecutable(file)) throw new Error('Select an existing kraki executable.');
  const output = await exec(file, ['--version']);
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(output)?.[0];
  if (!version) throw new Error('The selected CLI did not report a Kraki version.');
  return { externalCliPath: file, externalCliVersion: version };
}
module.exports = { exec, isKrakiExecutable, probeCli };
