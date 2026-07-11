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
  ])('blocks %s', (command) => {
    expect(isKrakiSelfManagementCommand(command)).toBe(true);
  });

  it.each([
    'kraki status',
    'kraki logs -f',
    'echo "run kraki later"',
    'echo kraki stopwatch',
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
