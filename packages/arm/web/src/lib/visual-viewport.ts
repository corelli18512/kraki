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
  // Applied synchronously: the keyboard animation needs the app to follow
  // in the same frame (setting two custom properties is cheap).
  const apply = () => {
    root.style.setProperty('--kraki-vvh', `${Math.round(vv.height)}px`);
    root.style.setProperty('--kraki-vvt', `${Math.round(vv.offsetTop)}px`);
  };
  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  return () => {
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
  };
}
