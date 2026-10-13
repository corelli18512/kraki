import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Plain rendered prose, without fence labels or table-window controls. */
export function renderedMessageText(root: HTMLElement): string {
  function text(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.matches('.kmd-code-lang, .ktable-footer')) return '';
    // Mac table attachments copy the complete TSV, including preview-hidden rows.
    if (node.dataset.copyText !== undefined) return `${node.dataset.copyText}\n`;
    if (node.tagName === 'BR') return '\n';
    const children = Array.from(node.childNodes).map(text).join('');
    if (node.tagName === 'TD' || node.tagName === 'TH') return `${children}\t`;
    if (node.tagName === 'TR') return `${children.trimEnd()}\n`;
    if (node.tagName === 'LI') {
      const list = node.parentElement;
      const index = list ? Array.from(list.children).indexOf(node) : 0;
      const marker = list?.tagName === 'OL' ? `${Number(list.getAttribute('start') ?? 1) + index}.` : '•';
      return `${marker}\t${children.trim()}\n`;
    }
    if (node.matches('p, h1, h2, h3, h4, h5, h6, pre, .kmd-native-rule')) return `${children}\n`;
    return children;
  }
  return text(root).replace(/\n{3,}/g, '\n\n').trim();
}

/** Native bubble actions are contextual, never a permanent copy icon. */
export function MessageBubble({ children, className, style, onShowSteps }: {
  children: ReactNode;
  className: string;
  style?: CSSProperties;
  onShowSteps?: () => void;
}) {
  const bubble = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; text: string; selection: boolean } | null>(null);

  function close(restoreFocus = false) {
    setContext(null);
    if (restoreFocus) previousFocus.current?.focus({ preventScroll: true });
  }

  function open(x: number, y: number) {
    const root = bubble.current;
    if (!root) return;
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)
      ? selection.toString() : '';
    const body = root.querySelector<HTMLElement>('.kmd');
    const text = selected || (body ? renderedMessageText(body) : '');
    if (!text && !onShowSteps) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : root;
    setContext({ x, y, text, selection: !!selected });
  }

  useLayoutEffect(() => {
    if (!context || !menu.current) return;
    const el = menu.current;
    const bounds = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(context.x, window.innerWidth - bounds.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(context.y, window.innerHeight - bounds.height - 4))}px`;
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setContext(null);
    };
    const scroll = () => setContext(null);
    document.addEventListener('mousedown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', scroll);
    };
  }, [context]);

  return (
    <div
      ref={bubble}
      className={className}
      style={style}
      tabIndex={0}
      onContextMenu={(event) => { event.preventDefault(); open(event.clientX, event.clientY); }}
      onKeyDown={(event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          open(bounds.left + 14, bounds.top + 14);
        }
      }}
    >
      {children}
      {context && createPortal(
        <div
          ref={menu}
          className="kmessage-menu"
          role="menu"
          aria-label="Message actions"
          style={{ left: context.x, top: context.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(true); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}
        >
          {context.text && (
            <button type="button" role="menuitem" onClick={() => { void navigator.clipboard.writeText(context.text); close(true); }}>
              {context.selection ? 'Copy Selection' : 'Copy'}
            </button>
          )}
          {onShowSteps && <button type="button" role="menuitem" onClick={() => { close(true); onShowSteps(); }}>Show Steps</button>}
        </div>, document.body,
      )}
    </div>
  );
}
