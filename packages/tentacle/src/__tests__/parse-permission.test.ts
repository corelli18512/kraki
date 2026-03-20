/**
 * Unit tests for parse-permission.ts — permission request parsing.
 *
 * Covers all known kinds (shell, write, read, url, mcp) plus unknown/missing.
 */

import { describe, it, expect } from 'vitest';
import { parsePermission } from '../parse-permission.js';
import type { PermissionRequest } from '@github/copilot-sdk';

// Helper to cast partial objects to PermissionRequest
const req = (obj: Record<string, unknown>): PermissionRequest => obj as PermissionRequest;

// ── shell ───────────────────────────────────────────────

describe('parsePermission — shell', () => {
  it('uses fullCommandText field (SDK v0.1.32+)', () => {
    const result = parsePermission(req({ kind: 'shell', fullCommandText: 'echo hello' }));
    expect(result.toolArgs).toEqual({ toolName: 'shell', args: { command: 'echo hello' } });
    expect(result.description).toBe('Run: echo hello');
  });

  it('uses command field', () => {
    const result = parsePermission(req({ kind: 'shell', command: 'npm test' }));
    expect(result.toolArgs).toEqual({ toolName: 'shell', args: { command: 'npm test' } });
    expect(result.description).toBe('Run: npm test');
  });

  it('falls back to cmd field', () => {
    const result = parsePermission(req({ kind: 'shell', cmd: 'ls -la' }));
    expect(result.toolArgs).toEqual({ toolName: 'shell', args: { command: 'ls -la' } });
  });

  it('falls back to script field', () => {
    const result = parsePermission(req({ kind: 'shell', script: 'echo hello' }));
    expect(result.toolArgs).toEqual({ toolName: 'shell', args: { command: 'echo hello' } });
  });

  it('returns empty command when all fields missing', () => {
    const result = parsePermission(req({ kind: 'shell' }));
    expect(result.toolArgs).toEqual({ toolName: 'shell', args: { command: '' } });
    expect(result.description).toBe('Run: ');
  });
});

// ── write ───────────────────────────────────────────────

describe('parsePermission — write', () => {
  it('uses fileName field', () => {
    const result = parsePermission(req({ kind: 'write', fileName: '/tmp/foo.txt' }));
    expect(result.toolArgs).toEqual({ toolName: 'write_file', args: { path: '/tmp/foo.txt', content: '' } });
  });

  it('falls back to path field', () => {
    const result = parsePermission(req({ kind: 'write', path: '/tmp/bar.txt' }));
    expect(result.toolArgs).toEqual({ toolName: 'write_file', args: { path: '/tmp/bar.txt', content: '' } });
  });

  it('uses intention in description when present', () => {
    const result = parsePermission(req({ kind: 'write', fileName: '/a.ts', intention: 'Create file' }));
    expect(result.description).toBe('Create file: /a.ts');
  });

  it('defaults description to "Write" when no intention', () => {
    const result = parsePermission(req({ kind: 'write', fileName: '/a.ts' }));
    expect(result.description).toBe('Write: /a.ts');
  });

  it('returns empty path when no fileName or path', () => {
    const result = parsePermission(req({ kind: 'write' }));
    expect(result.toolArgs).toEqual({ toolName: 'write_file', args: { path: '', content: '' } });
  });
});

// ── read ────────────────────────────────────────────────

describe('parsePermission — read', () => {
  it('uses fileName field', () => {
    const result = parsePermission(req({ kind: 'read', fileName: 'src/index.ts' }));
    expect(result.toolArgs).toEqual({ toolName: 'read_file', args: { path: 'src/index.ts' } });
  });

  it('falls back to path field', () => {
    const result = parsePermission(req({ kind: 'read', path: 'README.md' }));
    expect(result.toolArgs).toEqual({ toolName: 'read_file', args: { path: 'README.md' } });
  });

  it('returns empty path when no fileName or path', () => {
    const result = parsePermission(req({ kind: 'read' }));
    expect(result.toolArgs).toEqual({ toolName: 'read_file', args: { path: '' } });
  });

  it('uses intention in description when present', () => {
    const result = parsePermission(req({ kind: 'read', fileName: 'x.ts', intention: 'Inspect' }));
    expect(result.description).toBe('Inspect: x.ts');
  });
});

