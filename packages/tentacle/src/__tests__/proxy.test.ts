import { describe, it, expect, vi } from 'vitest';
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

describe('parseWindowsProxy', async () => {
  const { parseWindowsProxy } = await import('../proxy.js');
  const head = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n    CertificateRevocation    REG_DWORD    0x1\r\n';
  const tail = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections\r\n';
  it('reads a manual proxy (real reg query output)', () => {
    const out = `${head}    ProxyEnable    REG_DWORD    0x1\r\n    MigrateProxy    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    10.0.2.2:2181\r\n${tail}`;
    expect(parseWindowsProxy(out)).toEqual({ https: 'http://10.0.2.2:2181', http: 'http://10.0.2.2:2181', noProxy: [], source: 'windows-system' });
  });
  it('ignores a proxy that is switched off', () => {
    expect(parseWindowsProxy(`${head}    ProxyEnable    REG_DWORD    0x0\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`)).toBeNull();
    expect(parseWindowsProxy(head)).toBeNull();
  });
  it('per-protocol servers and bypass list (Clash style)', () => {
    const out = `${head}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892\r\n    ProxyOverride    REG_SZ    localhost;127.*;10.*;192.168.*;*.corp.example;<local>\r\n`;
    expect(parseWindowsProxy(out)).toEqual({
      https: 'http://127.0.0.1:7891', http: 'http://127.0.0.1:7890',
      noProxy: ['localhost', '127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16', '*.corp.example'], source: 'windows-system',
    });
  });
  it('keeps an explicit scheme', () => {
    const out = `${head}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    http://proxy.corp:8080\r\n`;
    expect(parseWindowsProxy(out)?.https).toBe('http://proxy.corp:8080');
  });
});

describe('unsupported proxies are named, not silently ignored (K-328)', async () => {
  const { parseScutilUnsupported, parseWindowsUnsupported, unsupportedProxy, unsupportedProxyMessage } = await import('../proxy.js');

  it('names a PAC-only or SOCKS-only macOS system proxy', () => {
    expect(parseScutilUnsupported('<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 1\n  ProxyAutoConfigURLString : http://wpad/proxy.pac\n}'))
      .toBe('automatic proxy configuration (PAC)');
    expect(parseScutilUnsupported('<dictionary> {\n  SOCKSEnable : 1\n  SOCKSPort : 7891\n  SOCKSProxy : 127.0.0.1\n}'))
      .toBe('SOCKS proxy');
  });

  it('says nothing when a web proxy is set or no proxy at all', () => {
    expect(parseScutilUnsupported(`${SCUTIL.slice(0, -1)}  SOCKSEnable : 1\n}`)).toBeNull();
    expect(parseScutilUnsupported('<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 0\n}')).toBeNull();
  });

  it('names a PAC or SOCKS-only Windows proxy', () => {
    const head = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\r\n';
    expect(parseWindowsUnsupported(`${head}    ProxyEnable    REG_DWORD    0x0\r\n    AutoConfigURL    REG_SZ    http://corp/proxy.pac\r\n`))
      .toBe('automatic proxy configuration (PAC)');
    expect(parseWindowsUnsupported(`${head}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    socks=127.0.0.1:7891\r\n`))
      .toBe('SOCKS proxy');
    expect(parseWindowsUnsupported(`${head}    ProxyEnable    REG_DWORD    0x1\r\n    ProxyServer    REG_SZ    127.0.0.1:7890\r\n`)).toBeNull();
  });

  it('ignores ALL_PROXY=socks5://… (no raw Node SOCKS warning, no broken WebSocket agent) and names it', () => {
    expect(detectProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891' }, 'linux')).toBeNull();
    expect(unsupportedProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891' }, 'linux')).toBe('SOCKS proxy (ALL_PROXY)');
    expect(unsupportedProxyMessage('SOCKS proxy (ALL_PROXY)')).toContain('HTTPS_PROXY=http://');
  });

  it('keeps an HTTP proxy next to a SOCKS ALL_PROXY', () => {
    expect(detectProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891', HTTPS_PROXY: 'http://127.0.0.1:7890' }, 'linux'))
      .toEqual({ https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', noProxy: [], source: 'env' });
    expect(unsupportedProxy({ ALL_PROXY: 'socks5://127.0.0.1:7891', HTTPS_PROXY: 'http://127.0.0.1:7890' }, 'linux')).toBeNull();
  });
});

describe('reads the system proxy once per process (K-328)', () => {
  it('runs scutil --proxy once for detectProxy and unsupportedProxy', async () => {
    vi.resetModules();
    const execFileSync = vi.fn(() => '<dictionary> {\n  HTTPEnable : 0\n  ProxyAutoConfigEnable : 0\n}');
    vi.doMock('node:child_process', () => ({ execFileSync }));
    try {
      const proxy = await import('../proxy.js');
      expect(proxy.detectProxy({}, 'darwin')).toBeNull();
      expect(proxy.unsupportedProxy({}, 'darwin')).toBeNull();
      expect(proxy.unsupportedProxy({}, 'darwin')).toBeNull();
      expect(execFileSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});
