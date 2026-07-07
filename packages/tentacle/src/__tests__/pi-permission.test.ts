/**
 * Unit tests for the pi adapter's per-call permission mapping and policy.
 *
 * The permission-gate extension asks `ctx.ui.confirm(toolName, JSON.stringify(input))`
 * before every non-capability tool; the adapter applies `shouldAutoApprove`
 * (copilot-aligned) to decide silent-approve vs card, and turns a gated call into
 * a Kraki permission card via parsePiPermission. These tests pin the policy and
 * the tool-name → ToolArgs mapping.
 */

import { describe, it, expect } from 'vitest';
import { parsePiPermission, shouldAutoApprove } from '../adapters/pi.js';

describe('shouldAutoApprove — copilot-aligned policy', () => {
  it('execute / delegate auto-approve every tool', () => {
    for (const mode of ['execute', 'delegate'] as const) {
      expect(shouldAutoApprove(mode, 'bash', { command: 'rm -rf /' })).toBe(true);
      expect(shouldAutoApprove(mode, 'write', { path: '/etc/passwd' })).toBe(true);
    }
  });

  it('discuss auto-approves reads/shell but gates non-allowlisted file writes', () => {
    expect(shouldAutoApprove('discuss', 'bash', { command: 'ls' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'read', { path: '/x' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'write', { path: '/tmp/a.txt' })).toBe(false);
    expect(shouldAutoApprove('discuss', 'edit', { file_path: '/tmp/a.ts' })).toBe(false);
  });

  it('discuss allowlists plan.md writes', () => {
    expect(shouldAutoApprove('discuss', 'write', { path: '/repo/plan.md' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'write', { path: 'plan.md' })).toBe(true);
    expect(shouldAutoApprove('discuss', 'write', { path: '/repo/notplan.md' })).toBe(false);
  });

  it('safe gates every tool (including reads)', () => {
    expect(shouldAutoApprove('safe', 'bash', { command: 'ls' })).toBe(false);
    expect(shouldAutoApprove('safe', 'read', { path: '/x' })).toBe(false);
    expect(shouldAutoApprove('safe', 'write', { path: '/repo/plan.md' })).toBe(false);
  });
});

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
