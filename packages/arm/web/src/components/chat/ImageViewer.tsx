import { formatNumber } from '../../i18n/format';
import { useTranslation } from 'react-i18next';
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Minimize2, X, ZoomIn, ZoomOut } from 'lucide-react';

export interface ImagePreviewItem { url: string; title: string; blob?: Blob }
export interface ImagePreviewSelection { items: ImagePreviewItem[]; initialIndex: number }
const ImagePreviewContext = createContext<((selection: ImagePreviewSelection) => void) | undefined>(undefined);
export const useOpenImagePreview = () => useContext(ImagePreviewContext);

/** Owned by the chat pane, outside the scrolling/virtualized message list. */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<ImagePreviewSelection | null>(null);
  const open = useCallback((next: ImagePreviewSelection) => {
    // Own ref-image URLs while open, even if virtualized source tiles unmount.
    setSelection({ ...next, items: next.items.map((item) => item.blob ? { ...item, url: URL.createObjectURL(item.blob) } : item) });
  }, []);
  useEffect(() => () => {
    selection?.items.forEach((item) => { if (item.blob) URL.revokeObjectURL(item.url); });
  }, [selection]);
  return <ImagePreviewContext.Provider value={open}>{children}{selection && <ImageViewer selection={selection} onClose={() => setSelection(null)} />}</ImagePreviewContext.Provider>;
}

export function ImageViewer({ selection, onClose }: { selection: ImagePreviewSelection; onClose: () => void }) {
  const { t } = useTranslation('chat');
  const [index, setIndex] = useState(selection.initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  const modalKeys = useRef(new Set<string>());
  const dismissed = useRef(false);
  const dismiss = () => { dismissed.current = true; onClose(); };
  const canvas = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const item = selection.items[index];
  const clampZoom = (value: number) => Math.min(8, Math.max(1, value));
  const clampPan = (x: number, y: number, scale = zoom) => {
    const c = canvas.current;
    const i = image.current;
    const maxX = c && i ? Math.max(0, (i.clientWidth * scale - c.clientWidth) / 2) : 0;
    const maxY = c && i ? Math.max(0, (i.clientHeight * scale - c.clientHeight) / 2) : 0;
    return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
  };
  const changeZoom = (value: number) => {
    const next = clampZoom(value);
    setZoom(next);
    setPan((current) => next === 1 ? { x: 0, y: 0 } : clampPan(current.x, current.y, next));
  };
  const show = (next: number) => {
    if (next < 0 || next >= selection.items.length) return;
    setIndex(next); setZoom(1); setPan({ x: 0, y: 0 });
  };
  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    // StrictMode replays layout setup after focus has already moved into the
    // dialog. Capture once per viewer, not once per setup, to retain the opener.
    if (opener.current === undefined) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Isolate the modal without introducing a layout wrapper around the chat/report panes.
    const background = new Map<HTMLElement, string | null>();
    for (let branch: HTMLElement = el; branch.parentElement; branch = branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          background.set(sibling, sibling.getAttribute('inert'));
          sibling.setAttribute('inert', '');
        }
      }
      if (branch.parentElement === document.body) break;
    }
    el.focus({ preventScroll: true });
    const contain = (event: FocusEvent) => {
      if (event.target instanceof Node && !el.contains(event.target)) el.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', contain);
    return () => {
      document.removeEventListener('focusin', contain);
      background.forEach((value, node) => {
        if (value === null) node.removeAttribute('inert'); else node.setAttribute('inert', value);
      });
      // A session unmount is not a dismissal: its opener may still be connected
      // during layout cleanup, but must not regain focus in the departing pane.
      if (dismissed.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = dialog.current;
      if (!el) return;
      // Repeats can belong to a key held before the viewer opened.
      if (!event.repeat && event.target instanceof Node && el.contains(event.target)) modalKeys.current.add(event.code || event.key);
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); dismiss();
        return;
      }
      if (!(event.target instanceof Node) || !el.contains(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation();
        el.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') {
        const controls = [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          event.preventDefault(); last?.focus({ preventScroll: true });
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === el)) {
          event.preventDefault(); first?.focus({ preventScroll: true });
        }
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); event.stopImmediatePropagation();
        const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
        if (next >= 0 && next < selection.items.length) {
          setIndex(next); setZoom(1); setPan({ x: 0, y: 0 });
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [index, selection.items.length, onClose]);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const observer = new ResizeObserver(() => setPan((current) => clampPan(current.x, current.y)));
    observer.observe(c);
    return () => observer.disconnect();
    // Clamp again when zoom changes as well as when the pane is resized.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);
  // Keys started in the modal stay isolated; releases of preexisting held
  // shortcuts (e.g. Usage peek) still reach window cleanup as native events.
  return (
    <div ref={dialog} tabIndex={-1} className="kimage-viewer" role="dialog" aria-modal="true" aria-label={t('imageViewer.preview')}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => { if (modalKeys.current.delete(event.code || event.key)) event.stopPropagation(); }}>
      <div className="kimage-toolbar">
        <span className="kimage-title">{item.title}</span>
        {selection.items.length > 1 && <span className="kimage-index">{formatNumber(index + 1, { useGrouping: false })} / {formatNumber(selection.items.length, { useGrouping: false })}</span>}
        <span className="kimage-spacer" />
        {selection.items.length > 1 && <>
          <button type="button" title={t('imageViewer.previous')} aria-label={t('imageViewer.previous')} disabled={index === 0} onClick={() => show(index - 1)}><ChevronLeft /></button>
          <button type="button" title={t('imageViewer.next')} aria-label={t('imageViewer.next')} disabled={index === selection.items.length - 1} onClick={() => show(index + 1)}><ChevronRight /></button>
        </>}
        <button type="button" title={t('imageViewer.zoomOut')} aria-label={t('imageViewer.zoomOut')} onClick={() => changeZoom(zoom / 1.25)}><ZoomOut /></button>
        <span className="kimage-zoom">{formatNumber(zoom, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}×</span>
        <button type="button" title={t('imageViewer.zoomIn')} aria-label={t('imageViewer.zoomIn')} onClick={() => changeZoom(zoom * 1.25)}><ZoomIn /></button>
        <button type="button" title={t('imageViewer.fit')} aria-label={t('imageViewer.fit')} onClick={() => changeZoom(1)}><Minimize2 /></button>
        <button type="button" title={t('imageViewer.close')} aria-label={t('imageViewer.close')} onClick={dismiss}><X /></button>
      </div>
      <div ref={canvas} className="kimage-canvas" onClick={(event) => { if (event.target === event.currentTarget) dismiss(); }}
        onWheel={(event) => {
          if (event.ctrlKey || event.altKey || event.deltaMode !== 0) changeZoom(zoom * Math.pow(1.12, Math.max(-4, Math.min(4, -event.deltaY))));
          else if (zoom > 1) setPan((current) => clampPan(current.x - event.deltaX, current.y - event.deltaY));
        }}>
        <img ref={image} src={item.url} alt={item.title} draggable={false}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'default' }}
          onDoubleClick={() => changeZoom(zoom > 1 ? 1 : 2)}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          }}
          onPointerMove={(event) => {
            if (!drag.current || zoom <= 1) return;
            setPan(clampPan(drag.current.panX + event.clientX - drag.current.x, drag.current.panY + event.clientY - drag.current.y));
          }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
      </div>
    </div>
  );
}
