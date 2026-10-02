export const SELF_MANAGEMENT_DENIAL_REASON =
  'Denied by Kraki: kraki stop, restart, and update cannot run inside an agent session because they would terminate the tentacle hosting this session.';

/**
 * Plain-JS source of the matcher, shared with the materialized Pi extension
 * (which cannot import tentacle modules). Must not contain backticks or `${`.
 *
 * Matches only when `kraki` is the command being run — at the start of the
 * line or after `;`, `&&`, `||`, `|`, `(`, `$(` — optionally behind sudo/env/
 * nohup/VAR=value prefixes and a path, including `kraki.exe` on Windows. Text
 * that merely mentions the words (commit messages, grep patterns, docs) is
 * not a command and passes. Also blocks killing Kraki by name.
 */
export const SELF_MANAGEMENT_MATCHER_SOURCE = String.raw`function krakiIsSelfManagement(command) {
  if (typeof command !== "string") return false;
  var start = "(?:^|[;&|\\n(]|\\$\\()\\s*";
  var prefix = "(?:(?:sudo|env|nohup|time|exec|command)\\s+(?:-\\S+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
  var kraki = "(?:\\S*[\\\\/])?kraki(?:\\.exe)?\\s+(?:stop|restart|update)\\b";
  if (new RegExp(start + prefix + kraki, "i").test(command)) return true;
  if (/(?:^|[;&|\n(]|\$\()\s*(?:sudo\s+)?(?:pkill|killall)\b[^;&|\n]*\bkraki\b/i.test(command)) return true;
  if (/(?:^|[;&|\n(]|\$\()\s*taskkill\b[^;&|\n]*\bkraki/i.test(command)) return true;
  return false;
}`;

const matcher = new Function(`${SELF_MANAGEMENT_MATCHER_SOURCE}\nreturn krakiIsSelfManagement;`)() as (command: unknown) => boolean;

/** Return true when a shell command would stop or replace the hosting tentacle. */
export function isKrakiSelfManagementCommand(command: unknown): boolean {
  return matcher(command);
}

export function shellCommandFromInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'fullCommandText', 'cmd', 'script']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}
