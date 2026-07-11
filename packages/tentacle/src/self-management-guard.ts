export const SELF_MANAGEMENT_DENIAL_REASON =
  'Denied by Kraki: kraki stop, restart, and update cannot run inside an agent session because they would terminate the tentacle hosting this session.';

const SELF_MANAGEMENT_COMMAND = /\bkraki\s+(?:stop|restart|update)\b/i;

/** Return true when a shell command can stop or replace the hosting tentacle. */
export function isKrakiSelfManagementCommand(command: unknown): boolean {
  return typeof command === 'string' && SELF_MANAGEMENT_COMMAND.test(command);
}

export function shellCommandFromInput(input: Record<string, unknown>): string {
  for (const key of ['command', 'fullCommandText', 'cmd', 'script']) {
    if (typeof input[key] === 'string') return input[key];
  }
  return '';
}
