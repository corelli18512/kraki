/**
 * Log audit 2026-10-22 (web-mac-client P2-4): a 36 s and a 3 min web outage
 * left no transport lines at all - no close, no attempt, no backoff - so they
 * could not be split into retries, handshake and auth. The transport must log
 * each close, each scheduled retry and the recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KrakiTransport } from './transport';
import { useStore } from '../hooks/useStore';

type Sock = WebSocket & { onclose: ((ev: { code: number }) => void) | null; onerror: (() => void) | null };

function transportLines(info: ReturnType<typeof vi.spyOn>): Array<[string, Record<string, unknown>]> {
  return info.mock.calls
    .filter(([prefix]) => prefix === '[Kraki:transport]')
    .map(([, message, fields]) => [message as string, fields as Record<string, unknown>]);
}

describe('web transport reconnect logging', () => {
  let info: ReturnType<typeof vi.spyOn>;
  let sockets: Sock[];
  const Original = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    useStore.getState().reset();
    sockets = [];
    globalThis.WebSocket = class extends Original {
      constructor(url: string) {
        super(url);
        sockets.push(this as unknown as Sock);
      }
    } as unknown as typeof WebSocket;
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.WebSocket = Original;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs the close, the backoff of every retry and the recovery with its timings', async () => {
    const transport = new KrakiTransport({ onOpen: async () => {}, onParsedMessage: () => {} }, 'wss://relay.example/ws?token=secret');
    transport.storedDeviceId = 'dev-web';
    info.mockClear(); // loadStoredDevice
    transport.connect();
    await vi.advanceTimersByTimeAsync(1);
    transport.setAuthenticated(true);
    expect(transportLines(info)).toEqual([]); // a first connect is not an outage

    sockets[0].onclose?.({ code: 1006 });
    let lines = transportLines(info);
    expect(lines[0]).toEqual(['WebSocket closed', expect.objectContaining({
      reason: 'peer_closed', code: 1006, attempt: 0, wasAuthenticated: true,
    })]);
    expect(lines[1]).toEqual(['Reconnect scheduled', expect.objectContaining({ attempt: 1, delayMs: expect.any(Number), outageMs: 0 })]);

    // The retry fails before opening: error, close, a longer backoff.
    await vi.advanceTimersByTimeAsync(lines[1][1].delayMs as number);
    expect(sockets).toHaveLength(2);
    expect(transportLines(info).at(-1)).toEqual(['Reconnecting', expect.objectContaining({
      attempt: 1, host: 'relay.example',
    })]);
    sockets[1].onerror?.();
    sockets[1].onclose?.({ code: 1006 });
    lines = transportLines(info);
    expect(lines.map(([message]) => message)).toEqual([
      'WebSocket closed', 'Reconnect scheduled', 'Reconnecting', 'WebSocket error', 'WebSocket closed', 'Reconnect scheduled',
    ]);
    expect(lines.at(-1)?.[1]).toMatchObject({ attempt: 2 });

    await vi.advanceTimersByTimeAsync(lines.at(-1)?.[1].delayMs as number);
    await vi.advanceTimersByTimeAsync(1); // socket opens
    await vi.advanceTimersByTimeAsync(250); // auth round trip
    transport.setAuthenticated(true);
    const recovered = transportLines(info).at(-1);
    expect(recovered?.[0]).toBe('Reconnected');
    expect(recovered?.[1]).toMatchObject({ attempts: 2, authMs: 250 });
    expect(recovered?.[1].outageMs as number).toBeGreaterThan(0);
    expect(JSON.stringify(transportLines(info))).not.toContain('secret');
    transport.disconnect();
  });
});
