import { useEffect, useRef } from 'react';

/** Only the foreground desktop sheet consumes keys, leaving Settings and other sheets open. */
export function useDesktopSheet(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>('.ds-sheet-actions button:last-child')?.focus();
    const key = (e: KeyboardEvent) => {
      const sheets = document.querySelectorAll('.ds-sheet[role="dialog"]');
      if (sheets[sheets.length - 1] !== ref.current) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const controls = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]');
        if (!controls?.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  return ref;
}
