import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatToolArguments, ToolActivity } from './ToolActivity';

describe('ToolActivity — native arguments', () => {
  it('preserves timeout and all edit keys in sorted key/value text', () => {
    expect(formatToolArguments({ timeout: 30, command: 'seq 1 400' })).toBe('command: seq 1 400\ntimeout: 30');
    expect(formatToolArguments({ old_str: 'before', new_str: 'after', path: 'a' })).toBe('new_str: after\nold_str: before\npath: a');
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
