import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareReportPreview } from './report-preview';
import { resetMermaidRuntimeCache, MERMAID_RUNTIME_URL, withMermaidRuntime } from './report-mermaid';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('prepareReportPreview', () => {
  beforeEach(() => { resetMermaidRuntimeCache(); vi.unstubAllGlobals(); });

  it('strips executable, navigation, embedded document and SVG mutation routes', async () => {
    const html = await prepareReportPreview(`<!doctype html><head>
      <meta http-equiv="refresh" content="0;url=http://127.0.0.1:1/">
      <base href="http://127.0.0.1:1/" target="_top"><link rel="stylesheet" href="http://127.0.0.1:1/">
      </head><body onload="location='http://127.0.0.1:1/'">
      <script nonce="spoof">location='http://127.0.0.1:1/'</script><script type="module" src="http://127.0.0.1:1/"></script>
      <iframe srcdoc="<script>location='/'</script>"></iframe><object data="/"></object>
      <form action="/"><input name="submit" formaction="/"><button formaction="/">Send</button></form>
      <a href="&#106;avascript:alert(1)" target="_top" ping="/">bad</a>
      <a href="http://127.0.0.1:1/" download>external</a>
      <svg><a xlink:href="http://127.0.0.1:1/"><text>SVG</text><set attributeName="href" to="/"/></a>
      <animate attributeName="href" values="/"/><foreignObject><iframe src="/"></iframe></foreignObject></svg>
      <img src="data:image/svg+xml;base64,PHN2Zz4=" onerror="alert(1)" srcset="/ 1x">
      <math><mtext><a href="/">math</a></mtext></math></body>`);
    const doc = parse(html);
    expect(doc.querySelectorAll('script:not([nonce])')).toHaveLength(0);
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'nonce-");
    expect(doc.querySelector('meta[http-equiv="refresh"], base, link, iframe, object, form, input, animate, set, foreignObject, math')).toBeNull();
    for (const element of doc.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        expect(attr.name).not.toMatch(/^on|^srcdoc$|^srcset$|^target$|^formaction$/i);
        if (attr.name === 'href' || attr.name === 'xlink:href' || attr.name === 'src') expect(attr.value).toMatch(/^#|^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/);
      }
    }
    expect(html).not.toContain('nonce="spoof"');
    expect(doc.head.firstElementChild?.tagName).toBe('META');
  });

  it('retains text, styles, inline SVG, local URLs and embedded raster images', async () => {
    const doc = parse(await prepareReportPreview(`<style>.card{color:red}</style><h1>Readable &amp; safe</h1>
      <a href="#local">Jump</a><section id="local" style="color:blue" data-panzoom><button data-action="in">+</button>
      <svg viewBox="0 0 10 10"><defs><marker id="arrow"><path d="M0 0L1 1"/></marker></defs>
      <path marker-end="url(#arrow)" d="M0 0L9 9"/><text>Diagram</text></svg></section>
      <img src="data:image/png;base64,iVBORw0KGgo=">`));
    expect(doc.querySelector('h1')?.textContent).toBe('Readable & safe');
    expect(doc.querySelector('style')?.textContent).toContain('color:red');
    expect(doc.querySelector('section')?.getAttribute('style')).toBe('color:blue');
    expect(doc.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 10 10');
    expect(doc.querySelector('marker')).not.toBeNull();
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('#local');
    expect(doc.querySelector('button')?.getAttribute('data-action')).toBe('in');
    expect(doc.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/);
  });

  it('loads only the trusted Mermaid path despite report initialize, and leaves export independent', async () => {
    const fetcher = vi.fn(async () => new Response('window.mermaid={initialize(){},render(){}};'));
    vi.stubGlobal('fetch', fetcher);
    const original = '<pre class="mermaid">graph TD; A--&gt;B</pre><script>mermaid.initialize({securityLevel:"loose"})</script>';
    const preview = await prepareReportPreview(original);
    expect(fetcher).toHaveBeenCalledWith(MERMAID_RUNTIME_URL);
    expect(preview).not.toContain('securityLevel:"loose"');
    expect(preview).toContain('securityLevel: "strict"');
    expect(parse(preview).querySelectorAll('script[nonce]')).toHaveLength(3);
    expect(await withMermaidRuntime(original)).toBe(original);
    expect(original).toContain('securityLevel:"loose"');
  });

  it('uses fresh script nonces and fails closed to source on unavailable Mermaid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const original = '<pre class="mermaid">graph TD; A--&gt;B</pre>';
    const first = parse(await prepareReportPreview(original));
    const second = parse(await prepareReportPreview(original));
    expect(first.querySelector('script')?.getAttribute('nonce')).not.toBe(second.querySelector('script')?.getAttribute('nonce'));
    expect(first.querySelectorAll('script')).toHaveLength(1);
    expect(first.querySelector('pre')?.textContent).toContain('graph TD');
  });
});
