/**
 * Copy text from a click or key press. Without the Clipboard API (a
 * self-hosted relay served over plain http is not a secure context, so
 * `navigator.clipboard` is undefined) or when it refuses, fall back to
 * selecting a hidden textarea and `execCommand('copy')`. Rejects when
 * neither works, so the caller can say it couldn't copy (K-215).
 *
 * Call it synchronously in the event handler: Safari allows clipboard writes
 * only inside the user gesture.
 */
export function copyText(text: string): Promise<void> {
  let write: Promise<void> | undefined;
  try { write = navigator.clipboard?.writeText(text); } catch { write = undefined; }
  if (!write) return copyWithSelection(text) ? Promise.resolve() : Promise.reject(new Error('Clipboard unavailable'));
  return write.catch((err: unknown) => {
    if (!copyWithSelection(text)) throw err;
  });
}

function copyWithSelection(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.select();
  let copied = false;
  try { copied = typeof document.execCommand === 'function' && document.execCommand('copy'); } catch { copied = false; }
  area.remove();
  focused?.focus({ preventScroll: true });
  return copied;
}
