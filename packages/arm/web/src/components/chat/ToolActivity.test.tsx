import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolActivity, formatToolArguments } from './ToolActivity';

vi.mock('../../hooks/useAttachment', () => ({
  useAttachmentText: () => ({ status: 'ready', text: '{"timeout":30,"command":"seq 1 400"}', error: null }),
}));

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
