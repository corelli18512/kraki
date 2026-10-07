export const SELF_MANAGEMENT_DENIAL_REASON =
  'Denied by Kraki: kraki stop, restart, and update cannot run inside an agent session because they would terminate the tentacle hosting this session.';

/**
 * Plain-JS source of the matcher, shared with the materialized Pi extension
 * (which cannot import tentacle modules). Must not contain backticks or `${`.
 *
 * Matches only when `kraki` is the command being run — at the start of the
 * line or after `;`, `&&`, `||`, `|`, `(`, `$(` — optionally behind sudo/env/
 * nohup/VAR=value prefixes and a path, including `kraki.exe` on Windows, and
 * inside backticks or `sh -c "…"`. Text that merely mentions the
 * words (commit messages, grep patterns, docs) is not a command and passes.
 * Also blocks killing Kraki by name or by its PID file, and unloading its
 * launchd job. Best effort: an agent determined to stop it can; this only
 * stops the common accidents.
 */
export const SELF_MANAGEMENT_MATCHER_SOURCE = String.raw`function krakiIsSelfManagement(command) {
  if (typeof command !== "string") return false;
  // Also inside backticks and "sh -c '...'": those run it too. Plain
  // quotes don't count (commit messages mention commands).
  var start = "(?:^|[;&|\\n(\\x60]|\\$\\(|-c\\s+[\"'])\\s*";
  var prefix = "(?:(?:sudo|env|nohup|time|exec|command)\\s+(?:-\\S+\\s+)*|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
  var kraki = "(?:\\S*[\\\\/])?kraki(?:\\.exe)?\\s+(?:stop|restart|update)\\b";
  if (new RegExp(start + prefix + kraki, "i").test(command)) return true;
  if (/(?:^|[;&|\n(]|\$\()\s*(?:sudo\s+)?(?:pkill|killall)\b[^;&|\n]*\bkraki\b/i.test(command)) return true;
  if (/(?:^|[;&|\n(]|\$\()\s*taskkill\b[^;&|\n]*\bkraki/i.test(command)) return true;
  // Killing the daemon by its PID file, or unloading its launchd job.
  if (/\bkill\b[^;&|\n]*(?:daemon\.pid|\.kraki\b)/i.test(command)) return true;
  if (/\blaunchctl\s+(?:bootout|unload|remove|kill|stop|disable)\b[^;&|\n]*kraki/i.test(command)) return true;
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
