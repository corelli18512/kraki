import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { ArchiveSettings } from './ArchivedSessions';

beforeEach(() => { useStore.getState().reset(); });
afterEach(async () => { await i18next.changeLanguage('en'); });

describe('ArchiveSettings localization', () => {
  it('uses English plurals and updates Chinese counts and day options live', async () => {
    useStore.setState({ archiveInfo: new Map([['device', { count: 1, days: 14 }]]) });
    render(<ArchiveSettings />);
    expect(screen.getByRole('button', { name: 'Delete 1 Archived Session…' })).toBeInTheDocument();
    act(() => { useStore.setState({ archiveInfo: new Map([['device', { count: 2, days: 14 }]]) }); });
    expect(screen.getByRole('button', { name: 'Delete 2 Archived Sessions…' })).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('button', { name: '删除 2 个已归档会话…' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '14 天' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '永不' })).toBeInTheDocument();
  });
});
