import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

/** The keyboard's context-menu request: the Menu key, or Shift+F10 (macOS
 *  browsers never turn these into a `contextmenu` event). */
export function isContextMenuKey(e: ReactKeyboardEvent | KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}

function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role=menuitem]')].filter((item) => !item.matches(':disabled'));
}

/** Put focus on a menu's first item (when it opens from the keyboard or the mouse). */
export function focusFirstMenuItem(menu: HTMLElement | null): void {
  if (menu) menuItems(menu)[0]?.focus();
}

/** Arrow keys, Home and End move between a menu's items (WAI-ARIA menu). */
export function onMenuKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = menuItems(e.currentTarget);
  if (items.length === 0) return;
  e.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? items.length - 1
    : e.key === 'ArrowDown' ? (index + 1) % items.length
    : (index <= 0 ? items.length - 1 : index - 1);
  items[next].focus();
}
