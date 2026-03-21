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
