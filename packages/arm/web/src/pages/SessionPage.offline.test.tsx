/** K-214: the "{device} is offline" banner waits out a blip (a computer restart). */
import 'fake-indexeddb/auto';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SessionPage } from './SessionPage';
import { useStore } from '../hooks/useStore';
import { RECONNECTING_DEBOUNCE_MS } from '../hooks/useShowsReconnecting';

vi.mock('../components/chat/Voice', () => ({
  MicButton: () => null, VoiceError: () => null, VoiceRow: () => null, VoiceTranscript: () => null,
  useDictation: () => ({ active: false }), useStartDictation: () => () => {}, useStopDictationOnLeave: () => {},
}));

const banner = () => screen.queryByText('Mac is offline — messages will be sent when it reconnects');
const setOnline = (online: boolean) => act(() => {
  useStore.getState().setDevices([{ id: 'd', name: 'Mac', role: 'tentacle', online }]);
});

beforeEach(() => {
  vi.useFakeTimers();
  useStore.getState().reset();
  useStore.getState().setSessions([{ id: 'A', title: 'Session A', deviceId: 'd', deviceName: 'Mac', agent: 'pi', state: 'idle', messageCount: 0 }]);
  useStore.getState().setDevices([{ id: 'd', name: 'Mac', role: 'tentacle', online: true }]);
  useStore.getState().setStatus('connected');
});
afterEach(() => { vi.useRealTimers(); });

it('a computer that is back within the grace never shows the banner; a lasting outage does', () => {
  render(<MemoryRouter initialEntries={['/session/A']}><Routes><Route path="/session/:sessionId" element={<SessionPage />} /></Routes></MemoryRouter>);
  expect(banner()).toBeNull();

  setOnline(false);
  act(() => { vi.advanceTimersByTime(RECONNECTING_DEBOUNCE_MS - 1); });
  expect(banner()).toBeNull();
  setOnline(true);
  act(() => { vi.advanceTimersByTime(RECONNECTING_DEBOUNCE_MS); });
  expect(banner()).toBeNull();

  setOnline(false);
  act(() => { vi.advanceTimersByTime(RECONNECTING_DEBOUNCE_MS); });
  expect(banner()).not.toBeNull();
  setOnline(true);
  expect(banner()).toBeNull();
});
