import type { Attachment, ContentRef } from '@kraki/protocol';
import { ChevronLeft, ChevronRight, ExternalLink, FileCode2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useAttachment } from '../../hooks/useAttachment';

/** Content refs are pulled from the owning Tentacle on demand. Lazy import
 *  breaks the ws-client ↔ component cycle. */
const ATTACHMENT_PULL = (sid: string, ref: ContentRef): void => {
  void import('../../lib/ws-client').then(({ wsClient }) => {
    wsClient.requestAttachment(sid, ref);
  });
};

export function HtmlArtifactCards({ artifacts, onOpen }: { artifacts: ContentRef[]; onOpen?: (artifact: ContentRef) => void }) {
  return (
    <div className="mt-2 space-y-1.5" data-html-artifacts={artifacts.length}>
      {artifacts.map((artifact) => {
        const title = artifact.caption || artifact.name || 'HTML report';
        return (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onOpen?.(artifact)}
            className="group flex w-full items-center gap-3 rounded-xl border border-border-primary bg-surface-primary/80 px-3 py-2.5 text-left transition-colors hover:border-kraki-500/40 hover:bg-surface-secondary disabled:cursor-default"
            aria-label={`Open report ${title}`}
            disabled={!onOpen}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-kraki-500/10 text-kraki-500">
              <FileCode2 className="size-4.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-text-primary">{title}</span>
              <span className="mt-0.5 block text-[10px] text-text-muted">HTML Report · {formatBytes(artifact.size)}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-text-muted transition-colors group-hover:text-kraki-500" />
          </button>
        );
      })}
    </div>
  );
}

export function ImageAttachments({ attachments, sessionId }: { attachments?: Attachment[]; sessionId?: string }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [resolvedRefs, setResolvedRefs] = useState<Record<number, string>>({});
  const images = attachments?.filter(
    (a): a is (Attachment & { type: 'image' }) | (Attachment & { type: 'content_ref' }) =>
      a.type === 'image' || (a.type === 'content_ref' && a.mimeType.startsWith('image/')),
  ) ?? [];
  const imageCount = images.length;
  const isGallery = imageCount > 1;
  const visibleImages = images;

  const imageUrl = useCallback((index: number): string | undefined => {
    const image = images[index];
    if (!image) return undefined;
    return image.type === 'image'
      ? `data:${image.mimeType};base64,${image.data}`
      : resolvedRefs[index];
  }, [images, resolvedRefs]);

  const moveExpanded = useCallback((delta: number) => {
    setExpandedIndex((current) => current === null ? null : (current + delta + imageCount) % imageCount);
  }, [imageCount]);

  useEffect(() => {
    if (expandedIndex === null) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpandedIndex(null);
      if (event.key === 'ArrowLeft' && imageCount > 1) moveExpanded(-1);
      if (event.key === 'ArrowRight' && imageCount > 1) moveExpanded(1);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expandedIndex, imageCount, moveExpanded]);

  if (!imageCount) return null;

  const galleryClass = imageCount === 2
    ? 'grid grid-cols-2 gap-1.5 aspect-[2/1]'
    : imageCount === 3
      ? 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-[4/3]'
      : 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-square';
  const expanded = expandedIndex === null ? undefined : images[expandedIndex];
  const expandedUrl = expandedIndex === null ? undefined : imageUrl(expandedIndex);

  return (
    <>
      <div
        className={isGallery ? `mt-2 w-full max-w-[640px] overflow-hidden rounded-xl ${galleryClass}` : 'mt-2 max-w-[640px]'}
        data-image-gallery={imageCount}
      >
        {visibleImages.map((img, i) => (
          <div key={img.type === 'content_ref' ? img.id : `${img.mimeType}:${img.data.slice(0, 32)}`} className={`relative min-h-0 min-w-0 ${i >= 4 ? 'hidden' : ''} ${imageCount === 3 && i === 0 ? 'row-span-2' : ''}`}>
            <AttachmentTile
              attachment={img}
              sessionId={sessionId}
              gallery={isGallery}
              onReady={(url) => setResolvedRefs((current) => current[i] === url ? current : { ...current, [i]: url })}
              onExpand={() => setExpandedIndex(i)}
            />
            {imageCount > 4 && i === 3 && (
              <button
                type="button"
                aria-label={`Show ${imageCount - 4} more images`}
                className="absolute inset-0 flex items-center justify-center bg-black/55 text-2xl font-semibold text-white backdrop-blur-[1px]"
                onClick={() => setExpandedIndex(i)}
              >
                +{imageCount - 4}
              </button>
            )}
          </div>
        ))}
      </div>
      {expandedIndex !== null && expanded && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setExpandedIndex(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Image gallery"
        >
          <button
            type="button"
            aria-label="Close gallery"
            className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white hover:bg-black/70"
            onClick={() => setExpandedIndex(null)}
          >
            <X className="h-6 w-6" />
          </button>
          {imageCount > 1 && (
            <button
              type="button"
              aria-label="Previous image"
              className="absolute left-3 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 sm:left-6"
              onClick={(event) => { event.stopPropagation(); moveExpanded(-1); }}
            >
              <ChevronLeft className="h-7 w-7" />
            </button>
          )}
          <div className="flex max-h-[94vh] max-w-[90vw] flex-col items-center gap-3" onClick={(event) => event.stopPropagation()}>
            {expandedUrl ? (
              <img src={expandedUrl} alt={expanded.caption ?? expanded.name ?? 'Full size'} className="max-h-[82vh] max-w-[90vw] rounded-lg object-contain" />
            ) : (
              <div className="flex h-48 w-72 items-center justify-center rounded-lg bg-white/10 text-sm text-white/70">Loading image…</div>
            )}
            <div className="text-center text-sm text-white/80">
              {expanded.caption && <div>{expanded.caption}</div>}
              {imageCount > 1 && <div className="mt-1 text-xs text-white/60">{expandedIndex + 1} / {imageCount}</div>}
            </div>
          </div>
          {imageCount > 1 && (
            <button
              type="button"
              aria-label="Next image"
              className="absolute right-3 rounded-full bg-black/50 p-2 text-white hover:bg-black/70 sm:right-6"
              onClick={(event) => { event.stopPropagation(); moveExpanded(1); }}
            >
              <ChevronRight className="h-7 w-7" />
            </button>
          )}
        </div>
      )}
    </>
  );
}

