/** Codex thread items → Kraki tool calls and results (shell, file changes, MCP, Kraki's dynamic tools). */



/** Tools hosted by this adapter and exposed to Codex via `dynamicTools`. */
export const KRAKI_DYNAMIC_TOOLS = new Set(['ask_user', 'show_image', 'kraki_get_mode']);

/** First line of a prompt, capped — a task label, never the full prompt. */
export function oneLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Codex runs every command through a login shell (`/bin/zsh -lc '<cmd>'`).
 *  Show the inner command on cards and step headlines, like Codex's own UI.
 *  Only exact single-argument wrappers are unwrapped; anything else is kept. */
export function unwrapShellCommand(command: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!m) return command;
  const arg = m[1].trim();
  if (arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'")) {
    const body = arg.slice(1, -1);
    // Only '\'' escapes are legal inside a POSIX single-quoted word.
    if (body.replace(/'\\''/g, '').includes("'")) return command;
    return body.replace(/'\\''/g, "'");
  }
  if (arg.length >= 2 && arg.startsWith('"') && arg.endsWith('"')) {
    const body = arg.slice(1, -1);
    if (/(^|[^\\])"/.test(body)) return command;
    return body.replace(/\\(["\\$`])/g, '$1');
  }
  return command;
}

export function fileChangePaths(item: Record<string, unknown> | undefined): string[] {
  const changes = item?.changes;
  if (!Array.isArray(changes)) return [];
  return (changes as Array<{ path?: unknown }>).map((c) => str(c?.path)).filter(Boolean);
}

/** Extract readable text from an MCP tool-call result. */
export function mcpResultText(item: Record<string, unknown>): string {
  const error = item.error as { message?: string } | null | undefined;
  if (error?.message) return error.message;
  const result = item.result as { content?: unknown[] } | null | undefined;
  if (!Array.isArray(result?.content)) return '';
  return result!.content
    .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? str((c as { text?: unknown }).text) : ''))
    .filter(Boolean)
    .join('\n');
}

/** Codex thread item → Kraki tool step (name + args), or null if not a tool. */
export function codexItemTool(item: Record<string, unknown>): { toolName: string; args: Record<string, unknown> } | null {
  switch (item.type) {
    case 'commandExecution':
      return { toolName: 'shell', args: { command: unwrapShellCommand(str(item.command)), cwd: str(item.cwd) } };
    case 'fileChange': {
      const paths = fileChangePaths(item);
      const changes = Array.isArray(item.changes) ? item.changes as Array<{ diff?: string }> : [];
      return { toolName: 'edit', args: { path: paths.join(', '), paths, diff: changes.map((c) => str(c.diff)).join('\n') } };
    }
    case 'mcpToolCall': {
      const args = (item.arguments && typeof item.arguments === 'object' ? item.arguments : {}) as Record<string, unknown>;
      return { toolName: 'mcp', args: { server: str(item.server), tool: str(item.tool), params: args } };
    }
    case 'webSearch':
      return { toolName: 'web_search', args: { query: str(item.query) } };
    case 'imageView':
      return { toolName: 'view', args: { path: str(item.path) } };
    case 'dynamicToolCall':
      return KRAKI_DYNAMIC_TOOLS.has(str(item.tool)) ? null : { toolName: str(item.tool) || 'tool', args: {} };
    default:
      return null;
  }
}

/** Codex completed thread item → tool result, or null if not a tool. */
export function codexItemResult(item: Record<string, unknown>): { result: string; success: boolean } | null {
  switch (item.type) {
    case 'commandExecution':
      return { result: str(item.aggregatedOutput), success: item.status === 'completed' && (item.exitCode === 0 || item.exitCode == null) };
    case 'fileChange': {
      const paths = fileChangePaths(item);
      const ok = item.status === 'completed';
      return { result: ok ? `Updated ${paths.join(', ')}` : `File change ${str(item.status)}`, success: ok };
    }
    case 'mcpToolCall':
      return { result: mcpResultText(item), success: item.status === 'completed' };
    case 'webSearch':
    case 'imageView':
      return { result: '', success: true };
    case 'dynamicToolCall':
      return KRAKI_DYNAMIC_TOOLS.has(str(item.tool)) ? null : { result: '', success: item.success === true };
    default:
      return null;
  }
}
