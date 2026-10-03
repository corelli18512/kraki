import { describe, it, expect } from 'vitest';
import { parseScutilProxy, detectProxy, bypassesProxy, proxyFor } from '../proxy.js';

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.1
    2 : 192.168.0.0/16
    3 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 2081
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 2082
  HTTPSProxy : 10.0.0.5
}`;

describe('proxy', () => {
  it('reads the macOS system proxy', () => {
    expect(parseScutilProxy(SCUTIL)).toEqual({
      https: 'http://10.0.0.5:2082', http: 'http://127.0.0.1:2081',
      noProxy: ['localhost', '127.0.0.1', '192.168.0.0/16', '*.local'], source: 'macos-system',
    });
    expect(parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n}')).toBeNull();
  });

  it('prefers environment variables, any case', () => {
    expect(detectProxy({ https_proxy: 'http://p:1', NO_PROXY: 'a.com, b.org' }, 'linux'))
      .toEqual({ https: 'http://p:1', http: 'http://p:1', noProxy: ['a.com', 'b.org'], source: 'env' });
    expect(detectProxy({}, 'linux')).toBeNull();
  });

  it('honours bypass rules', () => {
    const rules = ['localhost', '*.local', '.corp.example', '192.168.0.0/16'];
    expect(bypassesProxy('localhost', rules)).toBe(true);
    expect(bypassesProxy('mac.local', rules)).toBe(true);
    expect(bypassesProxy('git.corp.example', rules)).toBe(true);
    expect(bypassesProxy('192.168.64.1', rules)).toBe(true);
    expect(bypassesProxy('cn.relay.kraki.chat', rules)).toBe(false);
    expect(bypassesProxy('anything', ['*'])).toBe(true);
  });

  it('picks the proxy per URL scheme', () => {
    const s = { https: 'http://s:1', http: 'http://h:2', noProxy: ['192.168.0.0/16'], source: 'env' as const };
    expect(proxyFor('wss://cn.relay.kraki.chat', s)).toBe('http://s:1');
    expect(proxyFor('ws://relay.example:4000', s)).toBe('http://h:2');
    expect(proxyFor('ws://192.168.64.1:4600', s)).toBeUndefined();
    expect(proxyFor('wss://x', null)).toBeUndefined();
  });
});
