/** The Kraki logo (octopus with the coffee cup), light/dark variants like the apps.
 *  `decorative` hides it from assistive tech when a labelled control wraps it. */
export function KrakiLogo({ className = '', decorative = false }: { className?: string; decorative?: boolean }) {
  const alt = decorative ? '' : 'Kraki';
  return (
    <>
      <img src="/logo.png" alt={alt} aria-hidden={decorative || undefined} className={`${className} dark:hidden`} />
      <img src="/logo-dark.png" alt={alt} aria-hidden={decorative || undefined} className={`${className} hidden dark:block`} />
    </>
  );
}
