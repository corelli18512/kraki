import { t } from '../i18n';
import createDOMPurify from 'dompurify';
import purifierSource from 'dompurify/dist/purify.min.js?raw';
import { loadReportMermaidRuntime } from './report-mermaid';
import { REPORT_PREVIEW_POLICY, restrictReportPreviewUrls } from './report-preview-policy';
import { installReportPreviewRuntime } from './report-preview-runtime';

const scriptText = (source: string): string => source.replace(/<\/script/gi, '<\\/script');

/**
 * Preview ONLY. Call with the original attachment text, never with export-prepared HTML.
 * Put the returned document in a blob iframe with sandbox="allow-scripts" (no same-origin).
 * Do not prepend another CSP. Export separately with withMermaidRuntime(original).
 * This function never modifies the original string or its export representation.
 */
export async function prepareReportPreview(original: string): Promise<string> {
  const purifier = createDOMPurify(window);
  const root = purifier.sanitize(original, { ...REPORT_PREVIEW_POLICY, RETURN_DOM: true });
  if (!(root instanceof HTMLHtmlElement)) throw new Error(t('chat:report.sanitizationFailed'));
  restrictReportPreviewUrls(root);
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let library = '';
  if (root.querySelector('pre.mermaid, div.mermaid, code.language-mermaid')) {
    try { library = await loadReportMermaidRuntime(); } catch { /* Offline source fallback. */ }
  }
  const head = root.querySelector('head')!;
  const body = root.querySelector('body')!;
  const csp = document.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = `default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; manifest-src 'none'; worker-src 'none'; form-action 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; script-src-attr 'none'; font-src data:;`;
  const charset = document.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  head.prepend(csp, charset);
  const appendScript = (source: string) => {
    const script = document.createElement('script');
    script.setAttribute('nonce', nonce);
    script.textContent = scriptText(source);
    body.append(script);
  };
  if (library) {
    appendScript(purifierSource);
    appendScript(library);
  }
  appendScript(`(${installReportPreviewRuntime.toString()})(${library ? 'window.DOMPurify' : 'null'}, ${JSON.stringify(REPORT_PREVIEW_POLICY)}, ${Boolean(library)});`);
  return `<!doctype html>${root.outerHTML}`;
}
