import { useSyncExternalStore } from 'react';
import { isDesktop } from '../lib/desktop';

/** Below this width the app uses the iPhone layout (one pane, floating
 *  controls); at and above it the Mac layout (sidebar + chat). */
export const NARROW_QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

export function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !isDesktop && window.matchMedia(NARROW_QUERY).matches,
    () => false,
  );
}
