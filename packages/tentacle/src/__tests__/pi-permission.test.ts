/**
 * Unit tests for the pi adapter's permission mapping + policy.
 *
 * The bridge extension asks `ctx.ui.confirm(toolName, JSON.stringify(input))`
 * before every tool; the adapter (1) applies `shouldAutoApprove` — the
 * copilot-aligned mode/kind policy — to decide silent-approve vs. card, and
 * (2) maps the request into a Kraki permission card via `parsePiPermission`.
 * These tests pin both.
 */

import { describe, it, expect } from 'vitest';
import { parsePiPermission, shouldAutoApprove } from '../adapters/pi.js';

describe('parsePiPermission — bash', () => {
  it('maps bash → shell with the command', () => {
    const r = parsePiPermission('bash', JSON.stringify({ command: 'rm -rf build' }));
    expect(r.toolArgs).toEqual({ toolName: 'shell', args: { command: 'rm -rf build' } });
    expect(r.description).toBe('rm -rf build');
  });

  it('falls back to a generic description when command is missing', () => {
    const r = parsePiPermission('bash', '{}');
    expect(r.toolArgs).toEqual({ toolName: 'shell', args: { command: '' } });
    expect(r.description).toBe('Run a shell command');
  });
});

describe('parsePiPermission — write', () => {
  it('maps write → write_file with path + content', () => {
    const r = parsePiPermission('write', JSON.stringify({ path: '/tmp/a.txt', content: 'hi' }));
    expect(r.toolArgs).toEqual({ toolName: 'write_file', args: { path: '/tmp/a.txt', content: 'hi' } });
    expect(r.description).toBe('Write /tmp/a.txt');
  });
});

describe('parsePiPermission — edit', () => {
  it('keeps the raw edit args and describes the path', () => {
    const input = { path: 'src/x.ts', oldText: 'a', newText: 'b' };
    const r = parsePiPermission('edit', JSON.stringify(input));
    expect(r.toolArgs).toEqual({ toolName: 'edit', args: input });
    expect(r.description).toBe('Edit src/x.ts');
  });
});

describe('parsePiPermission — unknown / malformed', () => {
  it('falls back to raw name + args for unknown tools', () => {
    const r = parsePiPermission('fetch', JSON.stringify({ url: 'https://x' }));
    expect(r.toolArgs).toEqual({ toolName: 'fetch', args: { url: 'https://x' } });
    expect(r.description).toBe('fetch');
  });

  it('tolerates malformed JSON without throwing', () => {
    const r = parsePiPermission('bash', 'not json');
    expect(r.toolArgs).toEqual({ toolName: 'shell', args: { command: '' } });
    expect(r.description).toBe('Run a shell command');
  });
});

describe('shouldAutoApprove — execute / delegate', () => {
  it('auto-approves every tool in execute mode', () => {
    expect(shouldAutoApprove('execute', 'bash', { command: 'rm -rf x' })).toBe(true);
    expect(shouldAutoApprove('execute', 'write', { path: '/etc/passwd' })).toBe(true);
    expect(shouldAutoApprove('execute', 'edit', { path: '/a' })).toBe(true);
  });

  it('auto-approves every tool in delegate mode', () => {
    expect(shouldAutoApprove('delegate', 'bash', {})).toBe(true);
    expect(shouldAutoApprove('delegate', 'write', { path: '/a' })).toBe(true);
  });
});

describe('shouldAutoApprove — discuss (gates only writes)', () => {
  it('auto-approves non-write tools (read/shell/grep/custom)', () => {
    expect(shouldAutoApprove('discuss', 'bash', { command: 'ls' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'read', { path: '/a' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'grep', {})).toBe(true);
    expect(shouldAutoApprove('discuss', 'find', {})).toBe(true);
    expect(shouldAutoApprove('discuss', 'fetch', {})).toBe(true);
  });

  it('gates non-allowlisted file writes', () => {
    expect(shouldAutoApprove('discuss', 'write', { path: '/tmp/a.txt' })).toBe(false);
    expect(shouldAutoApprove('discuss', 'edit', { path: 'src/index.ts' })).toBe(false);
  });

  it('allows writes to plan.md (root or nested)', () => {
    expect(shouldAutoApprove('discuss', 'write', { path: 'plan.md' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'write', { path: '/repo/plan.md' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'edit', { path: 'plan.md' })).toBe(true);
  });

  it('reads the write path from either path or file_path', () => {
    expect(shouldAutoApprove('discuss', 'write', { file_path: 'plan.md' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'write', { file_path: '/tmp/x' })).toBe(false);
  });
});

describe('shouldAutoApprove — safe (gates everything)', () => {
  it('gates every tool including reads', () => {
    expect(shouldAutoApprove('safe', 'read', { path: '/a' })).toBe(false);
    expect(shouldAutoApprove('safe', 'bash', { command: 'ls' })).toBe(false);
    expect(shouldAutoApprove('safe', 'write', { path: 'plan.md' })).toBe(false);
  });
});
