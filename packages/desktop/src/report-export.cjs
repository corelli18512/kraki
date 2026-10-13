const { mkdir, writeFile } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

// 10 MiB source plus the self-contained Mermaid runtime. No renderer paths.
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
async function exportHtmlReport(tempDirectory, openPath, html, name) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_EXPORT_BYTES) {
    return { ok: false, error: 'This report exceeds the browser export safety limit.' };
  }
  const displayName = String(name || 'Report').replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120);
  try {
    const directory = path.join(tempDirectory, 'kraki-reports');
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${randomUUID()}.html`);
    await writeFile(file, html, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const error = await openPath(file);
    return error ? { ok: false, error: `Couldn’t open ${displayName} in the browser.` } : { ok: true };
  } catch {
    return { ok: false, error: `Couldn’t export ${displayName} for the browser.` };
  }
}
module.exports = { exportHtmlReport, MAX_EXPORT_BYTES };
