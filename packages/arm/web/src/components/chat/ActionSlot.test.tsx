import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CardActionState } from '@kraki/protocol';
import { ActionSlot } from './ActionSlot';

const permission = { type: 'permission', payload: { id: 'p', toolName: 'bash', args: { command: 'rm -rf build' } } } as CardActionState;

describe('ActionSlot permission caption (K-222)', () => {
  it('does not claim a session mode: approvals also arrive in Auto/Delegate', () => {
    render(<ActionSlot action={permission} handlers={{}} />);
    expect(screen.getByText('Needs your approval')).toBeInTheDocument();
    expect(screen.queryByText(/Safe mode/)).not.toBeInTheDocument();
  });
});
