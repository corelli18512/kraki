/**
 * Client-side Mermaid for `show_report` HTML reports.
 *
 * Reports carry Mermaid *source* (`<pre class="mermaid">`) instead of
 * screenshots or an inlined 3.5 MB library. The report iframe is sandboxed
 * with a CSP that only allows inline scripts, so the vendored runtime
 * (MIT, public/vendor/LICENSE-mermaid.txt) is inlined into the report just
 * before rendering — only for reports that contain Mermaid blocks and do not
 * already bring their own copy.
 */

export const MERMAID_RUNTIME_URL = '/vendor/mermaid-11.17.2.min.js';

const MARKER = /class\s*=\s*["'][^"']*\bmermaid\b|language-mermaid/i;

export const MERMAID_BOOT = `(function () {
  var selector = 'pre.mermaid, div.mermaid, code.language-mermaid';
  if (!(window.mermaid && typeof window.mermaid.run === 'function') || !document.querySelector(selector)) return;
  document.querySelectorAll('code.language-mermaid').forEach(function (code) {
    var pre = code.parentElement && code.parentElement.tagName === 'PRE' ? code.parentElement : code;
    pre.classList.add('mermaid');
    pre.textContent = code.textContent;
  });
  try {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    window.mermaid.run({ querySelector: 'pre.mermaid:not([data-processed]), div.mermaid:not([data-processed])' }).catch(function () {});
  } catch (e) {}
})();`;

export function containsMermaid(html: string): boolean {
  return MARKER.test(html);
}

let runtime: Promise<string> | null = null;

function loadRuntime(fetcher: typeof fetch): Promise<string> {
  if (!runtime) {
    runtime = fetcher(MERMAID_RUNTIME_URL)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .catch((err) => {
        runtime = null;
        throw err;
      });
  }
  return runtime;
}

/** Returns `html` with the Mermaid runtime inlined when it needs one. */
export async function withMermaidRuntime(html: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!containsMermaid(html) || /mermaid\.initialize/i.test(html)) return html;
  let library: string;
  try {
    library = await loadRuntime(fetcher);
  } catch {
    return html; // Show the source rather than no report.
  }
  const safe = (js: string) => js.replace(/<\/script/gi, '<\\/script');
  const tags = `<script>${safe(library)}</script><script>${MERMAID_BOOT}</script>`;
  const end = html.search(/<\/body>(?![\s\S]*<\/body>)/i);
  return end >= 0 ? html.slice(0, end) + tags + html.slice(end) : html + tags;
}

/** Test hook. */
export function resetMermaidRuntimeCache(): void {
  runtime = null;
}
