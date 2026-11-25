import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { ImportSessionDialog } from './ImportSessionDialog';

beforeEach(() => { useStore.getState().reset(); localStorage.clear(); });
afterEach(async () => { await i18next.changeLanguage('en'); });

describe('ImportSessionDialog localization', () => {
  it('updates memoized directory labels and singular session counts live', async () => {
    useStore.setState({ localSessions: [{
      sessionId: 'local-session', cwd: '~', modifiedTime: '2026-01-01T00:00:00Z',
      isLive: false, source: 'copilot',
    }] });
    render(<ImportSessionDialog open onClose={vi.fn()} />);
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('1 local session')).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByText('主目录')).toBeInTheDocument();
    expect(screen.getByText('1 个本地会话')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', '搜索会话…');
  });

  it('localizes the empty state without changing command names', async () => {
    await i18next.changeLanguage('zh-Hans');
    render(<ImportSessionDialog open onClose={vi.fn()} />);
    expect(screen.getByText('未找到本地会话')).toBeInTheDocument();
    expect(screen.getByText('在终端运行 copilot 以创建会话')).toBeInTheDocument();
  });
});

// K-204: a computer that never answers the scan does not leave "Scanning…"
// forever; the user can try again.
describe('ImportSessionDialog scan with no answer (K-204)', () => {
  it('stops scanning after the timeout and offers Try again', async () => {
    const { wsClient } = await import('../../lib/ws-client');
    const request = vi.spyOn(wsClient, 'requestLocalSessions').mockImplementation(() => {
      useStore.getState().setLocalSessionsLoading(true);
      return 'req';
    });
    vi.useFakeTimers();
    try {
      useStore.getState().setDevices([{ id: 'pc', name: 'Office PC', role: 'tentacle', online: true }]);
      render(<ImportSessionDialog open onClose={vi.fn()} />);
      expect(request).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Scanning local sessions…')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(30_000); });
      expect(screen.queryByText('Scanning local sessions…')).not.toBeInTheDocument();
      expect(screen.getByText('Office PC didn’t answer.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(request).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Scanning local sessions…')).toBeInTheDocument();
      // A late answer still shows the list.
      act(() => { useStore.getState().setLocalSessions([]); useStore.getState().setLocalSessionsLoading(false); });
      expect(screen.getByText('No local sessions found')).toBeInTheDocument();
    } finally { vi.useRealTimers(); request.mockRestore(); }
  });
});
