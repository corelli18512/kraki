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

describe('Bubble — draftless terminal outcome', () => {
  it('renders Stopped and opens the persisted turn trace', () => {
    const onOpenSteps = vi.fn();
    const row: ChatRow = { kind: 'spine', key: '4', item: { message: {
      type: 'turn_status', sessionId: 's1', deviceId: 'd1', seq: 4,
      timestamp: '2026-09-26T00:00:00.000Z', payload: { draft: '', steps: 1, action: { type: 'user_abort' } },
    } as never } };
    render(<Bubble row={row} ctx={{ sessionId: 's1', hueSeed: 's1', onOpenSteps }} />);
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByText('User aborted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show steps' }));
    expect(onOpenSteps).toHaveBeenCalledWith(4);
  });
});

describe('Bubble — media hierarchy', () => {
  it('keeps report cards in the agent bubble before outside images, including report-only answers', () => {
    const row: ChatRow = {
      kind: 'spine', key: 'a4', item: { message: {
        type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 4, timestamp: '',
        payload: { content: '', attachments: [
          { type: 'content_ref', id: 'report', mimeType: 'text/html', size: 167_000, caption: 'Report' },
          { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        ] },
      } as never },
    };
    const { container } = render(<Bubble row={row} ctx={{ sessionId: 's1', hueSeed: 's1', onOpenArtifact: () => {} }} />);
    const card = screen.getByRole('button', { name: 'Open report Report' });
    expect(card.closest('.kbubble-agent')).not.toBeNull();
    const stack = container.querySelector('.kagent-stack')!;
    expect(stack.children[0]).toHaveClass('kbubble-agent');
    expect(stack.children[1]).toHaveClass('kattachments');
    expect(stack.children[1].querySelector('[data-image-gallery]')).not.toBeNull();
  });
});

describe('Bubble — integrated media context actions', () => {
  it('uses the native palette and transcript Steps menu for a report-only answer', () => {
    const onOpenSteps = vi.fn();
    const row: ChatRow = { kind: 'spine', key: 'a4', item: { message: {
      type: 'agent_message', sessionId: 's1', deviceId: 'd1', seq: 4, timestamp: '',
      payload: { content: '', steps: 1, attachments: [
        { type: 'content_ref', id: 'report', mimeType: 'text/html', size: 167_000, caption: 'Report' },
      ] },
    } as never } };
    render(<Bubble row={row} ctx={{ sessionId: 's1', hueSeed: 's1', onOpenSteps, onOpenArtifact: () => {} }} />);
    const bubble = screen.getByRole('button', { name: 'Open report Report' }).closest<HTMLElement>('.kbubble-agent')!;
    expect(bubble.style.getPropertyValue('--k-agent-light')).not.toBe('');
    expect(bubble.style.getPropertyValue('--hue')).toBe('');
    fireEvent.contextMenu(bubble);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show Steps' }));
    expect(onOpenSteps).toHaveBeenCalledWith(4);
  });
  it('keeps ordinary user prose independent of agent report cards', () => {
    const row: ChatRow = { kind: 'spine', key: 'u1', item: { message: {
      type: 'user_message', sessionId: 's1', deviceId: 'd1', seq: 1, timestamp: '', payload: { content: 'User prose' },
    } as never } };
    render(<Bubble row={row} ctx={{ sessionId: 's1', hueSeed: 's1' }} />);
    expect(screen.getByText('User prose').closest('.kbubble-user')).not.toBeNull();
  });
});
