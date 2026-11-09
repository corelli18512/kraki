import { useEffect, useState } from 'react';
import { useStore } from './useStore';

/** Longest an empty list waits for an online computer's session_list before
 *  the empty state is shown anyway (an old or stuck computer never answers). */
export const SESSION_LIST_WAIT_MS = 10_000;

/** True while the session list may still arrive: the relay link is still
 *  connecting, or an online computer has not sent its session_list on this
 *  connection yet. A fresh browser on an existing account must not show
 *  "No sessions yet" (and the first-time heading) during that time. */
export function useSessionListLoading(): boolean {
  const connecting = useStore((s) => s.status === 'connecting');
  const waiting = useStore((s) => {
    if (s.status !== 'connected') return false;
    for (const device of s.devices.values()) {
      if (device.role === 'tentacle' && device.online && !s.sessionListDevices.has(device.id)) return true;
    }
    return false;
  });
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!waiting) { setExpired(false); return; }
    const timer = setTimeout(() => setExpired(true), SESSION_LIST_WAIT_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  return connecting || (waiting && !expired);
}
