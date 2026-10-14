import { useLayoutEffect, useRef, useState } from 'react';

const SPACING = 6;
const ROW_SPACING = 2;
const TEXT_HEIGHT = 12;

/** SessionMetadataLayout's measured desktop wrap threshold (native points). */
export function metadataNeedsSecondRow(width: number, device: number, model: number, effort: number): boolean {
  return device > 0 && model > 0 && device + 1 + Math.min(model, 40) + effort + SPACING * (effort > 0 ? 3 : 2) > width;
}

export function sessionMetadataFrames(width: number, device: number, model: number, effort: number) {
  const stacked = metadataNeedsSecondRow(width, device, model, effort);
  const x = device > 0 && model > 0 && !stacked ? Math.min(width, device) + 1 + SPACING * 2 : 0;
  const y = stacked ? TEXT_HEIGHT + ROW_SPACING : 0;
  const separateEffort = effort > 0 && effort + SPACING + Math.min(model, 16) > width - x;
  const modelWidth = Math.max(0, Math.min(model, width - x - (effort > 0 && !separateEffort ? effort + SPACING : 0)));
  const frames = {
    device: { left: 0, top: 0, width: Math.min(width, device) },
    separator: { left: Math.min(width, device) + SPACING, top: 1.5, width: 1 },
    model: { left: x, top: y, width: modelWidth },
    effort: { left: separateEffort ? 0 : x + modelWidth + SPACING, top: separateEffort ? y + TEXT_HEIGHT + ROW_SPACING : y, width: Math.min(width, effort) },
  };
  const height = Math.max(15, device > 0 ? TEXT_HEIGHT : 0, model > 0 ? y + TEXT_HEIGHT : 0, effort > 0 ? frames.effort.top + TEXT_HEIGHT : 0);
  // The wide card gives a one-line metadata row at least 15pt, centered.
  if (!stacked && !separateEffort) {
    const inset = (height - TEXT_HEIGHT) / 2;
    frames.device.top += inset;
    frames.model.top += inset;
    frames.effort.top += inset;
    frames.separator.top += inset;
  }
  return { frames, height, showSeparator: device > 0 && model > 0 && !stacked };
}

/** Text uses the rendered font, so model truncation never steals device/effort space. */
export function SessionCardMetadata({ machine, model, effort }: { machine?: string; model?: string; effort?: string }) {
  const root = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<ReturnType<typeof sessionMetadataFrames>>();
  const effortText = model && effort ? `· ${effort}` : '';
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      if (!element.isConnected) return;
      const width = element.getBoundingClientRect().width;
      if (!width) return;
      const context = document.createElement('canvas').getContext('2d');
      if (!context) return;
      context.font = getComputedStyle(element).font;
      setLayout(sessionMetadataFrames(width, context.measureText(machine ?? '').width, context.measureText(model ?? '').width, context.measureText(effortText).width));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [machine, model, effortText]);
  const style = (name: keyof ReturnType<typeof sessionMetadataFrames>['frames']) => layout ? { position: 'absolute' as const, ...layout.frames[name] } : undefined;
  return <span ref={root} className={`ksr-line2 ksr-metadata ${layout ? 'is-measured' : ''}`} style={layout ? { height: layout.height } : undefined}>
    {machine && <span className="ksr-machine" style={style('device')}>{machine}</span>}
    {machine && model && (!layout || layout.showSeparator) && <span className="ksr-sep" style={style('separator')} />}
    {model && <span className="ksr-model" style={style('model')}>{model}</span>}
    {effortText && <span className="ksr-effort" style={style('effort')}>{effortText}</span>}
  </span>;
}
