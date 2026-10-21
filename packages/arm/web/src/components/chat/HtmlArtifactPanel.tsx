import { t } from '../../i18n';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import type { ContentRef } from '@kraki/protocol';
import { useAttachmentText } from '../../hooks/useAttachment';
import { withMermaidRuntime } from '../../lib/report-mermaid';
import { prepareReportPreview } from '../../lib/report-preview';
import { desktop } from '../../lib/desktop';
import { formatReportBytes, htmlArtifactTitle } from './Attachments';
import { X, Maximize2, Minimize2, Compass, LoaderCircle, AlertTriangle } from 'lucide-react';
import { RichTextDocumentIcon } from './RichTextDocumentIcon';

const MAX_REPORT_BYTES = 10 * 1024 * 1024;

const ATTACHMENT_PULL = (sessionId: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => wsClient.requestAttachment(sessionId, ref));
};

export function withArtifactCsp(html: string): string {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; object-src \'none\'; frame-src \'none\'; child-src \'none\'; media-src \'none\'; manifest-src \'none\'; worker-src \'none\'; form-action \'none\'; connect-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src data:;">';
  // The policy must precede every report-controlled element, including scripts
  // before <head>. Preserve a leading doctype to avoid switching to quirks mode.
  const body = html.replace(/^\uFEFF/, '');
  const doctype = body.match(/^\s*(<!doctype[^>]*>)/i);
  return doctype ? `${doctype[1]}${csp}${body.slice(doctype[0].length)}` : `${csp}${body}`;
}

/** Browser copies keep the original HTML, with a self-contained Mermaid runtime. */
export async function exportHtmlReport(html: string, name: string): Promise<void> {
  if (desktop?.exportHtmlReport) {
    const result = await desktop.exportHtmlReport(html, name);
    if (!result.ok) throw new Error(result.error || t('chat:report.openFailed'));
    return;
  }
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\.html?$/i, '') || 'Report'}.html`;
  link.click();
  // Keep the object alive until the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function HtmlArtifactPanel({ artifact, sessionId, onClose, expanded = false, onToggleExpanded }: {
  artifact: ContentRef; sessionId: string; onClose: () => void; expanded?: boolean; onToggleExpanded?: () => void;
}) {
  const { t } = useTranslation('chat');
  const title = htmlArtifactTitle(artifact);
  const { status, text, error } = useAttachmentText(artifact, sessionId, ATTACHMENT_PULL, artifact.size <= MAX_REPORT_BYTES);
  const oversized = artifact.size > MAX_REPORT_BYTES || (text !== null && new TextEncoder().encode(text).byteLength > MAX_REPORT_BYTES);
  const [prepared, setPrepared] = useState<{ id: string; sessionId: string; exportHtml: string; url: string } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => {
    setPrepared(null); setRenderError(null); setExportError(null);
    if (status !== 'ready' || text === null || oversized) return;
    let url: string | null = null;
    let cancelled = false;
    // Preview is a constrained document; explicit export keeps the original report.
    void Promise.all([prepareReportPreview(text), withMermaidRuntime(text)]).then(([previewHtml, exportHtml]) => {
      if (cancelled) return;
      url = URL.createObjectURL(new Blob([previewHtml], { type: 'text/html' }));
      setPrepared({ id: artifact.id, sessionId, exportHtml, url });
    }).catch((reason: unknown) => { if (!cancelled) setRenderError(String(reason)); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [artifact.id, sessionId, status, text, oversized]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('.kimage-viewer')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ready = prepared?.id === artifact.id && prepared.sessionId === sessionId ? prepared : null;
  const reason = oversized ? t('report.sizeError') : status === 'error' ? error : renderError;
  const expansionLabel = expanded ? t('report.restore') : t('report.expand');
  return <aside className={`kreport-panel ${expanded ? 'is-expanded' : ''}`} aria-label={t('report.preview')}>
    <div className="kreport-header">
      <RichTextDocumentIcon className="kreport-header-icon" />
      <span className="kreport-header-text"><strong>{title}</strong><small>{t('attachments.reportSize', { size: formatReportBytes(artifact.size) })}</small></span>
      {ready && <button type="button" aria-label={t('report.openBrowser')} title={t('report.openBrowser')} onClick={() => {
        void exportHtmlReport(ready.exportHtml, artifact.name || title).catch((reason: unknown) => setExportError(reason instanceof Error ? reason.message : String(reason)));
      }}><Compass /></button>}
      {onToggleExpanded && <button type="button" className="kreport-expand" onClick={onToggleExpanded} aria-label={expansionLabel} title={expansionLabel}>{expanded ? <Minimize2 /> : <Maximize2 />}</button>}
      <button type="button" onClick={onClose} aria-label={t('report.close')} title={t('report.close')}><X /></button>
    </div>
    {exportError && <p className="kreport-export-error" role="alert">{exportError}</p>}
    {reason ? <div className="kreport-state is-error"><AlertTriangle /><strong>{t('report.loadFailed')}</strong><p>{reason}</p></div>
      : ready ? <iframe title={title} src={ready.url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="kreport-frame" />
        : <div className="kreport-state"><LoaderCircle className="animate-spin" /><p>{t('report.loading')}</p></div>}
  </aside>;
}
