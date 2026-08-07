import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KrakiMcpServer } from '../server.js';
import {
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcResponse,
} from '../protocol.js';

interface Fixture {
  server: KrakiMcpServer;
  baseUrl: string;
  token: string;
  credentialsForSession: (s: string) => { url: string; bearerToken: string };
  activeSessions: Set<string>;
}

async function start(initialSessions: string[] = []): Promise<Fixture> {
  const activeSessions = new Set<string>(initialSessions);
  const server = new KrakiMcpServer({
    version: '0.0.0-test',
    isSessionActive: (id) => activeSessions.has(id),
  });
  const info = await server.start();
  return {
    server,
    baseUrl: info.baseUrl,
    token: info.bearerToken,
    credentialsForSession: info.credentialsForSession,
    activeSessions,
  };
}

async function rpc(
  url: string,
  token: string | undefined,
  body: unknown,
): Promise<{ status: number; json: JsonRpcResponse | { error: string } }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const txt = await res.text();
  let json: JsonRpcResponse | { error: string };
  try {
    json = JSON.parse(txt);
  } catch {
    json = { error: 'non_json' };
  }
  return { status: res.status, json };
}

describe('KrakiMcpServer — transport and auth', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await start();
  });
  afterEach(async () => {
    await fx.server.stop();
  });

  it('binds to a kernel-assigned loopback port', () => {
    expect(fx.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(fx.token).toHaveLength(64);
  });

  it('returns 401 for missing Authorization header', async () => {
    const r = await rpc(fx.baseUrl, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.status).toBe(401);
  });

  it('returns 401 for wrong bearer token', async () => {
    const r = await rpc(fx.baseUrl, 'a'.repeat(fx.token.length), {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(r.status).toBe(401);
  });

  it('returns 405 for non-POST requests', async () => {
    const res = await fetch(fx.baseUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${fx.token}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('returns 404 for unknown paths', async () => {
    const url = fx.baseUrl.replace('/mcp', '/other');
    const r = await rpc(url, fx.token, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.status).toBe(404);
  });

  it('returns 404 for nested paths under /mcp/sid/extra', async () => {
    const url = `${fx.baseUrl}/sid/extra`;
    const r = await rpc(url, fx.token, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(r.status).toBe(404);
  });

  it('returns JSON-RPC parse error for invalid JSON', async () => {
    const r = await rpc(fx.baseUrl, fx.token, 'not json{');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSON_RPC_PARSE_ERROR },
    });
  });

  it('rejects non-2.0 jsonrpc envelopes', async () => {
    const r = await rpc(fx.baseUrl, fx.token, { jsonrpc: '1.0', id: 1, method: 'initialize' });
    expect(r.json).toMatchObject({ error: { code: JSON_RPC_INVALID_REQUEST } });
  });
});

describe('KrakiMcpServer — initialize and tools/list', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await start();
  });
  afterEach(async () => {
    await fx.server.stop();
  });

  it('responds to initialize with declared protocol version + server info', async () => {
    const r = await rpc(fx.baseUrl, fx.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'test', version: '0' } },
    });
    expect(r.json).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'kraki', version: '0.0.0-test' },
        capabilities: { tools: { listChanged: false } },
      },
    });
  });

  it('returns tools/list including show_image', async () => {
    const r = await rpc(fx.baseUrl, fx.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const result = (r.json as { result: { tools: Array<{ name: string }> } }).result;
    expect(result.tools.map((t) => t.name)).toContain('show_image');
    const showImage = result.tools.find((t) => t.name === 'show_image');
    expect(showImage).toBeDefined();
    expect(showImage).toMatchObject({
      name: 'show_image',
      description: expect.any(String),
      inputSchema: { type: 'object', required: ['path'] },
    });
  });

  it('returns JSON-RPC method_not_found for unknown methods', async () => {
    const r = await rpc(fx.baseUrl, fx.token, { jsonrpc: '2.0', id: 3, method: 'totally/madeup' });
    expect(r.json).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      error: { code: JSON_RPC_METHOD_NOT_FOUND },
    });
  });

  it('initialize and tools/list work on both /mcp and /mcp/<sessionId>', async () => {
    const scoped = fx.credentialsForSession('any-sid');
    const onScoped = await rpc(scoped.url, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    expect((onScoped.json as { result: unknown }).result).toBeDefined();
  });
});

describe('KrakiMcpServer — tools/call session routing', () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await start(['valid-session']);
  });
  afterEach(async () => {
    await fx.server.stop();
  });

  it('rejects tools/call on /mcp (no session scope)', async () => {
    const r = await rpc(fx.baseUrl, fx.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_image', arguments: {} },
    });
    expect(r.json).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
  });

  it('does not accept a session token on the unscoped MCP endpoint', async () => {
    const scoped = fx.credentialsForSession('valid-session');
    const r = await rpc(fx.baseUrl, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(r.status).toBe(401);
  });

  it('does not accept the master token on a session-scoped MCP endpoint', async () => {
    const scoped = fx.credentialsForSession('valid-session');
    const r = await rpc(scoped.url, fx.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(r.status).toBe(401);
  });

  it('rejects tools/call for unknown sessionId', async () => {
    const scoped = fx.credentialsForSession('not-active');
    const r = await rpc(scoped.url, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_image', arguments: { path: '/tmp/x' } },
    });
    expect(r.json).toMatchObject({
      error: { code: JSON_RPC_INVALID_PARAMS, message: expect.stringContaining('Unknown') },
    });
  });

  it('accepts tools/call for active sessionId and routes to handler', async () => {
    const scoped = fx.credentialsForSession('valid-session');
    const r = await rpc(scoped.url, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_image', arguments: {} },
    });
    // missing path → handler returns isError result, NOT JSON-RPC error
    expect(r.json).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { isError: true, content: expect.any(Array) },
    });
  });

  it('rejects a session token presented for another session URL', async () => {
    fx.activeSessions.add('other-session');
    const valid = fx.credentialsForSession('valid-session');
    const other = fx.credentialsForSession('other-session');
    const r = await rpc(other.url, valid.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'show_image', arguments: {} },
    });
    expect(r.status).toBe(401);
  });

  it('rejects unknown tool name with method_not_found', async () => {
    const scoped = fx.credentialsForSession('valid-session');
    const r = await rpc(scoped.url, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'totally_made_up', arguments: {} },
    });
    expect(r.json).toMatchObject({ error: { code: JSON_RPC_METHOD_NOT_FOUND } });
  });

  it('rejects malformed params (missing name)', async () => {
    const scoped = fx.credentialsForSession('valid-session');
    const r = await rpc(scoped.url, scoped.bearerToken, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {},
    });
    expect(r.json).toMatchObject({ error: { code: JSON_RPC_INVALID_PARAMS } });
  });
});
