const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { exportHtmlReport, MAX_EXPORT_BYTES } = require('../src/report-export.cjs');

test('report export writes unique HTML files only in the temp report directory', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraki-export-test-'));
  try {
    const opened = [];
    const openPath = async (file) => { opened.push(file); return ''; };
    const html = '<!doctype html><title>Original</title><pre class="mermaid">graph LR; A-->B</pre>';
    assert.deepEqual(await exportHtmlReport(temp, openPath, html, '../../outside.exe'), { ok: true });
    assert.deepEqual(await exportHtmlReport(temp, openPath, html, '../../outside.exe'), { ok: true });
    assert.notEqual(opened[0], opened[1]);
    for (const file of opened) {
      assert.equal(path.dirname(file), path.join(temp, 'kraki-reports'));
      assert.match(path.basename(file), /^[0-9a-f-]+\.html$/);
      assert.equal(await fs.readFile(file, 'utf8'), html);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('report export rejects non-string/oversized UTF-8 and reports open failures', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'kraki-export-test-'));
  try {
    let calls = 0;
    const openPath = async () => { calls++; return 'No browser'; };
    assert.equal((await exportHtmlReport(temp, openPath, {}, 'Report')).ok, false);
    assert.equal((await exportHtmlReport(temp, openPath, 'é'.repeat(MAX_EXPORT_BYTES / 2 + 1), 'Report')).ok, false);
    assert.equal(calls, 0);
    assert.equal((await exportHtmlReport(temp, openPath, '<title>Report</title>', 'Report')).ok, false);
    assert.equal(calls, 1);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
