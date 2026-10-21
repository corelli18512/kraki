import { t } from '../../i18n';
import { formatNumber } from '../../i18n/format';
import { useTranslation } from 'react-i18next';
import type { Attachment, ContentRef } from '@kraki/protocol';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { RichTextDocumentIcon } from './RichTextDocumentIcon';
import { useState, type CSSProperties } from 'react';
import { useAttachment } from '../../hooks/useAttachment';
import { getState } from '../../lib/attachments';
import { useOpenImagePreview } from './ImageViewer';

const ATTACHMENT_PULL = (sid: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => wsClient.requestAttachment(sid, ref));
};

/** File-style decimal units, as in the native report card/header. */
export function formatReportBytes(n: number): string {
  if (n < 1000) return t('chat:attachments.bytes', { count: n });
  if (n < 1_000_000) return t('chat:attachments.kilobytes', { size: formatNumber(Math.round(n / 1000), { useGrouping: false }) });
  return t('chat:attachments.megabytes', { size: formatNumber(n / 1_000_000, { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
}

export function htmlArtifactTitle(artifact: ContentRef): string {
  return artifact.caption?.trim() || artifact.name?.trim() || t('chat:attachments.report');
}

export function HtmlArtifactCards({ artifacts, onOpen }: { artifacts: ContentRef[]; onOpen?: (artifact: ContentRef) => void }) {
  const { t } = useTranslation('chat');
  return (
    <div className="kreport-cards" data-html-artifacts={artifacts.length}>
      {artifacts.map((artifact) => {
        const title = htmlArtifactTitle(artifact);
        return <button key={artifact.id} type="button" className="kreport-card" onClick={() => onOpen?.(artifact)} aria-label={t('attachments.openReport', { title })} disabled={!onOpen}>
          <span className="kreport-card-icon"><RichTextDocumentIcon /></span>
          <span className="kreport-card-text"><strong>{title}</strong><small>{t('attachments.reportSize', { size: formatReportBytes(artifact.size) })}</small></span>
          <ArrowUpRight className="kreport-card-chevron" />
        </button>;
      })}
    </div>
  );
}

type ImageAttachment = Attachment & ({ type: 'image' } | { type: 'content_ref' });
export function ImageAttachments({ attachments, sessionId }: { attachments?: Attachment[]; sessionId?: string }) {
  const { t } = useTranslation('chat');
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
      return url ? [{ url, blob: state?.kind === 'ready' ? state.blob : undefined, title: attachment.type === 'image' ? t('attachments.numberedImage', { number: formatNumber(i + 1) }) : attachment.caption ?? attachment.name ?? t('attachments.image'), originalIndex: i }] : [];
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
  const { t } = useTranslation('chat');
  if (attachment.type === 'content_ref') {
    return sessionId ? <RefImageTile ref_={attachment} sessionId={sessionId} gallery={gallery} onReady={onReady} onExpand={onExpand} /> : <div className="kimage-placeholder" style={gallery ? undefined : refImageSize(attachment)}><span className="kspinner" aria-label={t('attachments.loading')} /></div>;
  }
  const src = `data:${attachment.mimeType};base64,${attachment.data}`;
  return <button type="button" aria-label={gallery ? t('attachments.openGallery') : t('attachments.openPreview')} className={`kimage-tile ${gallery ? 'is-gallery' : 'is-binary'}`} onClick={onExpand}>
    <img src={src} alt={attachment.caption ?? attachment.name ?? t('attachments.attachment')} onLoad={onImageLoad} />
  </button>;
}

function RefImageTile({ ref_, sessionId, gallery, onReady, onExpand }: {
  ref_: ContentRef; sessionId: string; gallery: boolean; onReady: (url: string) => void; onExpand: () => void;
}) {
  const { t } = useTranslation('chat');
  const { status, url, error, retry } = useAttachment(ref_, sessionId, ATTACHMENT_PULL);
  const [invalidUrl, setInvalidUrl] = useState<string | null>(null);
  const style = gallery ? undefined : refImageSize(ref_);
  if (status === 'error' || (url && invalidUrl === url)) return <button type="button" className={`kimage-placeholder is-error ${gallery ? 'is-gallery' : ''}`} style={style} onClick={() => { setInvalidUrl(null); retry(); }}>
    <AlertTriangle /><span>{error || t('attachments.invalidImage')}</span><small>{t('attachments.retry')}</small>
  </button>;
  if (status === 'ready' && url) return <button type="button" aria-label={gallery ? t('attachments.openGallery') : t('attachments.openPreview')} className={`kimage-tile ${gallery ? 'is-gallery' : 'is-ref'}`} style={style} onClick={onExpand}>
    <img src={url} alt={ref_.caption ?? ref_.name ?? t('attachments.attachment')} onLoad={(event) => { onReady(url); onImageLoad(event); }} onError={() => setInvalidUrl(url)} />
  </button>;
  return <div className={`kimage-placeholder ${gallery ? 'is-gallery' : ''}`} style={style}><span className="kspinner" aria-label={t('attachments.loading')} /></div>;
}
