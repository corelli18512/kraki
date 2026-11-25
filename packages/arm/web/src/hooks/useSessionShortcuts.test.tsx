import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router';
import { useSessionShortcuts } from './useSessionShortcuts';
import { useStore } from './useStore';
import { sortSessionsForList } from '../lib/chat/session-card';
import type { WebSessionSummary } from '../types/store';

function Harness() {
  useSessionShortcuts();
  const { sessionId } = useParams();
  return <><div data-testid="current">{sessionId}</div><textarea aria-label="draft" /></>;
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/session/${id}`]}>
      <Routes><Route path="/session/:sessionId" element={<Harness />} /></Routes>
    </MemoryRouter>,
  );
}

const session = (id: string, createdAt: string) => ({ id, createdAt, deviceId: 'd', deviceName: 'D', agent: 'copilot', state: 'idle' }) as unknown as WebSessionSummary;

beforeEach(() => {
  useStore.getState().reset();
  // "fresh" has no preview yet but was created after "older" last spoke:
  // the sidebar lists it first (creation time stands in for activity).
  useStore.setState({
    sessions: new Map([
      ['older', session('older', '2026-01-01T00:00:00Z')],
      ['fresh', session('fresh', '2026-03-01T00:00:00Z')],
      ['middle', session('middle', '2026-01-01T00:00:00Z')],
      ['newest', session('newest', '2026-01-01T00:00:00Z')],
    ]),
    sessionPreviews: new Map([
      ['older', { text: 'a', timestamp: '2026-02-01T00:00:00Z' }],
      ['middle', { text: 'b', timestamp: '2026-01-15T00:00:00Z' }],
      ['newest', { text: 'c', timestamp: '2026-04-01T00:00:00Z' }],
    ]),
  });
});

describe('useSessionShortcuts (K-211)', () => {
  it('walks sessions in the same order as the sidebar', () => {
    const { sessions, pinnedSessions, sessionPreviews } = useStore.getState();
    expect(sortSessionsForList(sessions.values(), pinnedSessions, sessionPreviews).map((s) => s.id)).toEqual(['newest', 'fresh', 'older', 'middle']);
    renderAt('newest');
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('fresh');
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('older');
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('middle');
    fireEvent.keyDown(window, { key: 'ArrowUp', ctrlKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('older');
  });

  it('leaves Cmd+Up/Down to the caret while it can still move inside a text field', () => {
    renderAt('fresh');
    const draft = screen.getByRole('textbox', { name: 'draft' }) as HTMLTextAreaElement;
    draft.value = 'line one\nline two';
    draft.setSelectionRange(5, 5);
    fireEvent.keyDown(draft, { key: 'ArrowDown', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('fresh');
    fireEvent.keyDown(draft, { key: 'ArrowUp', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('fresh');
    // Shift extends the selection; never a session switch.
    draft.setSelectionRange(draft.value.length, draft.value.length);
    fireEvent.keyDown(draft, { key: 'ArrowDown', metaKey: true, shiftKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('fresh');
    // Caret already at the end: the next Cmd+Down switches session.
    fireEvent.keyDown(draft, { key: 'ArrowDown', metaKey: true });
    expect(screen.getByTestId('current')).toHaveTextContent('older');
  });
});
