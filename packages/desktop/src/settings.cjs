// OS preference helpers; selected external CLI is never used to take ownership.
const i18n = require('./i18n.cjs');
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
  if (!isKrakiExecutable(file)) throw new Error(i18n.t('error.selectExecutable'));
  const output = await exec(file, ['--version']);
  const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(output)?.[0];
  if (!version) throw new Error(i18n.t('error.cliVersion'));
  return { externalCliPath: file, externalCliVersion: version };
}
function isSafeUsageShortcut(shortcut) {
  if (typeof shortcut !== 'string' || shortcut.length > 100) return false;
  const parts = shortcut.split('+');
  const key = parts.pop();
  if (!key || /^(?:esc|escape)$/i.test(key)) return false;
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) return true;
  return parts.some((mod) => /^(?:CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Super|Meta)$/i.test(mod));
}
module.exports = { exec, isKrakiExecutable, probeCli, isSafeUsageShortcut };
