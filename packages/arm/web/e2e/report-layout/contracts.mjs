import assert from 'node:assert/strict';

// Observation only: no style mutation, polling, RAF delay or alternate geometry path.
export async function geometry(page, label) {
  const parent = await page.evaluate(() => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { x: r.x, y: r.y, width: r.width, height: r.height,
        clientWidth: el.clientWidth, clientHeight: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight,
        styles: Object.fromEntries(['boxSizing', 'position', 'display', 'width', 'height', 'minWidth', 'minHeight', 'overflowX', 'overflowY', 'borderLeftWidth', 'borderBottomWidth', 'paddingTop', 'paddingBottom', 'fontFamily', 'fontSize', 'lineHeight', 'containerType'].map(k => [k, s[k]])) };
    };
    return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualWidth: visualViewport?.width, visualHeight: visualViewport?.height },
      scrollbar: { horizontal: innerHeight - document.documentElement.clientHeight, vertical: innerWidth - document.documentElement.clientWidth },
      boxes: Object.fromEntries(Object.entries({ document: document.documentElement, body: document.body, root: document.querySelector('#root'), app: document.querySelector('.app-viewport'), sidebar: document.querySelector('[data-layout-sidebar]'), main: document.querySelector('main'), page: document.querySelector('.kchat-page'), container: document.querySelector('.kmedia-pane'), panel: document.querySelector('.kreport-panel'), header: document.querySelector('.kreport-header'), iframe: document.querySelector('.kreport-frame'), expand: document.querySelector('.kreport-expand') }).map(([k, el]) => [k, box(el)])) };
  });
  const frame = await page.locator('iframe.kreport-frame').elementHandle().then(el => el.contentFrame());
  const report = await frame.evaluate(() => ({ url: location.href, origin: self.origin, dpr: devicePixelRatio, width: innerWidth, height: innerHeight, scrollX, scrollY,
    document: { clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
    body: { boxSizing: getComputedStyle(document.body).boxSizing, color: getComputedStyle(document.body).color },
    cannotReadParent: (() => { try { void parent.document; return false; } catch { return true; } })() }));
  return { label, ...parent, report };
}

const controls = {
  short: '<!doctype html><html><body><h1>Report · 报告 · 🐙</h1><p>Short content</p></body></html>',
  // These styles must stay inside the sandbox, including deliberately broad selectors.
  long: '<!doctype html><html><head><style>*{box-sizing:content-box}body{color:rgb(10,20,30)}aside{width:10000px} .wide{width:10000px;height:4000px}</style></head><body><h1>Report · 报告 · 🐙</h1><div class="wide">Long styled content</div><section id="local">Local destination</section></body></html>',
};

