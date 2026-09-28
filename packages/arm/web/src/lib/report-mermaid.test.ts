import { beforeEach, describe, expect, it, vi } from 'vitest';
import { containsMermaid, MERMAID_RUNTIME_URL, resetMermaidRuntimeCache, withMermaidRuntime } from './report-mermaid';

const report = '<html><body><h1>R</h1><pre class="mermaid">graph TD; A--&gt;B</pre></body></html>';

describe('report Mermaid runtime', () => {
  beforeEach(() => resetMermaidRuntimeCache());

  it('detects Mermaid blocks', () => {
    expect(containsMermaid(report)).toBe(true);
    expect(containsMermaid('<pre><code class="language-mermaid">graph TD</code></pre>')).toBe(true);
    expect(containsMermaid('<p>plain text report</p>')).toBe(false);
  });

  it('inlines the vendored runtime once, before </body>, escaping script terminators', async () => {
    const fetcher = vi.fn(async () => new Response('window.mermaid={run(){}};"</script>";'));
    const html = await withMermaidRuntime(report, fetcher as unknown as typeof fetch);
    await withMermaidRuntime(report, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(MERMAID_RUNTIME_URL);
    expect(html).toContain('"<\\/script>"');
    expect(html.indexOf('window.mermaid={run')).toBeLessThan(html.indexOf('</body>'));
    expect(html).toContain("securityLevel: 'strict'");
  });

  it('leaves plain and self-rendering reports untouched', async () => {
    const fetcher = vi.fn();
    expect(await withMermaidRuntime('<p>text</p>', fetcher as unknown as typeof fetch)).toBe('<p>text</p>');
    const own = '<pre class="mermaid">graph TD</pre><script>mermaid.initialize({})</script>';
    expect(await withMermaidRuntime(own, fetcher as unknown as typeof fetch)).toBe(own);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back to the source when the runtime cannot load', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 }));
    expect(await withMermaidRuntime(report, fetcher as unknown as typeof fetch)).toBe(report);
  });
});
