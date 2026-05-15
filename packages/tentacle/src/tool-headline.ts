/**
 * Compose a short user-facing preview ("headline") for a tool invocation.
 *
 * Lives on the tentacle so the per-tool display logic is in one place
 * — every client (web, future iOS) gets the same chip header without
 * duplicating switch statements.
 *
 * The headline is intentionally lossy:
 *  - Capped at MAX_HEADLINE characters (truncated with "…" suffix).
 *  - Shows the single most identity-defining arg (path for view/edit,
 *    command for bash, pattern for grep, etc.).
 *
 * The full args are shipped as a separate `argsRef` so the web can
 * lazily fetch and replace the headline with the full args once
 * resolved.
 */

export const MAX_HEADLINE = 200;

export function makeHeadline(toolName: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const raw = pickRaw(toolName, a);
  const s = typeof raw === 'string' ? raw : '';
  return truncate(s);
}

function pickRaw(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'bash':
    case 'shell': {
      const cmd = strField(args, 'command');
      return cmd ? `$ ${cmd}` : '';
    }
    case 'view':
    case 'read_file':
      return strField(args, 'path');
    case 'edit':
    case 'edit_file':
    case 'create':
    case 'create_file':
    case 'write_file':
    case 'write':
      return strField(args, 'path') || strField(args, 'file_path');
    case 'grep':
    case 'search': {
      const pattern = strField(args, 'pattern');
      return pattern ? `/${pattern}/` : '';
    }
    case 'glob':
      return strField(args, 'pattern');
    case 'fetch_url':
    case 'web_fetch':
      return strField(args, 'url');
    case 'mcp': {
      const server = strField(args, 'server') || '?';
      const tool = strField(args, 'tool') || '?';
      return `${server}/${tool}`;
    }
    case 'task': {
      const desc = strField(args, 'description') || strField(args, 'prompt');
      return desc;
    }
    case 'report_intent':
      return strField(args, 'intent');
    default:
      // Unknown tool: return empty. Why not pick the first string arg?
      //  - We can't tell whether an arbitrary field carries something
      //    sensitive (a token, password, API key). The headline goes
      //    inline in the message envelope (broadcast eagerly), unlike
      //    the args themselves which ship as a lazy ref.
      //  - The chip still shows the toolName, which is enough signal
      //    for an unknown tool. Users who want details can expand to
      //    fetch the full args.
      //  - When a new tool is observed in real sessions, add a case
      //    above with the right field.
      return '';
  }
}

function strField(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function truncate(s: string): string {
  if (s.length <= MAX_HEADLINE) return s;
  return s.slice(0, MAX_HEADLINE - 1) + '…';
}
