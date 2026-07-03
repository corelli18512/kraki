/**
 * Unit tests for the pi adapter's per-call permission mapping.
 *
 * The permission-gate extension asks `ctx.ui.confirm(toolName, JSON.stringify(input))`
 * before every mutating tool; the adapter turns that into a Kraki permission
 * card via parsePiPermission. These tests pin the tool-name → ToolArgs mapping
 * and the description fallbacks.
 */

import { describe, it, expect } from 'vitest';
import { parsePiPermission } from '../adapters/pi.js';

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
