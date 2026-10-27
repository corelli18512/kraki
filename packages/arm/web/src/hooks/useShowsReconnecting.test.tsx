import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useStore } from './useStore';
import { RECONNECTING_DEBOUNCE_MS, useShowsReconnecting } from './useShowsReconnecting';
import { diag } from '../lib/diag';

function Indicator() { return useShowsReconnecting() ? <span>Reconnecting…</span> : null; }

let calls: boolean[];
beforeEach(() => {
  vi.useFakeTimers();
  useStore.getState().reset();
  calls = [];
  vi.spyOn(diag.stability, 'reconnectingShown').mockImplementation((shown) => { calls.push(shown); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('performance data: a second indicator mounting during an outage does not end the time on screen', () => {
  const sidebar = render(<Indicator />);
  act(() => { useStore.setState({ status: 'connecting', reconnectAttempts: 1 }); });
  act(() => { vi.advanceTimersByTime(RECONNECTING_DEBOUNCE_MS); });
  expect(sidebar.queryByText('Reconnecting…')).not.toBeNull();
  const session = render(<Indicator />); // e.g. SessionPage opened during the outage
  act(() => { vi.advanceTimersByTime(RECONNECTING_DEBOUNCE_MS); });
  sidebar.unmount(); // the other one still shows it
  expect(calls.filter((shown) => !shown)).toEqual([]);
  act(() => { useStore.setState({ status: 'connected', reconnectAttempts: 0 }); });
  expect(calls.at(-1)).toBe(false);
  session.unmount();
  expect(calls.filter((shown) => shown)).toHaveLength(1);
});
