import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatToolArguments, toolHeadline, ToolActivity } from './ToolActivity';

const attachment = vi.hoisted(() => ({ status: 'ready', text: '{"timeout":30,"command":"seq 1 400"}', error: null }));
vi.mock('../../hooks/useAttachment', () => ({ useAttachmentText: () => attachment }));
beforeEach(() => { attachment.text = '{"timeout":30,"command":"seq 1 400"}'; });

describe('ToolActivity — native arguments', () => {
  it('preserves timeout and all edit keys in sorted key/value text', () => {
    expect(formatToolArguments({ timeout: 30, command: 'seq 1 400' })).toBe('command: seq 1 400\ntimeout: 30');
    expect(formatToolArguments({ old_str: 'before', new_str: 'after', path: 'a' })).toBe('new_str: after\nold_str: before\npath: a');
    expect(formatToolArguments({ edits: [{ oldText: 'before', newText: 'after', meta: { z: 1, a: null } }], none: null })).toBe('edits: [{"meta":{"a":null,"z":1},"newText":"after","oldText":"before"}]\nnone: null');
  });
  it('shows raw edit arguments, not a diff viewer', () => {
    render(<ToolActivity type="complete" toolName="edit" headline="a" args={{ old_str: 'before', new_str: 'after', path: 'a' }} sessionId="s" requestPull={() => {}} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getByText(/new_str: after/)).toHaveTextContent('old_str: before');
    expect(document.querySelector('table')).toBeNull();
  });
  it('does not expand a headline-only tool without args or result', () => {
    render(<ToolActivity type="complete" toolName="bash" headline="$ ls" sessionId="s" requestPull={() => {}} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('ToolActivity native argument detail', () => {
  it('shows all bash keys, sorted, under Arguments', () => {
    render(<ToolActivity type="complete" toolName="bash" headline="$ seq 1 400" sessionId="s1" requestPull={() => {}} argsRef={{ type: 'content_ref', id: 'args', size: 42, mimeType: 'application/json' }} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('Arguments')).toBeInTheDocument();
    expect(screen.getByText('command: seq 1 400\ntimeout: 30', { collapseWhitespace: false })).toBeInTheDocument();
    expect(screen.queryByText('Command')).not.toBeInTheDocument();
  });
  it('renders inline args from completed traces as well as lazy refs', () => {
    render(<ToolActivity type="complete" toolName="bash" headline="$ seq 1 400" args={{ command: 'seq 1 400', timeout: 30 }} sessionId="s1" requestPull={() => {}} forceExpanded />);
    expect(screen.getByText('command: seq 1 400\ntimeout: 30', { collapseWhitespace: false })).toBeInTheDocument();
  });
  it('preserves edit/create arguments rather than hiding keys in a diff', () => {
    expect(formatToolArguments({ path: 'a.ts', new_str: 'new\nline', old_str: 'old' })).toBe('new_str: new\nline\nold_str: old\npath: a.ts');
    expect(formatToolArguments({ content: 'whole file', path: 'a.ts', overwrite: true })).toBe('content: whole file\noverwrite: true\npath: a.ts');
  });
});

describe('ToolActivity — native headline fallbacks', () => {
  it.each(['show_image', 'show_report'])('shows the inline path for %s', (toolName) => {
    const path = toolName === 'show_image' ? '/tmp/noise.png' : '/tmp/report.html';
    render(<ToolActivity type="complete" toolName={toolName} headline="" args={{ path }} sessionId="s" requestPull={() => {}} />);
    expect(screen.getByText(path)).toHaveClass('ktool-headline');
    expect(screen.getByRole('button')).toHaveAccessibleName(`${toolName} ${path}`);
  });
  it('prefers explicit headlines and matches the native tool-specific formats', () => {
    expect(toolHeadline('bash', 'Recorded', { command: 'ignored' })).toBe('Recorded');
    expect(toolHeadline('BASH', '', { command: 'pwd' })).toBe('$ pwd');
    expect(toolHeadline('read', '', { path: '/tmp/file' })).toBe('/tmp/file');
    expect(toolHeadline('fetch_url', '', { url: 'https://example.test' })).toBe('https://example.test');
    expect(toolHeadline('grep', '', { pattern: 'needle' })).toBe('/needle/');
    expect(toolHeadline('glob', '', { pattern: '*.ts' })).toBe('*.ts');
    expect(toolHeadline('bash', '', { path: 'not a command' })).toBe('');
  });
  it('uses preferred strings then sorted keys, rejecting nonstrings, empty and long values', () => {
    expect(toolHeadline('custom', '', { aaa: 'sorted', path: 'preferred', query: 'first' })).toBe('first');
    expect(toolHeadline('custom', '', { z: 'last', a: 'first', query: 'q'.repeat(120), path: 3, key: '' })).toBe('first');
    expect(toolHeadline('custom', '', { path: 'p'.repeat(119) })).toHaveLength(119);
    expect(toolHeadline('custom', '')).toBe('');
    expect(toolHeadline('custom', '', { path: 4 })).toBe('');
  });
});

describe('ToolActivity — final result line', () => {
  it.each(['first\nlast\n', 'first\nlast\n\n', '1\n'.repeat(400)])('keeps the trailing line box without modifying result bytes', (text) => {
    attachment.text = text;
    const { container } = render(<ToolActivity type="complete" toolName="bash" headline="" resultRef={{ type: 'content_ref', id: 'result', size: text.length, mimeType: 'text/plain' }} sessionId="s" requestPull={() => {}} forceExpanded />);
    const pre = container.querySelector('pre');
    expect(pre).toHaveClass('ktool-final-line');
    expect(pre?.textContent).toBe(text);
  });
  it('adds no final-line marker to results without a newline or formatted arguments', () => {
    attachment.text = 'no newline';
    const { container } = render(<ToolActivity type="complete" toolName="bash" headline="" resultRef={{ type: 'content_ref', id: 'result', size: 10, mimeType: 'text/plain' }} args={{ command: 'echo\n' }} sessionId="s" requestPull={() => {}} forceExpanded />);
    expect(container.querySelector('.ktool-final-line')).toBeNull();
  });
});
