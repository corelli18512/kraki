/** Claude tool calls → Kraki tool kinds, arguments and diffs. */

import { type ToolKind } from './permission-policy.js';

/**
 * Map Claude SDK tool names to Kraki tool kinds (for permission tracking).
 * Returns the general category for "Always Allow" grouping.
 */
export function toolNameToKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return 'shell';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'write';
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'read';
    case 'WebSearch':
    case 'WebFetch':
      return 'url';
    case 'TodoWrite':
    case 'Task':
    case 'Agent':
    case 'ExitPlanMode':
      return 'meta';
    default:
      return toolName.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

/** Minimal unified-style diff of Claude Edit/MultiEdit replacements. */
export function editsToDiff(path: string, edits: Array<{ old_string?: unknown; new_string?: unknown }>): string {
  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const edit of edits) {
    const before = typeof edit.old_string === 'string' ? edit.old_string : '';
    const after = typeof edit.new_string === 'string' ? edit.new_string : '';
    lines.push('@@');
    if (before) for (const l of before.split('\n')) lines.push(`-${l}`);
    if (after) for (const l of after.split('\n')) lines.push(`+${l}`);
  }
  const diff = lines.join('\n');
  return diff.length > 16_000 ? `${diff.slice(0, 16_000)}\n… (truncated)` : diff;
}

/**
 * Parse a Claude SDK tool call into Kraki protocol ToolArgs + description.
 */
export function parseClaudeToolCall(toolName: string, input: Record<string, unknown>): {
  toolArgs: import('@kraki/protocol').ToolArgs;
  description: string;
} {
  switch (toolName) {
    case 'Bash': {
      const command = (input.command ?? input.cmd ?? '') as string;
      return {
        toolArgs: { toolName: 'shell', args: { command } },
        description: `Run: ${command}`,
      };
    }
    case 'Write': {
      const path = (input.file_path ?? input.path ?? '') as string;
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: (input.content ?? '') as string } },
        description: `Write: ${path}`,
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = (input.file_path ?? input.path ?? '') as string;
      // Show what changes, like Codex/Copilot cards do, so a `safe` approval
      // is not blind. Same `content` slot the clients already render.
      const edits = toolName === 'MultiEdit' && Array.isArray(input.edits)
        ? input.edits as Array<{ old_string?: unknown; new_string?: unknown }>
        : [{ old_string: input.old_string, new_string: input.new_string }];
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: editsToDiff(path, edits) } },
        description: `Edit: ${path}`,
      };
    }
    case 'Read': {
      const path = (input.file_path ?? input.path ?? '') as string;
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `Read: ${path}`,
      };
    }
    case 'Glob':
    case 'Grep':
    case 'LS': {
      const path = (input.path ?? input.pattern ?? '') as string;
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `${toolName}: ${path}`,
      };
    }
    case 'WebSearch':
    case 'WebFetch': {
      const url = (input.url ?? input.query ?? '') as string;
      return {
        toolArgs: { toolName: 'fetch_url', args: { url } },
        description: `${toolName}: ${url}`,
      };
    }
    default: {
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] ?? 'unknown';
        const tool = parts.slice(2).join('__') || 'unknown';
        return {
          toolArgs: { toolName: 'mcp', args: { server, tool, params: input } },
          description: `MCP tool: ${tool} on ${server}`,
        };
      }
      return {
        toolArgs: { toolName, args: input },
        description: `${toolName}: ${JSON.stringify(input).slice(0, 200)}`,
      };
    }
  }
}
