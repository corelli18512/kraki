import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronLeft } from 'lucide-react';
import { hasWindowsTitleBar } from '../../lib/desktop';

export type SessionMode = import('@kraki/protocol').SessionMode;

export const MODES: { id: SessionMode; label: string; color: string; hint: string }[] = [
  { id: 'safe', label: 'Safe', color: '#34d399', hint: 'Ask before changes and commands' },
  { id: 'auto', label: 'Auto', color: '#fbbf24', hint: 'Run tools without asking' },
  { id: 'delegate', label: 'Delegate', color: '#f4836e', hint: 'Run everything, answer on its own' },
];

/** Header height reserved over the list (the list scrolls under it). */
export const HEADER_HEIGHT = { wide: 56, narrow: 64 };

export function ChatHeader({
  title, mode, narrow, onBack, onTitle, onMode, backBadge,
}: {
  title: string;
  mode: SessionMode;
  narrow: boolean;
  onBack?: () => void;
  onTitle?: () => void;
  onMode: (mode: SessionMode) => void;
  backBadge?: number;
}) {
  const [menu, setMenu] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [interaction, setInteraction] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState({ left: 0, top: 0 });
  const containsModeTarget = (target: Node | null) => !!target
    && (!!menuRef.current?.contains(target) || !!popupRef.current?.contains(target));
  const current = MODES.find((m) => m.id === mode) ?? MODES[1];
  const popupHost = hasWindowsTitleBar && menu
    ? menuRef.current?.closest<HTMLElement>('.app-viewport') ?? document.body
    : null;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!containsModeTarget(e.target as Node)) setMenu(false); };
    if (hasWindowsTitleBar) popupRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false);
        if (hasWindowsTitleBar) triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);

  useLayoutEffect(() => {
    if (!popupHost) return;
    const position = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      // The transformed app is the fixed popup's containing block. Standalone
      // headers fall back to body, where fixed coordinates remain viewport-relative.
      const origin = popupHost === document.body ? null : popupHost.getBoundingClientRect();
      if (rect) setMenuAnchor({ left: rect.left - (origin?.left ?? 0), top: rect.bottom + 6 - (origin?.top ?? 0) });
    };
    position();
    // WCO geometry can change without a viewport resize (e.g. maximize/DPI).
    const observer = new ResizeObserver(position);
    const header = menuRef.current?.parentElement;
    if (header) observer.observe(header);
    const titleButton = header?.querySelector('.khead-title');
    if (titleButton) observer.observe(titleButton);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [popupHost]);

  const dropdown = menu && (narrow || hasWindowsTitleBar) && (
    <div className="khead-menu" role="menu" aria-label="Session mode picker">
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitemradio"
          aria-checked={m.id === mode}
          onClick={() => {
            setMenu(false);
            if (m.id !== mode) onMode(m.id);
            if (hasWindowsTitleBar) triggerRef.current?.focus();
          }}
        >
          <span className="khead-dot" style={{ background: m.color }} />
          <span className="khead-menu-text">
            <span>{m.label}</span>
            <small>{m.hint}</small>
          </span>
          {m.id === mode && <Check className="khead-check" aria-hidden />}
        </button>
      ))}
    </div>
  );

  useEffect(() => {
    if (hasWindowsTitleBar || narrow || !menu || hovering) return;
    const timer = setTimeout(() => setMenu(false), 3000);
    return () => clearTimeout(timer);
  }, [narrow, menu, hovering, interaction]);

  return (
    <header className={`khead ${narrow ? 'is-narrow' : 'is-wide'}${hasWindowsTitleBar ? ' is-windows' : ''}`}>
      {narrow && (
        <button type="button" className="khead-round" aria-label="Back" onClick={onBack}>
          <ChevronLeft aria-hidden />
          {!!backBadge && <span className="khead-badge">{backBadge}</span>}
        </button>
      )}
      {/* As on Mac: the expanded mode segments take the title's place so they never overlap it. */}
      <button type="button" className={`khead-title${menu && !narrow ? ' is-hidden' : ''}`} aria-hidden={menu && !narrow ? true : undefined} tabIndex={menu && !narrow ? -1 : undefined} onClick={onTitle} title="Session details">
        <span>{title}</span>
      </button>
      {hasWindowsTitleBar && <span className="khead-separator" aria-hidden="true" />}
      <div className="khead-mode" ref={menuRef} onMouseEnter={() => setHovering(true)} onMouseLeave={() => setHovering(false)}
        onBlur={(e) => { if (hasWindowsTitleBar && !containsModeTarget(e.relatedTarget)) setMenu(false); }}
        onKeyDown={(e) => {
          if (!hasWindowsTitleBar || !menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
          e.preventDefault();
          const options = [...(popupRef.current ?? e.currentTarget).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1
            : (index + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
          options[next]?.focus();
        }}>
        {menu && !narrow && !hasWindowsTitleBar ? <div className="khead-segments" role="menu" aria-label="Session mode picker">
          {MODES.map((m) => <button key={m.id} type="button" role="menuitemradio" aria-checked={m.id === mode}
            style={{ background: m.id === mode ? m.color : undefined }}
            onClick={() => { if (m.id !== mode) onMode(m.id); setInteraction((v) => v + 1); }}>
            {m.label}
          </button>)}
        </div> : <button ref={triggerRef} type="button" className="khead-capsule" aria-label={`Session mode, ${current.label}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <span className="khead-dot" style={{ background: current.color }} />
          {current.label}
          {hasWindowsTitleBar && <ChevronDown className="khead-chevron" aria-hidden="true" />}
        </button>}
        {dropdown && (popupHost ? createPortal(
          // Escape chat clipping without escaping the app's overlay stacking context.
          <div ref={popupRef} className="kchat-page khead-windows-popup" style={{
            '--windows-mode-left': `${menuAnchor.left}px`,
            '--windows-mode-top': `${menuAnchor.top}px`,
          } as CSSProperties}>{dropdown}</div>, popupHost,
        ) : dropdown)}
      </div>
    </header>
  );
}