// ── url ─────────────────────────────────────────────────

describe('parsePermission — url', () => {
  it('uses url field', () => {
    const result = parsePermission(req({ kind: 'url', url: 'https://example.com' }));
    expect(result.toolArgs).toEqual({ toolName: 'fetch_url', args: { url: 'https://example.com' } });
    expect(result.description).toBe('Fetch: https://example.com');
  });

  it('returns empty url when field missing', () => {
    const result = parsePermission(req({ kind: 'url' }));
    expect(result.toolArgs).toEqual({ toolName: 'fetch_url', args: { url: '' } });
  });

  it('ignores intention for description (always Fetch:)', () => {
    const result = parsePermission(req({ kind: 'url', url: 'https://x.com', intention: 'Download' }));
    expect(result.description).toBe('Fetch: https://x.com');
  });
});

// ── mcp ─────────────────────────────────────────────────

describe('parsePermission — mcp', () => {
  it('uses serverName and toolName fields', () => {
    const result = parsePermission(req({ kind: 'mcp', serverName: 'my-server', toolName: 'my-tool' }));
    expect(result.toolArgs).toEqual({
      toolName: 'mcp',
      args: { server: 'my-server', tool: 'my-tool', params: {} },
    });
    expect(result.description).toBe('MCP tool: my-tool on my-server');
  });

  it('defaults to "unknown" when fields are missing', () => {
    const result = parsePermission(req({ kind: 'mcp' }));
    expect(result.toolArgs).toEqual({
      toolName: 'mcp',
      args: { server: 'unknown', tool: 'unknown', params: {} },
    });
  });

  it('defaults to "unknown" when fields are empty strings', () => {
    const result = parsePermission(req({ kind: 'mcp', serverName: '', toolName: '' }));
    expect(result.toolArgs).toEqual({
      toolName: 'mcp',
      args: { server: 'unknown', tool: 'unknown', params: {} },
    });
  });
});

// ── unknown kind ────────────────────────────────────────

describe('parsePermission — unknown kind', () => {
  it('uses intention as toolName when present', () => {
    const result = parsePermission(req({ kind: 'custom', intention: 'Do custom thing', extra: 'data' }));
    expect(result.toolArgs.toolName).toBe('Do custom thing');
    expect(result.description).toBe('Do custom thing');
  });

  it('uses kind as toolName when no intention', () => {
    const result = parsePermission(req({ kind: 'custom', extra: 'val' }));
    expect(result.toolArgs.toolName).toBe('custom');
  });

  it('passes extra fields in args (excluding kind and toolCallId)', () => {
    const result = parsePermission(req({
      kind: 'custom',
      toolCallId: 'tc-1',
      foo: 'bar',
      num: 42,
    }));
    expect(result.toolArgs.args).toEqual({ foo: 'bar', num: 42 });
  });

  it('produces JSON description when no intention', () => {
    const result = parsePermission(req({ kind: 'custom', data: 123 }));
    expect(result.description).toContain('custom');
    expect(result.description).toContain('123');
  });
});

// ── missing kind ────────────────────────────────────────

describe('parsePermission — missing kind', () => {
  it('defaults to unknown when kind is undefined', () => {
    const result = parsePermission(req({ foo: 'bar' }));
    // kind defaults to 'unknown', falls into default branch
    expect(result.toolArgs.toolName).toBe('unknown');
  });

  it('uses intention when kind is missing but intention is present', () => {
    const result = parsePermission(req({ intention: 'Some intent' }));
    expect(result.toolArgs.toolName).toBe('Some intent');
    expect(result.description).toBe('Some intent');
  });
});
