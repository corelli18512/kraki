/** Frames with unchanged geometry before a follow loop stops. */
const SETTLED_FRAMES = 8;
/** Shortest follow loop: iOS may start panning several frames after focus,
 *  so a still start must not end the loop before the pan begins. */
const MIN_FOLLOW_MS = 500;
/** Upper bound for one follow loop (the iOS keyboard animates in ~0.3 s). */
const FOLLOW_MS = 1000;

/**
 * Keep the app inside the *visual* viewport. Android Chrome resizes the
 * layout for the on-screen keyboard (`interactive-widget=resizes-content`),
 * but iOS Safari only shrinks the visual viewport and scrolls the page; there
 * the composer would sit under the keyboard. Publishing the visual viewport's
 * height/offset as CSS variables lets `.app-viewport` follow it everywhere.
 */
export function trackVisualViewport(): () => void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};
  const root = document.documentElement;
  let last = '';
  // Applied synchronously: the keyboard animation needs the app to follow
  // in the same frame (setting two custom properties is cheap).
  const apply = (): boolean => {
    const height = `${Math.round(vv.height)}px`;
    const top = `${Math.round(vv.offsetTop)}px`;
    if (`${height} ${top}` === last) return false;
    last = `${height} ${top}`;
    root.style.setProperty('--kraki-vvh', height);
    root.style.setProperty('--kraki-vvt', top);
    return true;
  };
  // iOS Safari pans the visual viewport while the keyboard slides in (and on
  // focus) but dispatches `scroll`/`resize` only once it has settled, so the
  // app stayed scrolled away for the whole animation. Sample every frame
  // from the first sign of movement until the geometry is stable.
  let frame = 0;
  let minUntil = 0;
  let deadline = 0;
  let still = 0;
  const step = () => {
    still = apply() ? 0 : still + 1;
    const now = performance.now();
    const settled = still >= SETTLED_FRAMES && now >= minUntil;
    frame = !settled && now < deadline ? requestAnimationFrame(step) : 0;
  };
  const follow = () => {
    apply();
    const now = performance.now();
    minUntil = now + MIN_FOLLOW_MS;
    deadline = now + FOLLOW_MS;
    still = 0;
    if (!frame) frame = requestAnimationFrame(step);
  };
  apply();
  vv.addEventListener('resize', follow);
  vv.addEventListener('scroll', follow);
  window.addEventListener('resize', follow);
  document.addEventListener('focusin', follow);
  document.addEventListener('focusout', follow);
  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', follow);
    vv.removeEventListener('scroll', follow);
    window.removeEventListener('resize', follow);
    document.removeEventListener('focusin', follow);
    document.removeEventListener('focusout', follow);
  };
}
