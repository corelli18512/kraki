import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { AccountUsage, DeviceSummary } from '@kraki/protocol';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { lastUpdatedText, readStatus, shortReset, usageUpdateHint, windowName } from '../../lib/usage';
import { OPEN_USAGE_EVENT, UsagePanel } from './UsagePanel';

vi.mock('../../lib/ws-client', () => ({ wsClient: { deviceHasFeature: () => true, refreshAccountUsage: vi.fn() } }));

const now = Date.parse('2026-10-05T00:00:00Z');
const account: AccountUsage = { accountKey: 'a', provider: 'claude', windows: [], fetchedAt: new Date(now - 120_000).toISOString() };
const device = (name: string): DeviceSummary => ({ id: name, name, role: 'tentacle', online: true });

beforeEach(() => { useStore.getState().reset(); });
afterEach(async () => { await act(async () => { await i18next.changeLanguage('en'); }); });

describe('UsagePanel localization', () => {
  it('keeps English elapsed times, durations and account-update hints byte-identical', () => {
    expect(lastUpdatedText(account, now)).toBe('Updated 2m ago');
    expect(lastUpdatedText({ ...account, fetchedAt: new Date(now - 7_200_000).toISOString() }, now)).toBe('Updated 2h ago');
    expect(lastUpdatedText({ ...account, fetchedAt: new Date(now - 172_800_000).toISOString() }, now)).toBe('Updated 2d ago');
    expect(shortReset(new Date(now + 7_500_000).toISOString(), now)).toBe('2h 5m');
    expect(usageUpdateHint([device('Mac')])).toBe('Update Kraki on Mac to see its accounts');
    expect(usageUpdateHint([device('Mac'), device('PC')])).toBe('Update Kraki on Mac and PC to see their accounts');
    expect(usageUpdateHint([device('Mac'), device('PC'), device('Other')])).toBe('Update Kraki on Mac and 2 more to see their accounts');
  });

  it('evaluates helper copy and Intl formatting in the current language at call time', async () => {
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(lastUpdatedText(account, now)).toBe('更新于2分钟前');
    expect(readStatus({ ...account, error: 'auth' }, now)).toBe('需要登录');
    expect(readStatus({ ...account, error: 'rate_limited', retryAt: new Date(now + 150_000).toISOString() }, now)).toBe('已达速率限制 · 3分钟后重试');
    expect(shortReset(new Date(now + 7_500_000).toISOString(), now)).toBe('2小时 5分钟');
    expect(windowName({ id: 'w', kind: 'weekly', remainingPercent: 50 })).toBe('每周');
    expect(windowName({ id: 'w', kind: 'other', title: 'Provider text', remainingPercent: 50 })).toBe('Provider text');
    expect(usageUpdateHint([device('Mac'), device('PC'), device('Other')])).toBe('更新 Mac 和另外 2 台设备 上的 Kraki 以查看其账户');
  });

  it('updates an already-open empty usage panel when the language changes', async () => {
    render(<MemoryRouter><UsagePanel /></MemoryRouter>);
    act(() => { window.dispatchEvent(new Event(OPEN_USAGE_EVENT)); });
    expect(screen.getByRole('dialog', { name: 'Account Usage' })).toBeInTheDocument();
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(screen.getByRole('dialog', { name: '账户用量' })).toHaveAttribute('data-testid', 'usage-panel');
    expect(screen.getByText('未在你的设备上找到 Claude 或 Codex 账户')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
  });
});
