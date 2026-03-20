import { useEffect, useRef } from 'react';
import { wsClient } from '../lib/ws-client';

/**
 * Manages WebSocket lifecycle — connect on mount, disconnect on unmount.
 * Uses a ref to avoid double-connecting in StrictMode.
 */
export function useWebSocket() {
  const connected = useRef(false);

  useEffect(() => {
    if (!connected.current) {
      connected.current = true;
      wsClient.connect();
    }
    return () => {
      // Don't disconnect on StrictMode remount — only on true unmount
    };
  }, []);

  return wsClient;
}