function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>): void {
  const scrollable = (e.target as HTMLElement).closest('[data-chat-scroll]');
  if (scrollable) {
    const { scrollTop, scrollHeight, clientHeight } = scrollable;
    if (scrollHeight - scrollTop - clientHeight < 80) {
      scrollable.scrollTop = scrollHeight;
    }
  }
}

function AttachmentTile({
  attachment,
  sessionId,
  gallery,
  onReady,
  onExpand,
}: {
  attachment: Attachment & ({ type: 'image' } | { type: 'content_ref' });
  sessionId?: string;
  gallery: boolean;
  onReady: (url: string) => void;
  onExpand: () => void;
}) {
  if (attachment.type === 'image') {
    const src = `data:${attachment.mimeType};base64,${attachment.data}`;
    return (
      <figure className={gallery ? 'm-0 h-full w-full' : 'm-0 flex flex-col items-start gap-1'}>
        <button
          type="button"
          aria-label={`Open ${attachment.caption ?? attachment.name ?? 'image'}`}
          className={gallery ? 'h-full w-full overflow-hidden bg-surface-secondary' : 'overflow-hidden rounded-lg border border-border-primary/20'}
          onClick={onExpand}
        >
          <img
            src={src}
            alt={attachment.caption ?? attachment.name ?? 'Attachment'}
            className={gallery ? 'h-full w-full object-cover' : 'max-h-72 max-w-full object-contain'}
            onLoad={(event) => { onReady(src); onImageLoad(event); }}
          />
        </button>
        {!gallery && attachment.caption && (
          <figcaption className="text-xs italic text-text-secondary">{attachment.caption}</figcaption>
        )}
      </figure>
    );
  }

  if (!sessionId) {
    return <RefImagePlaceholder ref_={attachment} gallery={gallery} />;
  }
  return <RefImageTile ref_={attachment} sessionId={sessionId} gallery={gallery} onReady={onReady} onExpand={onExpand} />;
}

