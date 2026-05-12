import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KrakiMcpServer } from '../server.js';
import { MCP_PROTOCOL_VERSION, type JsonRpcResponse } from '../protocol.js';

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

interface CallResp {
  status: number;
  body: JsonRpcResponse;
}

async function post(url: string, token: string, body: unknown): Promise<CallResp> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as JsonRpcResponse };
}

describe('Kraki MCP — end-to-end show_image over HTTP', () => {
  let server: KrakiMcpServer;
  let baseUrl: string;
  let token: string;
  let urlForSession: (s: string) => string;
  let activeSessions: Set<string>;
  let tmp: string;

  beforeEach(async () => {
    activeSessions = new Set(['sess-A']);
    server = new KrakiMcpServer({
      version: 'e2e',
      isSessionActive: (id) => activeSessions.has(id),
    });
    const info = await server.start();
    baseUrl = info.baseUrl;
    token = info.bearerToken;
    urlForSession = info.urlForSession;
    tmp = mkdtempSync(join(tmpdir(), 'kraki-mcp-e2e-'));
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('full lifecycle: initialize → tools/list → tools/call(show_image)', async () => {
    // 1) initialize
    const init = await post(baseUrl, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: MCP_PROTOCOL_VERSION, clientInfo: { name: 'e2e', version: '0' } },
    });
    expect(init.body).toMatchObject({
      result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: 'kraki' } },
    });

    // 2) tools/list
    const list = await post(baseUrl, token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(['show_image']);

    // 3) tools/call against the per-session URL with a real PNG file
    const png = join(tmp, 'hello.png');
    writeFileSync(png, Buffer.from(PNG_1X1, 'base64'));

    const call = await post(urlForSession('sess-A'), token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'show_image', arguments: { path: png, caption: 'hi' } },
    });
    const result = (call.body as { result: { content: Array<Record<string, unknown>>; isError?: boolean } }).result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: PNG_1X1,
    });
    expect(result.content[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Caption: hi'),
    });
  });
});
