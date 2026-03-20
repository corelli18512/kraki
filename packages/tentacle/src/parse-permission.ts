/**
 * Parse raw Copilot SDK PermissionRequest into human-readable fields.
 *
 * Shared utility so future adapters (Claude, Codex) can reuse the same logic.
 * Returns proper @kraki/protocol ToolArgs for end-to-end type safety.
 */

import type { PermissionRequest } from '@github/copilot-sdk';
import type { ToolArgs } from '@kraki/protocol';

/** Normalised representation of a permission request with typed tool args. */
export interface ParsedPermission {
  toolArgs: ToolArgs;
  description: string;
}

/**
 * Parse the raw SDK PermissionRequest into typed protocol fields.
 *
 * The Copilot SDK sends permission requests like:
 *   { kind: "write", fileName: "/tmp/foo.txt", intention: "Create file", diff: "..." }
 *   { kind: "shell", command: "npm test" }
 *   { kind: "read",  fileName: "src/index.ts" }
 *   { kind: "url",   url: "https://example.com" }
 *
 * We normalise these into typed ToolArgs + a human-readable description.
 */
export function parsePermission(req: PermissionRequest): ParsedPermission {
  const kind: string = req.kind ?? 'unknown';
  const intention = (req.intention as string | undefined) ?? '';

  switch (kind) {
    case 'shell': {
      const command = ((req.fullCommandText ?? req.command ?? req.cmd ?? req.script ?? '') as string);
      return {
        toolArgs: { toolName: 'shell', args: { command } },
        description: `Run: ${command}`,
      };
    }

    case 'write': {
      const path = ((req.fileName ?? req.path ?? '') as string);
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: '' } },
        description: `${intention || 'Write'}: ${path}`,
      };
    }

    case 'read': {
      const path = ((req.fileName ?? req.path ?? '') as string);
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `${intention || 'Read'}: ${path}`,
      };
    }

    case 'url': {
      const url = ((req.url ?? '') as string);
      return {
        toolArgs: { toolName: 'fetch_url', args: { url } },
        description: `Fetch: ${url}`,
      };
    }

    case 'mcp': {
      const server = ((req.serverName ?? '') as string) || 'unknown';
      const tool = ((req.toolName ?? '') as string) || 'unknown';
      return {
        toolArgs: { toolName: 'mcp', args: { server, tool, params: {} } },
        description: `MCP tool: ${tool} on ${server}`,
      };
    }

    default: {
      const { kind: _, toolCallId: __, ...rest } = req;
      return {
        toolArgs: { toolName: intention || kind, args: rest as Record<string, unknown> },
        description: intention || `${kind}: ${JSON.stringify(rest).slice(0, 200)}`,
      };
    }
  }
}
