/** The Kraki logo (octopus with the coffee cup), light/dark variants like the apps. */
export function KrakiLogo({ className = '' }: { className?: string }) {
  return (
    <>
      <img src="/logo.png" alt="Kraki" className={`${className} dark:hidden`} />
      <img src="/logo-dark.png" alt="Kraki" className={`${className} hidden dark:block`} />
    </>
  );
}
