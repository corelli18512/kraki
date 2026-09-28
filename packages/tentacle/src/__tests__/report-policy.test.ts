import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPORT_MAX_BYTES, REPORT_VALIDATOR_SOURCE, validateReportHtml } from '../report-policy.js';
import { PI_KRAKI_TOOLS_SOURCE } from '../adapters/pi-kraki-tools.js';

const page = (body: string) => Buffer.from(`<!doctype html><html><head><title>R</title></head><body>${body}</body></html>`);

describe('show_report policy', () => {
  it('accepts a text-first report with complex Mermaid source and inline SVG', () => {
    const mermaid = Array.from({ length: 200 }, (_, i) => `  N${i}["node ${i}"] --> N${i + 1}`).join('\n');
    const html = page(`<h1>Report</h1><table><tr><td>a</td></tr></table>
      <pre class="mermaid">flowchart LR\n${mermaid}</pre>
      <pre class="mermaid">classDiagram\n class A { &lt;&lt;interface&gt;&gt; }</pre>
      <svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>
      <script>document.title = 'ok';</script>
      <a href="https://example.com">a normal link is fine</a>`);
    expect(validateReportHtml(html)).toBeNull();
  });

  it('rejects reports over 1 MB with an actionable message', () => {
    const html = page('x'.repeat(REPORT_MAX_BYTES + 1));
    expect(validateReportHtml(html)).toMatch(/limit is 1 MB/);
  });

  it.each([
    ['<video src="data:video/mp4;base64,AAAA"></video>'],
    ['<audio controls></audio>'],
    ['<img src="data:video/mp4;base64,AAAA">'],
  ])('rejects embedded media: %s', (snippet) => {
    expect(validateReportHtml(page(snippet))).toMatch(/video or audio/);
  });

  it('rejects an inlined JavaScript library such as Mermaid', () => {
    const html = page(`<script>${'var mermaid=1;'.repeat(6000)}</script><pre class="mermaid">graph TD; A-->B</pre>`);
    expect(validateReportHtml(html)).toMatch(/Do not inline libraries/);
  });

  it.each([
    ['<script src="https://cdn.jsdelivr.net/npm/mermaid"></script>'],
    ['<link rel="stylesheet" href="//fonts.example/css">'],
    ['<img src="http://example.com/a.png">'],
  ])('rejects external resources: %s', (snippet) => {
    expect(validateReportHtml(page(snippet))).toMatch(/external resources/);
  });

  it('allows small inline images but rejects screenshot-sized raster payloads', () => {
    expect(validateReportHtml(page(`<img src="data:image/png;base64,${'A'.repeat(50_000)}">`))).toBeNull();
    expect(validateReportHtml(page(`<img src="data:image/jpeg;base64,${'A'.repeat(250_000)}">`))).toMatch(/show_image/);
  });

  it('embeds the same validator in the materialized Pi extension', () => {
    expect(REPORT_VALIDATOR_SOURCE).not.toContain('`');
    expect(REPORT_VALIDATOR_SOURCE).not.toContain('${');
    expect(PI_KRAKI_TOOLS_SOURCE).toContain(REPORT_VALIDATOR_SOURCE);
    expect(PI_KRAKI_TOOLS_SOURCE).toContain('krakiValidateReport(bytes)');
  });

  it('the materialized extension registers show_report (not show_html) and enforces the policy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kraki-show-report-'));
    try {
      const extPath = join(dir, 'kraki-tools.mjs');
      writeFileSync(extPath, PI_KRAKI_TOOLS_SOURCE);
      const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
      const mod = await import(pathToFileURL(extPath).href);
      mod.default({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => {} });
      expect(tools.has('show_report')).toBe(true);
      expect(tools.has('show_html')).toBe(false);

      const good = join(dir, 'good.html');
      writeFileSync(good, page('<pre class="mermaid">graph TD; A-->B</pre>'));
      const ok = await tools.get('show_report')!.execute('1', { path: good, title: 'T' });
      expect(ok.details).toMatchObject({ htmlPath: good, title: 'T', name: 'good.html' });

      const bad = join(dir, 'bad.html');
      writeFileSync(bad, page('<video src="data:video/mp4;base64,AAAA"></video>'));
      await expect(tools.get('show_report')!.execute('2', { path: bad })).rejects.toThrow(/show_report: .*video or audio.*call show_report again/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
