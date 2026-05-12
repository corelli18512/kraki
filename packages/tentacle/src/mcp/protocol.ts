/**
 * Minimal Model Context Protocol (MCP) types used by the Kraki MCP server.
 *
 * We implement only the surface we need:
 *   - JSON-RPC 2.0 envelope
 *   - `initialize` handshake
 *   - `tools/list` + `tools/call`
 *
 * Prompts, resources, sampling, completions, etc. are out of scope for v1.
 */

// ── JSON-RPC 2.0 envelope ───────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ── MCP-specific ────────────────────────────────────────────────────────

/** MCP protocol version we declare during initialize. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpInitializeParams {
  protocolVersion: string;
  capabilities?: Record<string, unknown>;
  clientInfo?: { name: string; version: string };
}

export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: { tools?: { listChanged?: boolean } };
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolsListResult {
  tools: McpToolDefinition[];
}

export interface McpToolsCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}
