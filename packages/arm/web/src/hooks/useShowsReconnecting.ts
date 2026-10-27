import { useEffect, useState } from 'react';
import { useStore } from './useStore';
import { diag } from '../lib/diag';

/** A reconnect that finishes within this long is not shown (same as the
 *  native apps): a flash of "Reconnecting…" on a blip only alarms the user. */
export const RECONNECTING_DEBOUNCE_MS = 2_000;

/** Mounted indicators showing "Reconnecting…" (Sidebar and SessionPage).
 *  Performance data counts the time any of them shows it, so one that
 *  mounts mid-outage, still debouncing, does not end that time. */
let showing = 0;

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
  // Performance data: time "Reconnecting…" was actually on screen.
  useEffect(() => {
    if (!reconnecting || !shown) return;
    if (++showing === 1) diag.stability.reconnectingShown(true);
    return () => { if (--showing === 0) diag.stability.reconnectingShown(false); };
  }, [reconnecting, shown]);
  return reconnecting && shown;
}
