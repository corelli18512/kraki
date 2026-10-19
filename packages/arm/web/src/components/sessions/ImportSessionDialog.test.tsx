import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
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
