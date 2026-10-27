import { describe, it, expect } from 'vitest';
import { isLoopbackHost, resolveListenHost, LOOPBACK_HOST } from '../listen-host.js';

const base = { host: '', authModes: ['open'], openSharedKey: '', connectedMode: false };

describe('resolveListenHost', () => {
  it('binds open auth without a shared key to loopback by default', () => {
    expect(resolveListenHost(base)).toEqual({ ok: true, host: LOOPBACK_HOST });
    expect(LOOPBACK_HOST).toBe('127.0.0.1');
  });

  it('binds loopback when open is one of several modes and has no key', () => {
    expect(resolveListenHost({ ...base, authModes: ['github', 'open'] })).toEqual({ ok: true, host: LOOPBACK_HOST });
  });

  it.each(['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', 'relay.example.com', 'myhost'])(
    'refuses non-loopback host %s for open auth without a shared key',
    (host) => {
      const result = resolveListenHost({ ...base, host });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(host);
        expect(result.error).toContain('OPEN_SHARED_KEY');
      }
    },
  );

  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]'])(
    'allows explicit loopback host %s for open auth without a shared key',
    (host) => {
      expect(resolveListenHost({ ...base, host })).toEqual({ ok: true, host: host.replace(/^\[(.*)\]$/, '$1') });
    },
  );

  it('strips IPv6 brackets so listen() gets a bare address', () => {
    expect(resolveListenHost({ ...base, host: '[::1]' })).toEqual({ ok: true, host: '::1' });
    expect(resolveListenHost({ ...base, host: '[::]', openSharedKey: 'k' })).toEqual({ ok: true, host: '::' });
  });

  it('allows any host for open auth once a shared key is set', () => {
    expect(resolveListenHost({ ...base, host: '0.0.0.0', openSharedKey: 'secret' })).toEqual({ ok: true, host: '0.0.0.0' });
    // With a key and no host, the bind stays Node's default (all interfaces), as before.
    expect(resolveListenHost({ ...base, openSharedKey: 'secret' })).toEqual({ ok: true, host: undefined });
  });

  it('keeps the default bind for non-open modes', () => {
    expect(resolveListenHost({ ...base, authModes: ['github'] })).toEqual({ ok: true, host: undefined });
    expect(resolveListenHost({ ...base, authModes: ['apikey'] })).toEqual({ ok: true, host: undefined });
    expect(resolveListenHost({ ...base, authModes: ['github'], host: '0.0.0.0' })).toEqual({ ok: true, host: '0.0.0.0' });
    expect(resolveListenHost({ ...base, authModes: ['github'], host: '127.0.0.1' })).toEqual({ ok: true, host: '127.0.0.1' });
  });

  it('keeps the default bind in connected (edge) mode, where auth is delegated', () => {
    expect(resolveListenHost({ ...base, connectedMode: true })).toEqual({ ok: true, host: undefined });
    expect(resolveListenHost({ ...base, connectedMode: true, host: '0.0.0.0' })).toEqual({ ok: true, host: '0.0.0.0' });
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback addresses', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const h of ['0.0.0.0', '::', '128.0.0.1', '192.168.0.1', 'foo.localhost', 'localhost.example.com', '::ffff:10.0.0.1']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