export async function layoutContract(page, variant, control, record) {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.evaluate(source => window.mountReport(source), controls[control]);
  const iframe = page.locator('iframe.kreport-frame');
  await iframe.waitFor();
  const frame = await iframe.elementHandle().then(el => el.contentFrame());
  await frame.locator('h1').waitFor();
  assert.equal(await frame.locator('h1').textContent(), 'Report · 报告 · 🐙');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(await iframe.getAttribute('referrerpolicy'), 'no-referrer');
  const sample = async label => { const g = await geometry(page, label); record.samples.push(g); return g; };
  const initial = await sample('initial-1000x800');
  assert.equal(initial.report.cannotReadParent, true);
  if (control === 'long') {
    assert.equal(initial.report.body.color, 'rgb(10, 20, 30)');
    assert.ok(initial.report.document.scrollWidth >= 10000);
    assert.ok(initial.report.document.scrollHeight >= 4000);
  }
  const ownedUrl = initial.report.url;
  if (variant !== 'bare') {
    assert.equal(initial.boxes.panel.styles.boxSizing, 'border-box');
    assert.equal(initial.boxes.header.height, 37, 'processed preflight changes the header border box, not just panel width');
    assert.equal(initial.scrollbar.horizontal, 0);
    assert.equal(initial.boxes.document.scrollWidth, 1000);
  } else {
    assert.equal(initial.boxes.panel.styles.boxSizing, 'content-box');
    assert.equal(initial.boxes.panel.width, 1001, 'original width100% plus untouched 1px border');
    assert.equal(initial.boxes.header.height, 46, 'content height37 + padding8 + border1');
    assert.equal(initial.boxes.document.scrollWidth, 1001);
  }
  if (variant === 'structural') {
    assert.equal(initial.boxes.sidebar.width, 280);
    assert.equal(initial.boxes.main.width, 720);
    assert.equal(initial.boxes.container.width, 719);
    assert.equal(initial.boxes.container.styles.containerType, 'inline-size');
    assert.equal(initial.boxes.expand.styles.display, 'none', 'production <=779 container rule hides control');
    assert.equal(await page.getByRole('button', { name: 'Expand Report' }).isVisible(), false);
    assert.equal(initial.boxes.panel.styles.position, 'absolute');
    assert.equal(initial.boxes.panel.width, 719);
    assert.equal(initial.boxes.panel.styles.borderLeftWidth, '0px');
    await page.setViewportSize({ width: 1200, height: 900 });
    const wide = await sample('split-1200x900');
    assert.equal(wide.boxes.container.width, 919);
    assert.equal(wide.boxes.panel.styles.position, 'static');
    assert.equal(wide.boxes.expand.styles.display, 'flex');
    // Record the real clamp(380px,46cqw,680px), including engine subpixel quantization;
    // check its bounds and split ownership without copying CSS sizing arithmetic.
    assert.ok(wide.boxes.panel.width >= 380 && wide.boxes.panel.width <= 680);
    assert.ok(wide.boxes.panel.width < wide.boxes.container.width);
    assert.equal(wide.boxes.iframe.height - initial.boxes.iframe.height, 100);
    await page.setViewportSize({ width: 1000, height: 800 });
    const back = await sample('overlay-restored-1000x800');
    assert.deepEqual(back.boxes.iframe, initial.boxes.iframe);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.getByRole('button', { name: 'Expand Report', exact: true }).click();
    const expanded = await sample('expanded-1200x900');
    assert.equal(expanded.boxes.panel.width, 919);
    assert.equal(expanded.boxes.panel.styles.position, 'absolute');
    assert.equal(expanded.boxes.iframe.height, wide.boxes.iframe.height);
    await page.setViewportSize({ width: 1400, height: 1000 });
    const larger = await sample('expanded-1400x1000');
    assert.equal(larger.boxes.iframe.width - expanded.boxes.iframe.width, 200);
    assert.equal(larger.boxes.iframe.height - expanded.boxes.iframe.height, 100);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.getByRole('button', { name: 'Restore Split View', exact: true }).click();
    const restored = await sample('split-restored-1200x900');
    assert.deepEqual(restored.boxes.iframe, wide.boxes.iframe);
  } else {
    // Exact original order and strict width200/height100 contract. No retries/delay.
    await page.getByRole('button', { name: 'Expand Report', exact: true }).click();
    assert.ok((await page.locator('.kreport-panel').getAttribute('class')).includes('is-expanded'));
    await page.setViewportSize({ width: 1200, height: 900 });
    const resized = await sample('expanded-resized-1200x900');
    // Record both deltas even if the retained Windows bare height assertion fails.
    record.originalDelta = { width: resized.boxes.iframe.width - initial.boxes.iframe.width, height: resized.boxes.iframe.height - initial.boxes.iframe.height };
    assert.equal(record.originalDelta.width, 200);
    assert.equal(record.originalDelta.height, 100);
    await page.getByRole('button', { name: 'Restore Split View', exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 800 });
    const restored = await sample('restored-1000x800');
    assert.deepEqual(restored.boxes.iframe, initial.boxes.iframe);
  }
  assert.equal(frame.url(), ownedUrl);
  if (variant !== 'bare') {
    for (const g of record.samples) {
      assert.equal(g.scrollbar.horizontal, 0);
      assert.equal(g.boxes.document.scrollWidth, g.viewport.width);
      assert.equal(g.boxes.panel.styles.boxSizing, 'border-box');
    }
  }
}

export async function boundaryContract(page, origin, record) {
  // Independent HTTP positive control is owned by the runner, outside this report.
  const target = `${origin}/__layout_canary?report=blocked`;
  const source = `<h1>Security separation</h1><script>location=${JSON.stringify(target)}</script><meta http-equiv="refresh" content="0;url=${target}"><a id="external" href="${target}">Blocked external</a><pre class="mermaid">graph TD; A[Real]--&gt;B[Mermaid]</pre>`;
  await page.evaluate(source => window.mountReport(source), source);
  const frame = await page.locator('iframe.kreport-frame').elementHandle().then(el => el.contentFrame());
  await frame.locator('[data-kraki-mermaid="rendered"] svg').waitFor();
  await frame.locator('#external').click();
  record.security = await geometry(page, 'security');
  assert.equal(record.security.report.cannotReadParent, true);
  const clean = '<!doctype html><html><body><h1>Inert explicit export · 报告</h1></body></html>';
  await page.evaluate(source => window.mountReport(source), clean);
  await page.frameLocator('iframe.kreport-frame').locator('h1').waitFor();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Open in Browser', exact: true }).click();
  const download = await event;
  return { download, clean };
}
