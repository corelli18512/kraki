import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft } from 'lucide-react';

export type SessionMode = 'safe' | 'discuss' | 'execute' | 'delegate';

export const MODES: { id: SessionMode; label: string; color: string; hint: string }[] = [
  { id: 'safe', label: 'Safe', color: '#34d399', hint: 'Ask before every tool' },
  { id: 'discuss', label: 'Discuss', color: '#22d3ee', hint: 'Read freely, ask before writing' },
  { id: 'execute', label: 'Execute', color: '#fbbf24', hint: 'Edit files without asking' },
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
  const menuRef = useRef<HTMLDivElement>(null);
  const current = MODES.find((m) => m.id === mode) ?? MODES[1];

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);

  return (
    <header className={`khead ${narrow ? 'is-narrow' : 'is-wide'}`}>
      {narrow && (
        <button type="button" className="khead-round" aria-label="Back" onClick={onBack}>
          <ChevronLeft aria-hidden />
          {!!backBadge && <span className="khead-badge">{backBadge}</span>}
        </button>
      )}
      <button type="button" className="khead-title" onClick={onTitle} title="Session details">
        <span>{title}</span>
      </button>
      <div className="khead-mode" ref={menuRef}>
        <button type="button" className="khead-capsule" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          <span className="khead-dot" style={{ background: current.color }} />
          {current.label}
        </button>
        {menu && (
          <div className="khead-menu" role="menu">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                aria-checked={m.id === mode}
                onClick={() => { setMenu(false); if (m.id !== mode) onMode(m.id); }}
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
        )}
      </div>
    </header>
  );
}
