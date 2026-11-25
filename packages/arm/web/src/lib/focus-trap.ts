/** Every control Tab can reach, in document order. */
const TABBABLE = 'button, input, select, textarea, a[href], [tabindex]';

function tabStops(scope: HTMLElement): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      !el.closest('[hidden], fieldset:disabled') &&
      // Tab never stops on a control that isn't rendered (display: none).
      (typeof el.checkVisibility !== 'function' || el.checkVisibility({ checkVisibilityCSS: true })),
  );
}

/**
 * Keeps Tab inside a modal by moving focus itself on every Tab, not only at
 * the ends: Safari's default Tab order skips buttons, so the last control is
 * never focused there and an ends-only trap lets focus leave (K-101, K-212).
 * Returns false (and leaves the event alone) when there is nothing to focus.
 */
export function cycleTabFocus(scope: HTMLElement, event: { shiftKey: boolean; preventDefault: () => void }): boolean {
  const controls = tabStops(scope);
  if (controls.length === 0) return false;
  event.preventDefault();
  const index = controls.indexOf(document.activeElement as HTMLElement);
  const next = event.shiftKey
    ? (index <= 0 ? controls.length - 1 : index - 1)
    : (index === -1 || index === controls.length - 1 ? 0 : index + 1);
  controls[next].focus();
  return true;
}
