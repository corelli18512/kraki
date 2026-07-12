import { useEffect, useRef, useState } from 'react';
import type { ContentRef } from '@kraki/protocol';
import { useAttachmentText } from '../../hooks/useAttachment';
import { X, Maximize2, FileCode2, LoaderCircle, AlertTriangle } from 'lucide-react';

const ATTACHMENT_PULL = (sessionId: string, id: string): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => {
    wsClient.requestAttachment(sessionId, id);
  });
};

function withArtifactCsp(html: string): string {
  const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; object-src \'none\'; frame-src \'none\'; form-action \'none\'; connect-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; font-src data:;">';
  const cspPattern = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi;
  if (cspPattern.test(html)) return html.replace(cspPattern, csp);
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${csp}`);
  return `${csp}${html}`;
}

function ArtifactFrame({ artifact, sessionId }: { artifact: ContentRef; sessionId: string }) {
  const { status, text, error } = useAttachmentText(artifact, sessionId, ATTACHMENT_PULL);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'ready' || text === null) {
      setUrl(null);
      return undefined;
    }
    const blobUrl = URL.createObjectURL(new Blob([withArtifactCsp(text)], { type: 'text/html' }));
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [artifact.id, status, text]);

  if (status === 'error') {
    return <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-text-secondary"><AlertTriangle className="mb-2 size-5 text-amber-500" /><p>Could not load this report.<br /><span className="text-[10px] text-text-muted">{error}</span></p></div>;
  }
  if (!url) {
    return <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-secondary"><LoaderCircle className="size-4 animate-spin" />Loading report…</div>;
  }
  return <iframe title={artifact.caption || artifact.name || 'HTML report'} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0 bg-white" />;
}

export function HtmlArtifactPanel({ artifact, sessionId, onClose }: { artifact: ContentRef; sessionId: string; onClose: () => void }) {
  const title = artifact.caption || artifact.name || 'HTML report';
  const panelRef = useRef<HTMLElement>(null);
  return (
    <aside ref={panelRef} className="fixed inset-0 z-40 flex flex-col bg-surface-primary md:static md:h-full md:w-[min(48vw,680px)] md:shrink-0 md:border-l md:border-border-primary md:shadow-none fullscreen:h-screen fullscreen:w-screen fullscreen:max-w-none fullscreen:border-0" aria-label="HTML report preview">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-primary px-3">
        <FileCode2 className="size-4 shrink-0 text-kraki-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-text-primary">{title}</span>
        <button type="button" onClick={() => panelRef.current?.requestFullscreen?.()} className="rounded-md p-1.5 text-text-muted hover:bg-surface-tertiary hover:text-text-primary" aria-label="Fullscreen report" title="Fullscreen">
          <Maximize2 className="size-4" />
        </button>
        <button type="button" onClick={onClose} className="rounded-md p-1.5 text-text-muted hover:bg-surface-tertiary hover:text-text-primary" aria-label="Close report preview" title="Close">
          <X className="size-4" />
        </button>
      </div>
      <ArtifactFrame artifact={artifact} sessionId={sessionId} />
    </aside>
  );
}
