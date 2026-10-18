import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const output = process.env.REPORT_PREVIEW_OUTPUT || '/tmp/kraki-parity-repro/fixes/report-panel';
const baseline = process.argv.includes('--baseline'); // Label actual unmodified-panel RED evidence; no alternate render path.
const characterization = process.argv.includes('--characterize');
const onlyCase = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
if (onlyCase) assert.ok(['script', 'meta', 'link', 'adversarial'].includes(onlyCase));
await mkdir(output, { recursive: true });
const source = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  panelSha256: createHash('sha256').update(await readFile('src/components/chat/HtmlArtifactPanel.tsx')).digest('hex'),
  trackedDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', 'src/components/chat/HtmlArtifactPanel.tsx'])).digest('hex'),
  boundary: 'Host Chromium real React panel/cache only; no Windows guest, Electron/native guard or installed app.',
};
const dist = resolve(output, 'bundle');
await build({ configFile: false, root: process.cwd(), publicDir: 'public', plugins: [react()],
  define: { __GIT_HASH__: JSON.stringify('report-panel-fixture'), 'import.meta.env.VITE_WS_URL': JSON.stringify('ws://127.0.0.1:1/no-relay') }, build: { target: 'esnext',
  outDir: dist, emptyOutDir: true, rollupOptions: { input: resolve('e2e/report-panel/index.html') },
} });
const hits = [];
const server = createServer(async (req, res) => {
  if (req.url.startsWith('/__preview_canary')) {
    hits.push(req.url); res.end('<h1 data-canary>Loopback canary committed</h1>'); return;
  }
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (!/^\/(?:e2e\/report-panel\/index\.html|assets\/[a-zA-Z0-9_.-]+|vendor\/mermaid-11\.17\.2\.min\.js)$/.test(pathname)) {
    res.writeHead(404).end(); return;
  }
  try {
    const content = await readFile(resolve(dist, '.' + pathname));
    res.setHeader('Content-Type', extname(pathname) === '.js' ? 'text/javascript' : extname(pathname) === '.css' ? 'text/css' : 'text/html');
    res.end(content);
  } catch { res.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const blocked = [], errors = [], results = [];
const downloads = [];
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (new URL(url).origin === origin || /^(blob:|data:)/.test(url)) return route.continue();
  blocked.push(url); return route.abort();
});
await context.routeWebSocket('**/*', (socket) => { blocked.push(socket.url()); socket.close(); });
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(String(error)));
page.on('download', (download) => downloads.push(download.suggestedFilename()));
const entry = origin + '/e2e/report-panel/index.html';
const target = (name) => `${origin}/__preview_canary?case=${name}`;
const cases = {
  script: `<script>location.replace(${JSON.stringify(target('script'))})</script>`,
  meta: `<meta http-equiv="refresh" content="0;url=${target('meta')}">`,
  link: `<a id="go" href="${target('link')}">External link</a>`,
  adversarial: `<meta http-equiv="refresh" content="0;url=${target('refresh')}"><base href="${origin}/" target="_top">
    <script type="module">location=${JSON.stringify(target('module'))}</script>
    <link rel="stylesheet" href="${target('css')}"><style>@import url('${target('import')}');p{background:url('${target('style')}')}</style>
    <body onload="location='${target('event')}'"><img src="${target('img')}" onerror="location='${target('error')}'">
    <iframe src="${target('iframe')}" srcdoc="<meta http-equiv='refresh' content='0;url=${target('srcdoc')}'>"></iframe>
    <object data="${target('object')}"></object><form action="${target('form')}" target="_self"><button formaction="${target('formaction')}">Submit</button></form>
    <svg><a id="svg-link" href="#safe"><text x="1" y="20">SVG link</text><animate attributeName="href" values="${target('animate')}" dur="0.1s" fill="freeze"/>
    <set attributeName="href" to="${target('set')}"/></a><foreignObject><a href="${target('foreign')}">foreign</a></foreignObject></svg>
    <a id="go" href="${target('target')}" target="_top" ping="${target('ping')}">Bad link</a>
    <a id="js" href="java&#x0a;script:location='${target('js')}'">JS</a>
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/%3E">
    <div id="document"></div><img id="mermaid"><div id="DOMPurify"></div><p>Adversarial text</p>`,
};
let failure;
try {
  // Independent real HTTP positive control, before any report assertions.
  await page.goto(target('control'));
  assert.equal(await page.locator('[data-canary]').count(), 1);
  assert.equal(hits.length, 1);
  for (const [name, source] of Object.entries(cases)) {
    if ((onlyCase && name !== onlyCase) || (baseline && name === 'adversarial')) continue;
    await page.goto(entry);
    const before = hits.length;
    const commits = [];
    const onNavigate = (frame) => { if (frame !== page.mainFrame() && frame.url().startsWith(origin)) commits.push(frame.url()); };
    page.on('framenavigated', onNavigate);
    const attachment = await page.evaluate((source) => window.mountReport(source), source);
    await page.locator('iframe.kreport-frame').waitFor();
    const frame = await page.locator('iframe.kreport-frame').elementHandle().then((el) => el.contentFrame());
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
    assert.equal(await page.locator('iframe').getAttribute('referrerpolicy'), 'no-referrer');
    if (name === 'link' || name === 'adversarial') await frame.locator('#go').click();
    if (name === 'adversarial') {
      await frame.locator('#js').click();
      await frame.getByText('Submit', { exact: true }).click();
      await frame.locator('#svg-link').click();
    }
    await page.waitForTimeout(1000);
    page.off('framenavigated', onNavigate);
    const result = { name, source, attachment, hits: hits.slice(before), commits, frameUrl: frame.url(), parentUrl: page.url() };
    results.push(result);
    console.log(JSON.stringify(result));
    if (characterization) { assert.equal(result.hits.length, 1); assert.equal(commits.length, 1); }
    else { assert.equal(result.hits.length, 0, `${name}: no requests`); assert.deepEqual(commits, [], `${name}: no commits`); }
    assert.equal(page.url(), entry);
  }
  if (!baseline) {
    const source = `<style>body{margin:0}.card{color:rgb(10,20,30)}.diagram-viewport{width:500px;height:200px;position:relative;overflow:hidden;touch-action:none}.diagram-canvas{width:100%;height:100%;transform-origin:0 0}.diagram-canvas svg{width:100%;height:100%;display:block}</style>
      <h1 class="card">Valid report · 报告 · 🐙</h1><a href="#local" id="jump">Local section</a><div id="DOMPurify"></div><img id="mermaid"><div id="document"></div>
      <img id="raster" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=">
      <div data-panzoom><button data-action="out">Out</button><button data-action="reset">Reset</button><button data-action="fit">Fit</button><button data-action="in">In</button>
      <div class="diagram-viewport"><div class="diagram-canvas"><svg viewBox="0 0 100 100"><rect width="80" height="80" fill="red"/><text x="1" y="20">SVG valid</text></svg></div></div></div>
      <pre class="mermaid">graph TD; A[Trusted]--&gt;B[Rendered]</pre>
      <pre class="mermaid" id="directive">%%{init: {'securityLevel': 'loose'}}%%\ngraph TD; A--&gt;B</pre>
      <pre class="mermaid" id="frontmatter">---\nconfig:\n  securityLevel: loose\n---\ngraph TD; A--&gt;B</pre>
      <pre class="mermaid" id="callback">graph TD; A--&gt;B\nclick A "${target('mermaid-link')}"</pre>
      <script>window.mermaid={initialize(){location='${target('replace')}'}};mermaid.initialize({securityLevel:'loose'})</script>
      <div style="height:1200px"></div><section id="local">Local destination</section>`;
    await page.goto(entry);
    const before = hits.length;
    const validCommits = [];
    page.on('framenavigated', (frame) => { if (frame !== page.mainFrame() && frame.url().startsWith(origin)) validCommits.push(frame.url()); });
    await page.evaluate((source) => window.mountReport(source), source);
    await page.locator('iframe.kreport-frame').waitFor();
    await writeFile(resolve(output, 'valid-original.html'), source); // Retained, never executed as an export.
    const frame = await page.locator('iframe.kreport-frame').elementHandle().then((el) => el.contentFrame());
    await frame.locator('[data-kraki-mermaid="rendered"] svg').waitFor();
    assert.equal(await frame.locator('#directive svg, #frontmatter svg, #callback svg').count(), 0);
    assert.equal(await frame.locator('h1').textContent(), 'Valid report · 报告 · 🐙');
    assert.equal(await frame.locator('h1').evaluate((el) => getComputedStyle(el).color), 'rgb(10, 20, 30)');
    assert.equal(await frame.locator('#raster').evaluate((el) => el.complete && el.naturalWidth === 1), true);
    assert.equal(await frame.getByText('SVG valid').count(), 1);
    const canvas = frame.locator('.diagram-canvas');
    await frame.getByRole('button', { name: 'In', exact: true }).click();
    assert.match(await canvas.getAttribute('style'), /scale\(1\.2\)/);
    await frame.getByRole('button', { name: 'Out', exact: true }).click();
    assert.match(await canvas.getAttribute('style'), /scale\(1\)/);
    await frame.getByRole('button', { name: 'In', exact: true }).click();
    await frame.getByRole('button', { name: 'Fit', exact: true }).click();
    assert.equal(await canvas.evaluate((el) => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    const viewport = frame.locator('.diagram-viewport');
    await viewport.hover(); await page.mouse.wheel(0, -100);
    await page.waitForTimeout(100);
    assert.match(await canvas.getAttribute('style'), /scale\(1\.12\)/);
    const beforeDrag = await canvas.evaluate((el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f }; });
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + 100, box.y + 80); await page.mouse.down();
    await page.mouse.move(box.x + 130, box.y + 110, { steps: 3 }); await page.mouse.up();
    const afterDrag = await canvas.evaluate((el) => { const m = new DOMMatrix(getComputedStyle(el).transform); return { x: m.e, y: m.f }; });
    assert.equal(afterDrag.x - beforeDrag.x, 30);
    assert.equal(afterDrag.y - beforeDrag.y, 30);
    await frame.getByRole('button', { name: 'Reset', exact: true }).click();
    assert.equal(await canvas.evaluate((el) => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
    await frame.locator('#jump').focus();
    await page.keyboard.press('Enter');
    await frame.waitForFunction(() => scrollY > 900);
    assert.equal(new URL(frame.url()).hash, '');
    // Mutated URL cannot replace the initial local-fragment capability.
    await frame.locator('#jump').evaluate((el, url) => el.setAttribute('href', url), target('mutated'));
    await frame.locator('#jump').click();
    await page.waitForTimeout(1000);
    assert.deepEqual(hits.slice(before), []);
    assert.deepEqual(validCommits, []);
    results.push({ name: 'valid', commits: validCommits, mermaid: 'real bundled SVG', localFragment: 'owned scroll/no blob navigation', panzoom: 'in/out/fit/reset/wheel/drag', hits: hits.slice(before) });
    const initialBox = await page.locator('iframe').boundingBox();
    const ownedUrl = frame.url();
    await page.getByRole('button', { name: 'Expand Report' }).click();
    assert.ok((await page.locator('aside').getAttribute('class')).includes('is-expanded'));
    await page.setViewportSize({ width: 1200, height: 900 });
    const resizedBox = await page.locator('iframe').boundingBox();
    assert.equal(resizedBox.width - initialBox.width, 200);
    assert.equal(resizedBox.height - initialBox.height, 100);
    assert.equal(frame.url(), ownedUrl);
    await page.getByRole('button', { name: 'Restore Split View' }).click();
    assert.ok(!(await page.locator('aside').getAttribute('class')).includes('is-expanded'));
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.screenshot({ path: resolve(output, 'valid.png') });
  }
  if (!baseline) {
    const clean = '<!doctype html><html><head><title>Clean</title></head><body><h1>Original clean · 报告</h1></body></html>';
    const mermaid = '<!doctype html><html><body><pre class="mermaid">graph TD; A[Offline]--&gt;B[Rendered]</pre></body></html>';
    const vendor = (await readFile(resolve('public/vendor/mermaid-11.17.2.min.js'), 'utf8')).replace(/<\/script/gi, '<\\/script');
    for (const [name, original] of [['clean', clean], ['mermaid', mermaid]]) {
      await page.goto(entry);
      const start = hits.length;
      await page.evaluate((source) => window.mountReport(source), original);
      await page.getByRole('button', { name: 'Open in Browser' }).waitFor();
      if (name === 'mermaid') await page.frameLocator('iframe').locator('[data-kraki-mermaid="rendered"] svg').waitFor();
      const expectedExport = await page.evaluate((source) => window.referenceExport(source), original);
      await page.waitForTimeout(1000);
      assert.deepEqual(hits.slice(start), []);
      assert.equal(downloads.length, name === 'clean' ? 0 : 1, 'no automatic export');
      // No download/open until this explicit ordinary user click. Saved content is read inertly, never opened.
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Open in Browser' }).click();
      const download = await downloadEvent;
      const saved = resolve(output, name + '-export.html');
      await download.saveAs(saved);
      const content = await readFile(saved, 'utf8');
      assert.equal(content, expectedExport, 'exact bytes match unchanged original export API');
      assert.equal(download.suggestedFilename(), 'fixture.html');
      assert.ok(!content.includes('Content-Security-Policy'));
      if (name === 'clean') assert.equal(content, original);
      else {
        assert.ok(content.startsWith(original.slice(0, original.indexOf('</body>'))));
        assert.ok(content.includes('<script>' + vendor + '</script>'));
        assert.ok(content.includes("window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })"));
        assert.ok(content.endsWith('</body></html>'));
        assert.ok(!content.includes('<script src='));
        // Exactly the original plus two inline script tags, with the trusted boot script as the final insertion.
        const scripts = content.slice(original.indexOf('</body>'), -'</body></html>'.length);
        assert.ok(scripts.startsWith('<script>' + vendor + '</script><script>'));
        assert.ok(scripts.endsWith('</script>'));
      }
      results.push({ name: name + '-export', bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex'), referenceBytesEqual: true, saved, originalPreserved: true, neverExecuted: true });
    }
  }
  assert.deepEqual(blocked, []);
  assert.deepEqual(errors, []);
} catch (error) { failure = String(error.stack || error); console.error(failure); }
finally {
  await writeFile(resolve(output, baseline ? (characterization ? 'baseline-characterization.json' : `red-${onlyCase || 'all'}.json`) : 'green.json'), JSON.stringify({ source, baseline, characterization, engine: browser.version(), origin, results, hits, blocked, errors, failure }, null, 2));
  await context.close(); await browser.close(); await new Promise((done) => server.close(done));
}
if (failure) process.exitCode = 1;
