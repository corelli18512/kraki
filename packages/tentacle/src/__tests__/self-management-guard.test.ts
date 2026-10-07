import { describe, expect, it } from 'vitest';
import {
  isKrakiSelfManagementCommand,
  shellCommandFromInput,
} from '../self-management-guard.js';

describe('isKrakiSelfManagementCommand', () => {
  it.each([
    'kraki stop',
    'kraki restart',
    'kraki update',
    'sudo kraki stop',
    '/Users/test/.local/bin/kraki restart',
    'echo before && kraki update',
    'env FOO=bar kraki stop --force',
    'kraki.exe stop',
    'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Kraki\\\\kraki.exe restart',
    'cd /tmp; kraki restart',
    'npm test || kraki update',
    'pkill -f kraki',
    'taskkill /F /IM kraki.exe',
    'bash -c "kraki stop"',
    "sh -c 'kraki restart'",
    'echo `kraki update`',
    'kill $(cat ~/.kraki/daemon.pid)',
    'kill -9 `cat /Users/me/.kraki/daemon.pid`',
    'launchctl bootout gui/501/chat.kraki.tentacle',
  ])('blocks %s', (command) => {
    expect(isKrakiSelfManagementCommand(command)).toBe(true);
  });

  it.each([
    'kraki status',
    'kraki logs -f',
    'echo "run kraki later"',
    'echo kraki stopwatch',
    'git commit -m "fix kraki restart hang"',
    'grep -rn "kraki stop" docs/',
    'echo "run kraki update to upgrade" >> README.md',
    "cat > notes.md <<'EOF'\\nThe guard blocks kraki restart.\\nEOF",
    'kill %1',
    'launchctl list | grep kraki',
  ])('allows %s', (command) => {
    expect(isKrakiSelfManagementCommand(command)).toBe(false);
  });
});

describe('shellCommandFromInput', () => {
  it('reads command shapes used by the supported adapters', () => {
    expect(shellCommandFromInput({ command: 'one' })).toBe('one');
    expect(shellCommandFromInput({ fullCommandText: 'two' })).toBe('two');
    expect(shellCommandFromInput({ cmd: 'three' })).toBe('three');
    expect(shellCommandFromInput({ script: 'four' })).toBe('four');
  });
});
