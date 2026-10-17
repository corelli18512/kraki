export function shouldAutoFocusTextInput(): boolean {
  const coarsePointerQuery =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)')
      : null;

  const hasCoarsePointer = coarsePointerQuery?.matches === true;

  const hasTouchPoints =
    typeof navigator !== 'undefined' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 0;

  return !(hasCoarsePointer || hasTouchPoints);
}

/** Whether a hardware-style Enter sends (Shift+Enter = newline), as on Mac.
 *  Separate from autofocus: a touchscreen Windows laptop reports touch points
 *  but its primary pointer is fine (trackpad/mouse) and it has a physical
 *  keyboard, so Enter must send. Only a device whose PRIMARY pointer is coarse
 *  (phone/tablet, Windows tablet mode) keeps Return as a newline. */
export function enterSendsMessage(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return !window.matchMedia('(pointer: coarse)').matches;
  }
  return shouldAutoFocusTextInput();
}
