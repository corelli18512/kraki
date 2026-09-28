import { useEffect, useState } from 'react';
import { useStore } from './useStore';

/** A reconnect that finishes within this long is not shown (same as the
 *  native apps): a flash of "Reconnecting…" on a blip only alarms the user. */
export const RECONNECTING_DEBOUNCE_MS = 2_000;

/** True while the relay link has been down (after having been up) for longer
 *  than the debounce. */
export function useShowsReconnecting(): boolean {
  const reconnecting = useStore((s) => (s.status === 'disconnected' || s.status === 'connecting') && s.reconnectAttempts > 0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!reconnecting) { setShown(false); return; }
    const timer = setTimeout(() => setShown(true), RECONNECTING_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  return reconnecting && shown;
}
