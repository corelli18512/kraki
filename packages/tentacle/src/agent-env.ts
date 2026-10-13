/**
 * Environment for agent runtimes (Claude, Codex, Copilot, Pi) and the commands
 * they run in the user's projects.
 *
 * The daemon runs with variables that describe Kraki itself: `NODE_ENV=production`
 * and `LOG_LEVEL` (set by the launcher for the worker), and the supervisor /
 * Mac-app markers. Inherited by an agent they change the user's tools: with
 * `NODE_ENV=production`, `npm install` skips devDependencies and test/build
 * scripts behave as in production. Drop them; everything else (the user's
 * login-shell PATH, credentials, `KRAKI_HOME`) is passed through.
 */
export const DAEMON_ONLY_ENV = ['NODE_ENV', 'LOG_LEVEL', 'KRAKI_SUPERVISE', 'KRAKI_SUPERVISED', 'KRAKI_MANAGED_BY', 'KRAKI_META_FILE'] as const;

export function agentEnv(
  extra: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of DAEMON_ONLY_ENV) delete env[key];
  return { ...env, ...extra };
}
