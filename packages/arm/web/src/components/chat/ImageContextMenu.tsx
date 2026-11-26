import { useTranslation } from 'react-i18next';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { downloadImage } from '../../lib/image-download';
import { copyImage } from '../../lib/image-copy';
import { useStore } from '../../hooks/useStore';
import { onMenuKeyDown } from '../../lib/menu-keyboard';

/** The original bytes of a chat image and the name to save them under. */
export interface ImageFile { blob: Blob; fileName: string }

/**
 * Right-click (or the keyboard's menu key) on a chat image: a menu that saves
 * the original image or copies it (as PNG; a GIF's first frame: image-copy.ts).
 * The Windows app has no browser image menu, and the browser's own one names
 * a downloaded `blob:` image after its random URL. Until the image has
 * loaded, the browser's menu is left alone. `container`: where the menu is
 * placed (a modal owns focus and keys within itself); else the page body.
 */
export function useImageContextMenu(file: () => ImageFile | null, container?: () => HTMLElement | null): {
  handlers: { onContextMenu: (event: MouseEvent<HTMLElement>) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };
  menu: ReactNode;
} {
  const { t } = useTranslation('chat');
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  function open(x: number, y: number, target: HTMLElement): boolean {
    if (!file()) return false;
    opener.current = target;
    setAt({ x, y });
    return true;
  }

  function close(restoreFocus = false) {
    setAt(null);
    if (!restoreFocus) return;
    opener.current?.focus({ preventScroll: true });
    // An opener that takes no focus (the viewer's image): focus goes to the
    // container, else it fell to the page body and the viewer swallowed the
    // next key to take it back.
    if (document.activeElement !== opener.current) container?.()?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const el = menu.current;
    const bounds = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - bounds.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - bounds.height - 4))}px`;
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const outside = (event: globalThis.MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setAt(null);
    };
    const dismiss = () => setAt(null);
    document.addEventListener('mousedown', outside);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [at]);

  return {
    handlers: {
      onContextMenu: (event) => {
        if (open(event.clientX, event.clientY, event.currentTarget)) event.preventDefault();
      },
      onKeyDown: (event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (open(bounds.left + 14, bounds.top + 14, event.currentTarget)) event.preventDefault();
      },
    },
    menu: at && createPortal(
      <div ref={menu} className="kmessage-menu" role="menu" aria-label={t('attachments.imageActions')} style={{ left: at.x, top: at.y }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(true); }
          onMenuKeyDown(event);
        }}>
        <button type="button" role="menuitem" onClick={() => {
          const current = file();
          if (current) downloadImage(current.blob, current.fileName);
          close(true);
        }}>{t('attachments.downloadImage')}</button>
        <button type="button" role="menuitem" onClick={() => {
          const current = file();
          if (current) {
            void copyImage(current.blob).catch(() => useStore.getState().setLastError(t('attachments.copyImageFailed')));
          }
          close(true);
        }}>{t('attachments.copyImage')}</button>
      </div>, container?.() ?? document.body,
    ),
  };
}
