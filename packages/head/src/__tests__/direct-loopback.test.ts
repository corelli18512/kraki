import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isDirectLoopback } from '../client-ip.js';

const req = (remoteAddress: string, headers: Record<string, string> = {}) =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

describe('isDirectLoopback', () => {
  it.each(['127.0.0.1', '127.0.0.2', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:127.0.0.2'])('accepts loopback peer %s', (addr) => {
    expect(isDirectLoopback(req(addr))).toBe(true);
  });
  it.each(['10.0.0.1', '192.168.1.2', '::ffff:10.0.0.1', '1270.0.0.1', '', '::2'])('rejects non-loopback peer %s', (addr) => {
    expect(isDirectLoopback(req(addr))).toBe(false);
  });
  it('rejects a loopback peer that a proxy forwarded', () => {
    expect(isDirectLoopback(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.1' }))).toBe(false);
  });
});
