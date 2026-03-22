import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Mock the websocket client module before importing App
vi.mock('./lib/ws-client', () => ({
  wsClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    markRead: vi.fn(),
    createSession: vi.fn(),
  },
}));

import { App } from './App';
import { useStore } from './hooks/useStore';

beforeEach(() => {
  useStore.getState().reset();
  vi.clearAllMocks();
});

describe('App', () => {
  it('renders without crashing', () => {
    const { container } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('renders header with kraki branding', () => {
    useStore.getState().setStatus('connected');
    const { getAllByText, getAllByAltText } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(getAllByText('K').length).toBeGreaterThanOrEqual(1);
    // Logo images appear in header + empty states
    expect(getAllByAltText('Kraki').length).toBeGreaterThanOrEqual(1);
  });
});
