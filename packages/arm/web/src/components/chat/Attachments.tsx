import type { Attachment, ContentRef } from '@kraki/protocol';
import { AlertTriangle, ArrowUpRight, FileText } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { useAttachment } from '../../hooks/useAttachment';
import { getState } from '../../lib/attachments';
import { useOpenImagePreview } from './ImageViewer';

const ATTACHMENT_PULL = (sid: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => wsClient.requestAttachment(sid, ref));
};

/** File-style decimal units, as in the native report card/header. */
export function formatReportBytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export function htmlArtifactTitle(artifact: ContentRef): string {
  return artifact.caption?.trim() || artifact.name?.trim() || 'Report';
}

export function HtmlArtifactCards({ artifacts, onOpen }: { artifacts: ContentRef[]; onOpen?: (artifact: ContentRef) => void }) {
  return (
    <div className="kreport-cards" data-html-artifacts={artifacts.length}>
      {artifacts.map((artifact) => {
        const title = htmlArtifactTitle(artifact);
        return <button key={artifact.id} type="button" className="kreport-card" onClick={() => onOpen?.(artifact)} aria-label={`Open report ${title}`} disabled={!onOpen}>
          <span className="kreport-card-icon"><FileText /></span>
          <span className="kreport-card-text"><strong>{title}</strong><small>Report · {formatReportBytes(artifact.size)}</small></span>
          <ArrowUpRight className="kreport-card-chevron" />
        </button>;
      })}
    </div>
  );
}

type ImageAttachment = Attachment & ({ type: 'image' } | { type: 'content_ref' });
export function ImageAttachments({ attachments, sessionId }: { attachments?: Attachment[]; sessionId?: string }) {
  const openPreview = useOpenImagePreview();
  const [resolvedRefs, setResolvedRefs] = useState<Record<string, string>>({});
  const images = attachments?.filter((a): a is ImageAttachment => a.type === 'image' || (a.type === 'content_ref' && a.mimeType.startsWith('image/'))) ?? [];
  if (!images.length) return null;
  const gallery = images.length > 1;
  const depth = Math.min(3, images.length);
  const offset = (depth - 1) * 8;
  const open = (index: number) => {
    const resolved = images.flatMap((attachment, i) => {
      const url = attachment.type === 'image' ? `data:${attachment.mimeType};base64,${attachment.data}` : resolvedRefs[attachment.id];
      const state = attachment.type === 'content_ref' ? getState(attachment.id) : undefined;
      return url ? [{ url, blob: state?.kind === 'ready' ? state.blob : undefined, title: attachment.type === 'image' ? `Image ${i + 1}` : attachment.caption ?? attachment.name ?? 'Image', originalIndex: i }] : [];
    });
    if (resolved.length) openPreview?.({ items: resolved, initialIndex: Math.max(0, resolved.findIndex((item) => item.originalIndex === index)) });
  };
  return <div className={gallery ? 'kimage-stack' : 'kimage-single'} data-image-gallery={images.length} style={gallery ? { '--image-stack-offset': `${offset}px`, height: 184 + offset } as CSSProperties : undefined}>
    {images.map((attachment, i) => <div key={attachment.type === 'content_ref' ? attachment.id : i} className={gallery ? 'kimage-stack-card' : undefined}
      style={gallery ? { left: i * 8, top: (depth - 1 - i) * 8, zIndex: depth - i, display: i >= depth ? 'none' : undefined } : undefined}>
      <AttachmentTile attachment={attachment} sessionId={sessionId} gallery={gallery} onReady={(url) => {
        if (attachment.type === 'content_ref') setResolvedRefs((current) => current[attachment.id] === url ? current : { ...current, [attachment.id]: url });
      }} onExpand={() => open(i)} />
    </div>)}
    {gallery && <span className="kimage-count" style={{ top: offset + 9, zIndex: depth + 1 }}>{images.length}</span>}
  </div>;
}

export function refImageSize(ref: ContentRef): CSSProperties {
  const hasSize = !!ref.width && ref.width > 0 && !!ref.height && ref.height > 0;
  const width = hasSize ? ref.width! : 192;
  const height = hasSize ? ref.height! : 192;
  const ratio = Math.min(1, 360 / width, 192 / height);
  return { width: width * ratio, height: height * ratio, maxWidth: '100%', aspectRatio: `${width} / ${height}` };
}

function onImageLoad(event: React.SyntheticEvent<HTMLImageElement>): void {
  const scrollable = event.currentTarget.closest('[data-chat-scroll]');
  if (scrollable && scrollable.scrollHeight - scrollable.scrollTop - scrollable.clientHeight < 80) scrollable.scrollTop = scrollable.scrollHeight;
}

function AttachmentTile({ attachment, sessionId, gallery, onReady, onExpand }: {
  attachment: ImageAttachment; sessionId?: string; gallery: boolean; onReady: (url: string) => void; onExpand: () => void;
}) {
  if (attachment.type === 'content_ref') {
    return sessionId ? <RefImageTile ref_={attachment} sessionId={sessionId} gallery={gallery} onReady={onReady} onExpand={onExpand} /> : <div className="kimage-placeholder" style={gallery ? undefined : refImageSize(attachment)}><span className="kspinner" aria-label="Loading" /></div>;
  }
  const src = `data:${attachment.mimeType};base64,${attachment.data}`;
  return <button type="button" aria-label={gallery ? 'Open image gallery' : 'Open image preview'} className={`kimage-tile ${gallery ? 'is-gallery' : 'is-binary'}`} onClick={onExpand}>
    <img src={src} alt={attachment.caption ?? attachment.name ?? 'Attachment'} onLoad={onImageLoad} />
  </button>;
}

function RefImageTile({ ref_, sessionId, gallery, onReady, onExpand }: {
  ref_: ContentRef; sessionId: string; gallery: boolean; onReady: (url: string) => void; onExpand: () => void;
}) {
  const { status, url, error, retry } = useAttachment(ref_, sessionId, ATTACHMENT_PULL);
  const [invalidUrl, setInvalidUrl] = useState<string | null>(null);
  const style = gallery ? undefined : refImageSize(ref_);
  if (status === 'error' || (url && invalidUrl === url)) return <button type="button" className={`kimage-placeholder is-error ${gallery ? 'is-gallery' : ''}`} style={style} onClick={() => { setInvalidUrl(null); retry(); }}>
    <AlertTriangle /><span>{error || 'Invalid image'}</span><small>Click to retry</small>
  </button>;
  if (status === 'ready' && url) return <button type="button" aria-label={gallery ? 'Open image gallery' : 'Open image preview'} className={`kimage-tile ${gallery ? 'is-gallery' : 'is-ref'}`} style={style} onClick={onExpand}>
    <img src={url} alt={ref_.caption ?? ref_.name ?? 'Attachment'} onLoad={(event) => { onReady(url); onImageLoad(event); }} onError={() => setInvalidUrl(url)} />
  </button>;
  return <div className={`kimage-placeholder ${gallery ? 'is-gallery' : ''}`} style={style}><span className="kspinner" aria-label="Loading" /></div>;
}
