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
 *
 * Note: The SDK PermissionRequest type only declares `kind` and `toolCallId`,
 * but the runtime objects carry additional fields per-kind (fileName, command, etc.).
 */
export function parsePermission(req: PermissionRequest): ParsedPermission {
  // The runtime request carries extra fields beyond the TS type
  const r = req as PermissionRequest & Record<string, unknown>;
  const kind: string = r.kind ?? 'unknown';
  const intention = (r.intention as string | undefined) ?? '';

  switch (kind) {
    case 'shell': {
      const command = ((r.fullCommandText ?? r.command ?? r.cmd ?? r.script ?? '') as string);
      return {
        toolArgs: { toolName: 'shell', args: { command } },
        description: `Run: ${command}`,
      };
    }

    case 'write': {
      const path = ((r.fileName ?? r.path ?? '') as string);
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: '' } },
        description: `${intention || 'Write'}: ${path}`,
      };
    }

    case 'read': {
      const path = ((r.fileName ?? r.path ?? '') as string);
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `${intention || 'Read'}: ${path}`,
      };
    }

    case 'url': {
      const url = ((r.url ?? '') as string);
      return {
        toolArgs: { toolName: 'fetch_url', args: { url } },
        description: `Fetch: ${url}`,
      };
    }

    case 'mcp': {
      const server = ((r.serverName ?? '') as string) || 'unknown';
      const tool = ((r.toolName ?? '') as string) || 'unknown';
      return {
        toolArgs: { toolName: 'mcp', args: { server, tool, params: {} } },
        description: `MCP tool: ${tool} on ${server}`,
      };
    }

    case 'memory': {
      const subject = ((r.subject ?? '') as string);
      const fact = ((r.fact ?? '') as string);
      return {
        toolArgs: { toolName: 'memory', args: { subject, fact } },
        description: `Memory: ${subject}`,
      };
    }

    case 'hook': {
      return {
        toolArgs: { toolName: intention || 'hook', args: {} },
        description: intention || 'Hook execution',
      };
    }

    default: {
      const { kind: _, toolCallId: __, ...rest } = r;
      return {
        toolArgs: { toolName: intention || kind, args: rest as Record<string, unknown> },
        description: intention || `${kind}: ${JSON.stringify(rest).slice(0, 200)}`,
      };
    }
  }
}
