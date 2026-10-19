import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { layoutContract, boundaryContract, geometry } from './contracts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const output = resolve(process.env.REPORT_LAYOUT_OUTPUT || `./.tmp/report-layout-${Date.now()}`);
// Never overwrite a prior run, including failure artifacts.
await mkdir(output, { recursive: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const sources = ['src/main.tsx', 'src/App.tsx', 'src/pages/SessionPage.tsx', 'src/index.css', 'src/components/chat/HtmlArtifactPanel.tsx', 'src/components/chat/chat.css', 'src/components/layout/sidebar.css', 'vite.config.ts', '../../../pnpm-lock.yaml', 'node_modules/tailwindcss/preflight.css', 'e2e/report-panel/index.html', 'e2e/report-panel/scenario.tsx', 'e2e/report-panel/scenario.css', 'e2e/report-panel/run.mjs', 'e2e/report-layout/processed.tsx', 'e2e/report-layout/structural.tsx', 'e2e/report-layout/contracts.mjs', 'e2e/report-layout/run.mjs'];
const manifest = { head: git('rev-parse', 'HEAD'), base: 'd0ea79b9bfdc26d7ded0d1222f39cfd15e699475', platform: process.platform, arch: process.arch, node: process.version,
  trackedDiffSha256: sha(execFileSync('git', ['diff', 'HEAD'])), sources: {}, variants: {},
  boundary: 'Actual component+actual processed CSS; manually assembled structural wrappers, NOT App/Router. Browser fixture only, no Electron/native/VM/backend.' };
for (const path of sources) manifest.sources[path] = sha(await readFile(resolve(root, path)));
const entries = { bare: 'e2e/report-panel/index.html', processed: 'e2e/report-layout/processed.html', structural: 'e2e/report-layout/structural.html' };
const selected = process.env.REPORT_LAYOUT_VARIANT ? [process.env.REPORT_LAYOUT_VARIANT] : Object.keys(entries);
for (const variant of selected) assert.ok(entries[variant], `unknown variant ${variant}`);
for (const variant of selected) {
  const dist = resolve(output, variant, 'bundle');
  // Separate invocations prevent the original bare entry receiving shared app CSS.
  await build({ root, base: `/${variant}/`, configFile: variant === 'bare' ? false : resolve(root, 'vite.config.ts'),
    ...(variant === 'bare' ? { plugins: [react()] } : {}),
    cacheDir: resolve(output, variant, 'vite-cache'),
    define: { __GIT_HASH__: JSON.stringify(manifest.head) },
    build: { target: 'esnext', outDir: dist, emptyOutDir: true, rollupOptions: { input: resolve(root, entries[variant]) } } });
  const assets = {};
  const scan = async dir => { for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await scan(path);
    else assets[relative(dist, path).replaceAll('\\', '/')] = sha(await readFile(path));
  } };
  await scan(dist);
  manifest.variants[variant] = { entry: entries[variant], config: variant === 'bare' ? 'original react-only build context' : 'actual vite.config.ts: react() + @tailwindcss/vite()', assets };
}
await writeFile(resolve(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
if (process.argv.includes('--build-only')) process.exit(0);
const hits = [];
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/__layout_canary') { hits.push(req.url); res.end('<h1 data-control>HTTP positive control</h1>'); return; }
  const [, prefix, ...parts] = path.split('/');
  // The production Mermaid loader uses this absolute path; identical frozen
  // vendored bytes are served from the first built context for manual replay too.
  const variant = prefix === 'vendor' ? selected[0] : prefix;
  const asset = prefix === 'vendor' ? `vendor/${parts.join('/')}` : parts.join('/');
  if (!selected.includes(variant) || !Object.hasOwn(manifest.variants[variant].assets, asset)) { res.writeHead(404).end(); return; }
  try {
    const bytes = await readFile(resolve(output, variant, 'bundle', asset));
    res.setHeader('Content-Type', extname(asset) === '.js' ? 'text/javascript' : extname(asset) === '.css' ? 'text/css' : 'text/html');
    res.end(bytes);
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ output, origin, entries: Object.fromEntries(selected.map(v => [v, `${origin}/${v}/${entries[v]}`])) }));
  console.log('Actual component+CSS only. No native bootstrap. Press Ctrl+C to stop this owned server.');
  await new Promise(() => {});
}
let browser;
const results = [];
try {
  browser = await chromium.launch({ ...(process.env.REPORT_LAYOUT_CHANNEL ? { channel: process.env.REPORT_LAYOUT_CHANNEL } : {}) });
  for (const variant of selected) {
    for (const control of ['short', 'long', 'boundary-export']) {
      const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
      const record = { variant, control, samples: [], errors: [], blocked: [], downloads: [], commits: [], requests: [], failures: [] };
      results.push(record);
      const startHits = hits.length;
      const entry = `${origin}/${variant}/${entries[variant]}`;
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (/^(blob:|data:)$/.test(url.protocol)) return route.continue();
        if (url.origin !== origin) { record.blocked.push(url.href); return route.abort(); }
        return route.continue();
      });
      await context.routeWebSocket('**/*', socket => { record.blocked.push(socket.url()); socket.close(); });
      const page = await context.newPage();
      page.on('pageerror', error => record.errors.push(String(error)));
      page.on('download', download => record.downloads.push(download.suggestedFilename()));
      page.on('framenavigated', frame => record.commits.push({ main: frame === page.mainFrame(), url: frame.url() }));
      page.on('request', req => record.requests.push({ url: req.url(), type: req.resourceType(), navigation: req.isNavigationRequest() }));
      page.on('requestfailed', req => record.failures.push({ url: req.url(), error: req.failure() }));
      try {
        await page.goto(`${origin}/__layout_canary?control=${variant}-${control}`);
        assert.equal(await page.locator('[data-control]').count(), 1);
        assert.equal(hits.length, startHits + 1);
        await page.goto(entry);
        if (control === 'boundary-export') {
          const { download, clean } = await boundaryContract(page, origin, record);
          const saved = resolve(output, variant, 'explicit-export.html');
          await download.saveAs(saved);
          const bytes = await readFile(saved);
          assert.equal(bytes.toString('utf8'), clean, 'clean explicit export exact original bytes, inert read only');
          assert.equal(record.downloads.length, 1, 'only the explicit ordinary click exported');
          record.export = { saved, bytes: bytes.length, sha256: sha(bytes), neverExecuted: true };
        } else {
          await layoutContract(page, variant, control, record);
          assert.deepEqual(record.downloads, [], 'layout never auto-exports');
        }
        assert.deepEqual(hits.slice(startHits + 1), [], 'no report canary requests');
        assert.deepEqual(record.commits.filter(c => !c.main && c.url.startsWith(origin)), [], 'no report HTTP frame commits');
        assert.equal(page.url(), entry);
        assert.deepEqual(record.errors, []);
        assert.deepEqual(record.blocked, []);
      } catch (error) {
        record.failure = String(error.stack || error);
        console.error(record.failure);
        // Preserve observation at the failure, without replacing the original sample/assertion.
        if (await page.locator('iframe.kreport-frame').count()) record.failureGeometry = await geometry(page, 'failure').catch(String);
        await page.screenshot({ path: resolve(output, `${variant}-${control}-failure.png`) });
        // Only retained assertion REDs may continue into independently named cases.
        // Launch/network/timeout/build infrastructure failures must stop, not retry.
        if (!(error instanceof assert.AssertionError)) throw error;
      } finally {
        record.hits = hits.slice(startHits);
        await writeFile(resolve(output, `${variant}-${control}.json`), JSON.stringify(record, null, 2));
        await context.close();
      }
      console.log(JSON.stringify({ variant, control, failure: record.failure || null, originalDelta: record.originalDelta, samples: record.samples.map(s => ({ label: s.label, scrollbar: s.scrollbar, iframe: s.boxes.iframe, container: s.boxes.container })) }));
    }
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ manifest, origin, browser: browser?.version(), hits, results }, null, 2));
}
if (results.some(r => r.failure)) process.exitCode = 1;