function RefImagePlaceholder({ ref_, gallery }: { ref_: Attachment & { type: 'content_ref' }; gallery: boolean }) {
  return (
    <figure className={gallery ? 'm-0 h-full w-full' : 'm-0 flex flex-col items-start gap-1'}>
      <div
        className={`flex flex-col items-center justify-center border border-border-primary/20 bg-surface-secondary/50 text-text-secondary ${gallery ? 'h-full w-full' : 'rounded-lg'}`}
        style={gallery ? undefined : {
          width: ref_.width ? Math.min(ref_.width, 320) : 320,
          height: ref_.height ? Math.min(ref_.height, 180) : 180,
        }}
      >
        <div className="text-xs">🖼 {ref_.name ?? 'image'}</div>
        <div className="text-[10px] opacity-60">{formatBytes(ref_.size)}</div>
      </div>
      {!gallery && ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
    </figure>
  );
}

function RefImageTile({
  ref_,
  sessionId,
  gallery,
  onReady,
  onExpand,
}: {
  ref_: Attachment & { type: 'content_ref' };
  sessionId: string;
  gallery: boolean;
  onReady: (url: string) => void;
  onExpand: () => void;
}) {
  const { status, url, error } = useAttachment(ref_, sessionId, ATTACHMENT_PULL);

  useEffect(() => {
    if (status === 'ready' && url) onReady(url);
  }, [status, url, onReady]);

  const placeholderStyle: React.CSSProperties | undefined = gallery ? undefined : {
    width: ref_.width ? Math.min(ref_.width, 320) : 320,
    height: ref_.height ? Math.min(ref_.height, 180) : 180,
  };

  if (status === 'ready' && url) {
    return (
      <figure className={gallery ? 'm-0 h-full w-full' : 'm-0 flex flex-col items-start gap-1'}>
        <button
          type="button"
          aria-label={`Open ${ref_.caption ?? ref_.name ?? 'image'}`}
          className={gallery ? 'h-full w-full overflow-hidden bg-surface-secondary' : 'overflow-hidden rounded-lg border border-border-primary/20'}
          onClick={onExpand}
        >
          <img
            src={url}
            alt={ref_.caption ?? ref_.name ?? 'Attachment'}
            className={gallery ? 'h-full w-full object-cover' : 'max-h-72 max-w-full object-contain'}
            onLoad={onImageLoad}
          />
        </button>
        {!gallery && ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
      </figure>
    );
  }
  if (status === 'error') {
    return (
      <figure className={gallery ? 'm-0 h-full w-full' : 'm-0 flex flex-col items-start gap-1'}>
        <div
          className={`flex flex-col items-center justify-center border border-red-500/40 bg-red-500/10 text-text-secondary ${gallery ? 'h-full w-full' : 'rounded-lg'}`}
          style={placeholderStyle}
        >
          <div className="text-xs">⚠ Couldn't load image</div>
          <div className="text-[10px] opacity-60">{ref_.name ?? 'image'}</div>
          {error && <div className="text-[10px] opacity-60">{error}</div>}
        </div>
        {!gallery && ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
      </figure>
    );
  }
  return (
    <figure className={gallery ? 'm-0 h-full w-full' : 'm-0 flex flex-col items-start gap-1'}>
      <div
        className={`flex flex-col items-center justify-center gap-2 border border-border-primary/20 bg-surface-secondary/50 text-text-secondary ${gallery ? 'h-full w-full' : 'rounded-lg'}`}
        style={placeholderStyle}
      >
        <span
          className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-text-secondary/40 border-t-text-secondary"
          aria-label="Loading"
        />
        <div className="text-[10px] opacity-60">{ref_.name ?? 'image'} · {formatBytes(ref_.size)}</div>
      </div>
      {!gallery && ref_.caption && <figcaption className="text-xs italic text-text-secondary">{ref_.caption}</figcaption>}
    </figure>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
