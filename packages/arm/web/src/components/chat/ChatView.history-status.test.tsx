import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatView } from './ChatView';
import { messageProvider } from '../../lib/message-provider';
import { useStore } from '../../hooks/useStore';
import { requests, respond, setup, snapshot } from '../../lib/__tests__/ChatView.history-status.fixture';

// jsdom has no CSS.escape; fixture row keys contain no quotes or escapes.
if (!CSS.escape) CSS.escape = (value) => value;

// No transport is opened. Provider, store, IDB, scroller, composer and bubbles are real.
vi.mock('../../lib/ws-client', () => ({ wsClient: { sendInput: vi.fn(), abortSession: vi.fn() } }));
afterEach(() => { cleanup(); messageProvider.clear(); });
async function mount(head = 100, initial = 0, available = true) {
  const id = await setup(head, initial, available);
  const view = render(<ChatView sessionId={id} topInset={40} />);
  return { id, ...view };
}
async function start(id: string) {
  act(() => messageProvider.ensureLoaded(id));
  await waitFor(() => expect(requests).toHaveLength(1));
}
async function answer(index?: number, empty = false) {
  await act(async () => { respond(index, empty); });
}

describe('ChatView range status with the real provider', () => {
  it('owns history placement in the dock across independent draft and compaction updates', async () => {
    const { id, container } = await mount(100, 10, false);
    const dock = container.querySelector('.kcomposer-dock')!;
    const position = container.querySelector<HTMLElement>('.khistory-position')!;
    const editor = screen.getByRole('textbox');
    const noStatusPadding = container.querySelector<HTMLElement>('.kchat-scroll-content')!.style.paddingBottom;
    expect(position.parentElement).toBe(dock);
    expect(position.style.bottom).toBe('');
    act(() => useStore.getState().setDraft(id, 'First line\nSecond line\nThird line'));
    act(() => useStore.getState().setRuntimeStatus(id, { status: 'compacting' }));
    expect(container.querySelector<HTMLElement>('.kchat-scroll-content')!.style.paddingBottom).toBe(noStatusPadding);
    await act(async () => { await messageProvider.fetchRange(id, 51, 100, { initial: true }); });
    expect(position).toContainElement(screen.getByRole('button', { name: 'Retry history' }));
    expect(position.parentElement).toBe(dock);
    expect(position.style.bottom).toBe('');
    expect(screen.getByRole('textbox')).toBe(editor);
    expect(editor).toHaveValue('First line\nSecond line\nThird line');
  });

  it('distinguishes a withheld response from authoritative empty and retries only explicitly', async () => {
    const { id } = await mount();
    await start(id);
    expect(screen.getByRole('status', { name: 'Conversation history' })).toHaveTextContent('Loading history');
    expect(screen.queryByText('Send a message to start.')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled(), { timeout: 11_000 });
    expect(screen.getByRole('status', { name: 'Conversation history' })).toHaveTextContent('History request timed out.');
    expect(screen.queryByText('Send a message to start.')).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    await answer();
    await waitFor(() => expect(snapshot(id).status.state).toBe('loaded'));
    expect(screen.getByText('History row 100')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Conversation history' })).not.toBeInTheDocument();
  }, 15_000);

  it('keeps a successful empty answer and a genuinely new session as normal starts', async () => {
    const { id } = await mount();
    await start(id); await answer(undefined, true);
    await waitFor(() => expect(screen.getByText('Send a message to start.')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    cleanup();
    await mount(0);
    expect(screen.getByText('Send a message to start.')).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it('presents unavailable explicitly without hiding cached rows or disturbing the draft', async () => {
    const { id, container } = await mount(100, 10, false);
    const editor = screen.getByRole('textbox');
    fireEvent.change(editor, { target: { value: 'Keep my draft' } }); editor.focus();
    await act(async () => { await messageProvider.fetchRange(id, 51, 100, { initial: true }); });
    expect(screen.getByRole('status', { name: 'Conversation history' })).toHaveTextContent('History is unavailable.');
    expect(screen.getByText('History row 10')).toBeInTheDocument();
    expect(editor).toHaveValue('Keep my draft'); expect(editor).toHaveFocus();
    expect(container.querySelector('.ktop-loader .kspinner')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it('exposes a >50 interior gap through multiple bounded Continue actions even at the tail', async () => {
    const { id } = await mount(220, 10);
    await start(id); await answer();
    await waitFor(() => expect(requests).toHaveLength(2)); await answer();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue loading history' })).toBeEnabled());
    expect(snapshot(id).status).toEqual({ state: 'incomplete', remaining: [[61, 170]] });
    for (const [from, to] of [[61, 110], [111, 160], [161, 170]]) {
      const button = screen.getByRole('button', { name: 'Continue loading history' });
      fireEvent.click(button); fireEvent.click(button);
      await waitFor(() => expect(requests.at(-1)).toMatchObject({ fromSeq: from, toSeq: to }));
      expect(screen.getByRole('button', { name: 'Loading history' })).toBeDisabled();
      await answer();
      await waitFor(() => expect(snapshot(id).status.state).not.toBe('loading'));
    }
    expect(requests.map(r => [r.fromSeq, r.toSeq])).toEqual([[171, 220], [11, 60], [61, 110], [111, 160], [161, 170]]);
    expect(snapshot(id).seqs).toEqual(Array.from({ length: 220 }, (_, i) => i + 1));
    expect(screen.queryByRole('status', { name: 'Conversation history' })).not.toBeInTheDocument();
  });

  it('does not reinterpret a current question at the head after an unrelated older-load error', async () => {
    const { id } = await mount(100, 0, false);
    act(() => useStore.getState().prependMessages(id, [{ type: 'agent_message', sessionId: id,
      deviceId: 'synthetic-device', seq: 100, timestamp: '',
      payload: { content: '', question: { id: 'current-question', text: 'Choose a color?', choices: ['Amber', 'Teal'] } },
    }]));
    expect(screen.getByRole('textbox', { name: 'Type your answer…' })).toBeInTheDocument();
    await act(async () => { await messageProvider.fetchRange(id, 1, 50); });
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled();
    expect(screen.getByText('Choose a color?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Type your answer…' })).toBeInTheDocument();
  });

  it('hides deleted-session loading and actions even when old work finishes after removal', async () => {
    const { id } = await mount();
    await start(id);
    act(() => useStore.getState().removeSession(id));
    expect(screen.queryByRole('status', { name: 'Conversation history' })).not.toBeInTheDocument();
    await answer();
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    // Store/DB invalidation is a separately owned integration seam, not emulated here.
    expect(useStore.getState().sessions.has(id)).toBe(false);
  });

  it('binds subscription snapshots and actions to the current session across switch, deletion and unmount', async () => {
    const { id, rerender, unmount } = await mount(100, 0, false);
    await act(async () => { await messageProvider.fetchRange(id, 51, 100); });
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled();
    rerender(<ChatView sessionId={`${id}-other`} topInset={40} />);
    expect(screen.queryByRole('status', { name: 'Conversation history' })).not.toBeInTheDocument();
    expect(screen.getByText('Send a message to start.')).toBeInTheDocument();
    rerender(<ChatView sessionId={id} topInset={40} />);
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeEnabled();
    act(() => useStore.getState().removeSession(id));
    expect(screen.queryByRole('button', { name: 'Retry history' })).not.toBeInTheDocument();
    unmount();
    act(() => messageProvider.clear());
    expect(requests).toHaveLength(0);
  });
});
