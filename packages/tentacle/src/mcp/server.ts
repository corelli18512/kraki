import { randomBytes } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { createLogger } from '../logger.js';
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  MCP_PROTOCOL_VERSION,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
  type McpInitializeResult,
  type McpToolResult,
  type McpToolsCallParams,
  type McpToolsListResult,
} from './protocol.js';
import { ToolRegistry, type RegisteredTool } from './tools/index.js';
import { showImageTool } from './tools/show-image.js';

const logger = createLogger('mcp-server');

const MAX_BODY_BYTES = 16 * 1024 * 1024; // generous, since show_image can return ~8 MB
const SERVER_NAME = 'kraki';

export interface KrakiMcpServerOptions {
  /** Server semver — surfaced in `initialize` response. */
  version: string;
  /**
   * Predicate used to validate the sessionId encoded in the URL path of
   * `tools/call` requests. Other methods (`initialize`, `tools/list`) do not
   * require it.
   */
  isSessionActive: (sessionId: string) => boolean;
}

export interface KrakiMcpServerStartResult {
  /** Base URL up to (but excluding) the per-session segment. */
  baseUrl: string;
  /** Bearer token clients must send in `Authorization`. */
  bearerToken: string;
  /** Helper: build the per-session URL the SDK should connect to. */
  urlForSession(sessionId: string): string;
  /** Bound port (resolved after listen). */
  port: number;
}

/**
 * Tentacle-hosted MCP server.
 *
 * - Binds to 127.0.0.1 on a kernel-assigned port (no LAN exposure)
 * - Requires `Authorization: Bearer <token>` on every request
 * - Routes requests under `/mcp/<sessionId>`; the sessionId is injected into
 *   tool-call context. `initialize` and `tools/list` accept a `/mcp` URL too.
 */
export class KrakiMcpServer {
  private readonly registry = new ToolRegistry();
  private readonly token: string = randomBytes(32).toString('hex');
  private readonly version: string;
  private readonly isSessionActive: (sessionId: string) => boolean;
  private server: HttpServer | null = null;
  private port = 0;

  constructor(options: KrakiMcpServerOptions, tools: readonly RegisteredTool[] = [showImageTool]) {
    this.version = options.version;
    this.isSessionActive = options.isSessionActive;
    for (const tool of tools) this.registry.register(tool);
  }

  /** Expose registered tools (test helper). */
  get tools(): ToolRegistry {
    return this.registry;
  }

  /** Bearer token (test helper). */
  get bearerToken(): string {
    return this.token;
  }

  async start(): Promise<KrakiMcpServerStartResult> {
    if (this.server) throw new Error('KrakiMcpServer already started');

    const server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'unhandled error in MCP request');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    logger.info({ port: this.port, tools: this.registry.size() }, 'MCP server listening');

    const baseUrl = `http://127.0.0.1:${this.port}/mcp`;
    return {
      baseUrl,
      bearerToken: this.token,
      port: this.port,
      urlForSession: (sessionId) => `${baseUrl}/${encodeURIComponent(sessionId)}`,
    };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  // ── Request handling ──────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', 'allow': 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    if (!this.checkAuth(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const sessionId = this.extractSessionId(req.url ?? '');
    // sessionId === null means malformed path; sessionId === '' means `/mcp` with no segment
    if (sessionId === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      logger.warn({ err }, 'failed to read request body');
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload_too_large' }));
      return;
    }

    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(null, JSON_RPC_PARSE_ERROR, 'Parse error')));
      return;
    }

    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rpcError(rpc?.id ?? null, JSON_RPC_INVALID_REQUEST, 'Invalid request')));
      return;
    }

    const response = await this.dispatch(rpc, sessionId);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private checkAuth(req: IncomingMessage): boolean {
    const header = req.headers['authorization'];
    if (typeof header !== 'string') return false;
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length).trim();
    // constant-time-ish compare (length differs → reject; otherwise compare)
    if (presented.length !== this.token.length) return false;
    let diff = 0;
    for (let i = 0; i < presented.length; i++) {
      diff |= presented.charCodeAt(i) ^ this.token.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * Extract the per-session segment from `/mcp` or `/mcp/<sessionId>`.
   * Returns:
   *   - the sessionId string for `/mcp/<sessionId>`
   *   - '' for `/mcp` (allowed for initialize/tools/list)
   *   - null for any other URL shape (caller responds 404)
   */
  private extractSessionId(rawUrl: string): string | null {
    const qIdx = rawUrl.indexOf('?');
    const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    if (pathname === '/mcp' || pathname === '/mcp/') return '';
    if (!pathname.startsWith('/mcp/')) return null;
    const rest = pathname.slice('/mcp/'.length);
    if (rest.length === 0 || rest.includes('/')) return null;
    try {
      return decodeURIComponent(rest);
    } catch {
      return null;
    }
  }

  private async dispatch(rpc: JsonRpcRequest, sessionId: string): Promise<JsonRpcResponse> {
    try {
      switch (rpc.method) {
        case 'initialize':
          return rpcOk(rpc.id, this.handleInitialize());
        case 'notifications/initialized':
          // No-op notification; per JSON-RPC, notifications have no `id`. The
          // MCP spec sends this after initialize; we accept and respond with
          // an empty success for any request form, but it usually arrives as a
          // notification (no id). For notifications we still must not send a
          // response per JSON-RPC; but Copilot SDK is happy with an empty 200.
          return rpcOk(rpc.id, {});
        case 'tools/list':
          return rpcOk(rpc.id, this.handleToolsList());
        case 'tools/call':
          return await this.handleToolsCall(rpc, sessionId);
        default:
          return rpcError(rpc.id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${rpc.method}`);
      }
    } catch (err) {
      logger.error({ err, method: rpc.method }, 'dispatch error');
      return rpcError(
        rpc.id,
        JSON_RPC_INTERNAL_ERROR,
        `Internal error: ${(err as Error).message}`,
      );
    }
  }

  private handleInitialize(): McpInitializeResult {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: SERVER_NAME, version: this.version },
      capabilities: { tools: { listChanged: false } },
    };
  }

  private handleToolsList(): McpToolsListResult {
    return { tools: this.registry.list() };
  }

  private async handleToolsCall(
    rpc: JsonRpcRequest,
    sessionId: string,
  ): Promise<JsonRpcResponse> {
    if (sessionId === '') {
      return rpcError(rpc.id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a session-scoped URL (/mcp/<sessionId>)');
    }
    if (!this.isSessionActive(sessionId)) {
      return rpcError(rpc.id, JSON_RPC_INVALID_PARAMS, `Unknown or inactive session: ${sessionId}`);
    }

    const params = rpc.params as McpToolsCallParams | undefined;
    if (!params || typeof params.name !== 'string') {
      return rpcError(rpc.id, JSON_RPC_INVALID_PARAMS, 'tools/call requires { name, arguments? }');
    }

    const tool = this.registry.get(params.name);
    if (!tool) {
      return rpcError(rpc.id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${params.name}`);
    }

    const args = (params.arguments ?? {}) as Record<string, unknown>;

    let result: McpToolResult;
    try {
      result = await tool.handler(args, { sessionId });
    } catch (err) {
      logger.error({ err, tool: params.name }, 'tool handler threw');
      result = {
        content: [{ type: 'text', text: `Tool execution failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
    return rpcOk(rpc.id, result);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function rpcOk(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id: JsonRpcRequest['id'],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
