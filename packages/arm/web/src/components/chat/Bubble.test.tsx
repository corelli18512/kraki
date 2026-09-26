import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Bubble, type ChatRow } from './Bubble';

function systemRow(payload: Record<string, unknown>, seq = 7): ChatRow {
  return {
    kind: 'spine',
    key: `s${seq}`,
    item: {
      message: {
        type: 'system_message', sessionId: 's1', deviceId: 'd1', seq,
        timestamp: '2026-09-26T00:00:00.000Z', payload,
      } as never,
    },
  };
}

describe('Bubble — system_message', () => {
  it('a steps-only turn (no_reply) renders just a Steps control, no text', () => {
    const onOpenSteps = vi.fn();
    render(<Bubble row={systemRow({ kind: 'no_reply', steps: 3 })} ctx={{ sessionId: 's1', hueSeed: 's1', onOpenSteps }} />);
    expect(screen.getByTestId('steps-only-turn')).toBeInTheDocument();
    expect(screen.queryByText(/System notice|No reply/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(onOpenSteps).toHaveBeenCalledWith(7);
  });

  it('a system notice with content still renders as a bubble', () => {
    render(<Bubble row={systemRow({ kind: 'notice', content: 'Heads up' })} ctx={{ sessionId: 's1', hueSeed: 's1' }} />);
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.queryByTestId('steps-only-turn')).not.toBeInTheDocument();
  });
});
