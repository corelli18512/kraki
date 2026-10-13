import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
  const [index, setIndex] = useState(selection.initialIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
        if (next >= 0 && next < selection.items.length) {
          setIndex(next); setZoom(1); setPan({ x: 0, y: 0 });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
  return (
    <div className="kimage-viewer" role="dialog" aria-modal="true" aria-label="Image preview">
      <div className="kimage-toolbar">
        <span className="kimage-title">{item.title}</span>
        {selection.items.length > 1 && <span className="kimage-index">{index + 1} / {selection.items.length}</span>}
        <span className="kimage-spacer" />
        {selection.items.length > 1 && <>
          <button type="button" title="Previous image" aria-label="Previous image" disabled={index === 0} onClick={() => show(index - 1)}><ChevronLeft /></button>
          <button type="button" title="Next image" aria-label="Next image" disabled={index === selection.items.length - 1} onClick={() => show(index + 1)}><ChevronRight /></button>
        </>}
        <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => changeZoom(zoom / 1.25)}><ZoomOut /></button>
        <span className="kimage-zoom">{zoom.toFixed(1)}×</span>
        <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => changeZoom(zoom * 1.25)}><ZoomIn /></button>
        <button type="button" title="Fit to window" aria-label="Fit to window" onClick={() => changeZoom(1)}><Minimize2 /></button>
        <button type="button" title="Close image preview" aria-label="Close image preview" onClick={onClose}><X /></button>
      </div>
      <div ref={canvas} className="kimage-canvas" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
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
