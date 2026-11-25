import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router';

/** The app's router. Route changes render synchronously: as a transition
 *  (React Router's default) the address bar already showed the new session
 *  while the previous chat stayed on screen until the transition committed
 *  (K-240). */
export function AppRouter({ children }: { children: ReactNode }) {
  return <BrowserRouter unstable_useTransitions={false}>{children}</BrowserRouter>;
}
