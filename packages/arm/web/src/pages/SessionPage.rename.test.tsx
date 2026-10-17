/** F2 regression: real Sidebar + SessionPage under BrowserRouter, adapted from phase-1 interactions. */
import 'fake-indexeddb/auto';
import { StrictMode } from 'react';
import * as unreadEntry from '../lib/chat/unread-entry';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Sidebar } from '../components/layout/Sidebar';
import { SessionPage } from './SessionPage';
import { useStore } from '../hooks/useStore';

vi.mock('../components/chat/Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: () => () => {},
}));
afterEach(() => {
  if (vi.isMockFunction(unreadEntry.captureEntryBoundary)) unreadEntry.captureEntryBoundary.mockRestore();
});
beforeEach(() => {
  unreadEntry.captureEntryBoundary('A');
  useStore.getState().reset();
  useStore.getState().setSessions(['A', 'B'].map((id) => ({ id, title: `Session ${id}`, deviceId: 'd', agent: 'pi', state: 'idle', messageCount: 0 })));
  useStore.getState().setDevices([{ id: 'd', name: 'Test', role: 'tentacle', online: true }]);
  useStore.getState().setStatus('connected');
  window.history.replaceState({}, '', '/session/A');
});
function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="router-location">{location.pathname}{location.search}{location.hash}</output>
    <output data-testid="router-state">{JSON.stringify(location.state)}</output>
    <button onClick={() => navigate('/session/A?keep=one&info=1&keep=two#anchor', { state: { source: 'rename-test' } })}>Request info</button>
    <button onClick={() => navigate('/session/A?keep=changed#other', { state: { source: 'unrelated' } })}>Unrelated update</button>
    <button onClick={() => navigate(-1)}>History back</button>
    <button onClick={() => navigate(1)}>History forward</button>
  </>;
}
function mount(strict = false) {
  const app = <BrowserRouter><Routes><Route path="/session/:sessionId" element={<><NavigationProbe /><Sidebar /><SessionPage /></>} /></Routes></BrowserRouter>;
  return render(strict ? <StrictMode>{app}</StrictMode> : app);
}
function rename(id: string) {
  fireEvent.contextMenu(within(screen.getByRole('list')).getByRole('button', { name: new RegExp(`Session ${id}`) }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
}
function close() { fireEvent.keyDown(screen.getByRole('dialog', { name: 'Session Info' }), { key: 'Escape' }); }
function opened(id: string) {
  const dialog = screen.getByRole('dialog', { name: 'Session Info' });
  expect(within(dialog).getByLabelText(`Session ID ${id}`)).toBeInTheDocument();
  expect(window.location.search).not.toContain('info=');
  expect(screen.getByTestId('router-location')).toHaveTextContent(window.location.pathname + window.location.search + window.location.hash);
}
it('every selected Rename opens, closes and reopens; title and unselected Rename controls still work', () => {
  mount();
  for (let i = 0; i < 3; i++) { rename('A'); opened('A'); close(); }
  for (let i = 0; i < 2; i++) {
    fireEvent.click(screen.getByRole('button', { name: 'Session A' }));
    opened('A'); close();
  }
  rename('B'); opened('B'); close();
  rename('B'); opened('B'); close();
  fireEvent.click(within(screen.getByRole('list')).getByRole('button', { name: /Session A/ }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rename('A'); opened('A'); close();
});
it('initial info request consumes only its marker and retains unrelated query and hash', () => {
  act(() => window.history.replaceState({}, '', '/session/A?keep=one&info=1&keep=two#anchor'));
  const length = window.history.length;
  mount(); opened('A');
  expect(window.location.search).toBe('?keep=one&keep=two');
  expect(window.location.hash).toBe('#anchor');
  expect(window.history.length).toBe(length);
  close();
});
it('router replacement preserves state and history, without reopening on unrelated updates or back/forward', async () => {
  mount();
  const length = window.history.length;
  fireEvent.click(screen.getByRole('button', { name: 'Request info' }));
  opened('A');
  expect(window.location.search).toBe('?keep=one&keep=two');
  expect(window.location.hash).toBe('#anchor');
  expect(screen.getByTestId('router-state')).toHaveTextContent('{"source":"rename-test"}');
  expect(window.history.length).toBe(length + 1);
  close();
  fireEvent.click(screen.getByRole('button', { name: 'Unrelated update' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History back' }));
  await waitFor(() => expect(screen.getByTestId('router-location')).toHaveTextContent('/session/A?keep=one&keep=two#anchor'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History back' }));
  await waitFor(() => expect(window.location.search).toBe(''));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History forward' }));
  await waitFor(() => expect(window.location.search).toBe('?keep=one&keep=two'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'History forward' }));
  await waitFor(() => expect(window.location.search).toBe('?keep=changed'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(window.history.length).toBe(length + 2);
  rename('B'); opened('B'); close();
});
it('non-request info values and unrelated initial query do not open', () => {
  window.history.replaceState({}, '', '/session/A?info=0&keep=one#anchor');
  mount();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(window.location.search).toBe('?info=0&keep=one');
});

it.each([false, true])('combined notification and info are consumed together before ChatView entry capture (StrictMode=%s)', (strict) => {
  useStore.getState().upsertSession({ ...useStore.getState().sessions.get('A')!, readSeq: 17 });
  const capture = vi.spyOn(unreadEntry, 'captureEntryBoundary');
  window.history.replaceState({ usr: { source: 'notification' }, key: 'entry', idx: 0 }, '', '/session/A?info=1&keep=one&from=notification&keep=two#anchor');
  const length = window.history.length;
  mount(strict);
  opened('A');
  expect(capture).toHaveBeenCalledWith('A');
  expect(capture.mock.results[0].value).toBe(17); // Actual ChatView consumed the pre-render notification mark, not an unread badge.
  expect(window.location.search).toBe('?keep=one&keep=two');
  expect(window.location.hash).toBe('#anchor');
  expect(screen.getByTestId('router-state')).toHaveTextContent('{"source":"notification"}');
  expect(window.history.length).toBe(length);
  close();
  fireEvent.click(screen.getByRole('button', { name: 'Unrelated update' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(window.location.search).toBe('?keep=changed');
});
it.each(['notification', 'link'])('notification-only/from=%s preserves unrelated URL and correct entry boundary', (from) => {
  useStore.getState().upsertSession({ ...useStore.getState().sessions.get('A')!, readSeq: 17 });
  const capture = vi.spyOn(unreadEntry, 'captureEntryBoundary');
  window.history.replaceState({}, '', `/session/A?keep=one&from=${from}#anchor`);
  mount();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(capture.mock.results[0].value).toBe(from === 'notification' ? 17 : null);
  expect(window.location.search).toBe(from === 'notification' ? '?keep=one' : '?keep=one&from=link');
  expect(window.location.hash).toBe('#anchor');
  expect(screen.getByTestId('router-location')).toHaveTextContent(window.location.pathname + window.location.search + window.location.hash);
});
