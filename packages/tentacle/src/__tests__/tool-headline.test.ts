import { describe, it, expect } from 'vitest';
import { makeHeadline, MAX_HEADLINE } from '../tool-headline.js';

describe('makeHeadline', () => {
  it('extracts shell command with $ prefix', () => {
    expect(makeHeadline('bash', { command: 'echo hi' })).toBe('$ echo hi');
    expect(makeHeadline('shell', { command: 'ls -la' })).toBe('$ ls -la');
  });

  it('extracts view/read path', () => {
    expect(makeHeadline('view', { path: '/foo.ts' })).toBe('/foo.ts');
    expect(makeHeadline('read_file', { path: '/x.md' })).toBe('/x.md');
  });

  it('extracts edit/create/write path', () => {
    expect(makeHeadline('edit', { path: '/a.ts', old_str: 'x', new_str: 'y' })).toBe('/a.ts');
    expect(makeHeadline('create', { path: '/b.ts', file_text: 'huge content...' })).toBe('/b.ts');
    expect(makeHeadline('write_file', { path: '/c.ts', content: 'huge content...' })).toBe('/c.ts');
    expect(makeHeadline('edit_file', { file_path: '/d.ts' })).toBe('/d.ts');
  });

  it('extracts grep/search pattern wrapped in slashes', () => {
    expect(makeHeadline('grep', { pattern: 'foo.*bar' })).toBe('/foo.*bar/');
    expect(makeHeadline('search', { pattern: 'TODO' })).toBe('/TODO/');
  });

  it('extracts glob pattern as-is', () => {
    expect(makeHeadline('glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('extracts fetch_url url', () => {
    expect(makeHeadline('fetch_url', { url: 'https://example.com' })).toBe('https://example.com');
    expect(makeHeadline('web_fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('formats mcp tool as server/tool', () => {
    expect(makeHeadline('mcp', { server: 'kraki', tool: 'show_image' })).toBe('kraki/show_image');
    expect(makeHeadline('mcp', { server: 'kraki' })).toBe('kraki/?');
    expect(makeHeadline('mcp', {})).toBe('?/?');
  });

  it('falls back to first short string for unknown tools', () => {
    expect(makeHeadline('weird_tool', { foo: 'bar', baz: 42 })).toBe('bar');
    expect(makeHeadline('weird_tool', { huge: 'x'.repeat(1000) })).toBe('');
    expect(makeHeadline('weird_tool', {})).toBe('');
  });

  it('returns empty for missing required field', () => {
    expect(makeHeadline('bash', {})).toBe('');
    expect(makeHeadline('view', {})).toBe('');
    expect(makeHeadline('view', undefined)).toBe('');
  });

  it('truncates at MAX_HEADLINE with ellipsis', () => {
    const longCmd = 'x'.repeat(MAX_HEADLINE + 50);
    const result = makeHeadline('bash', { command: longCmd });
    expect(result.length).toBe(MAX_HEADLINE);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('$ x')).toBe(true);
  });

  it('does not truncate exactly at MAX_HEADLINE', () => {
    const exact = 'x'.repeat(MAX_HEADLINE);
    expect(makeHeadline('view', { path: exact })).toBe(exact);
  });

  it('handles non-string field values gracefully', () => {
    expect(makeHeadline('bash', { command: 42 })).toBe('');
    expect(makeHeadline('view', { path: null })).toBe('');
  });
});
