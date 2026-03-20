import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Must mock ws-client before importing useWebSocket
vi.mock('../lib/ws-client', () => ({
  wsClient: {
    connect: vi.fn(),
    markRead: vi.fn(),
    createSession: vi.fn(),
  },
}));

import { useWebSocket } from './useWebSocket';
import { wsClient } from '../lib/ws-client';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useWebSocket', () => {
  it('calls connect on mount', () => {
    renderHook(() => useWebSocket());
    expect(wsClient.connect).toHaveBeenCalledTimes(1);
  });

  it('returns the wsClient instance', () => {
    const { result } = renderHook(() => useWebSocket());
    expect(result.current).toBe(wsClient);
  });

  it('does not call connect again on re-render', () => {
    const { rerender } = renderHook(() => useWebSocket());
    rerender();
    rerender();
    expect(wsClient.connect).toHaveBeenCalledTimes(1);
  });
});
