import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { DeviceSummary } from '@kraki/protocol';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { DeviceUpdateBox } from './DeviceUpdateBox';

const commands = vi.hoisted(() => ({ updateDevice: vi.fn() }));
vi.mock('../../lib/ws-client', () => ({ wsClient: commands }));
const device: DeviceSummary = { id: 'pc', name: 'My PC', role: 'tentacle', online: true };
beforeEach(() => { useStore.getState().reset(); vi.clearAllMocks(); });
afterEach(async () => { await act(async () => { await i18next.changeLanguage('en'); }); });

it('preserves English singular/plural running-session warnings and localizes them live', async () => {
  useStore.getState().setUpdateProgress('pc', { phase: 'busy', runningSessions: 1, at: Date.now() });
  render(<DeviceUpdateBox device={device} />);
  expect(screen.getByText('1 session is running')).toBeInTheDocument();
  act(() => { useStore.getState().setUpdateProgress('pc', { phase: 'busy', runningSessions: 2, at: Date.now() }); });
  expect(screen.getByText('2 sessions are running')).toBeInTheDocument();
  await act(async () => { await i18next.changeLanguage('zh-Hans'); });
  expect(screen.getByText('有 2 个会话正在运行')).toBeInTheDocument();
  expect(screen.getByText('更新会重启 My PC 上的 Kraki，并停止这些会话。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '会话结束后更新' }));
  expect(commands.updateDevice).toHaveBeenCalledWith('pc', 'idle');
});

it('interpolates versions/device names and passes through remote update errors', async () => {
  await i18next.changeLanguage('zh-Hans');
  useStore.getState().setUpdateProgress('pc', { phase: 'downloading', to: '0.36.0', at: Date.now() });
  render(<DeviceUpdateBox device={device} />);
  expect(screen.getByText('正在下载 Kraki 0.36.0…')).toBeInTheDocument();
  act(() => { useStore.getState().setUpdateProgress('pc', { phase: 'failed', error: 'Remote CLI failure', at: Date.now() }); });
  expect(screen.getByText('Remote CLI failure', { exact: false })).toBeInTheDocument();
  expect(screen.getByText('无法更新')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(screen.queryByTestId('device-update')).not.toBeInTheDocument();
});

it('uses complete rollback sentences with and without a previous version', async () => {
  useStore.getState().setUpdateProgress('pc', { phase: 'rolled_back', from: '0.35.0', at: Date.now() });
  render(<DeviceUpdateBox device={device} />);
  expect(screen.getByText('The new version didn’t start on My PC, so it went back to 0.35.0.')).toBeInTheDocument();
  await act(async () => { await i18next.changeLanguage('zh-Hans'); });
  expect(screen.getByText('新版本未能在 My PC 上启动，因此已恢复至 0.35.0。')).toBeInTheDocument();
  act(() => { useStore.getState().setUpdateProgress('pc', { phase: 'rolled_back', at: Date.now() }); });
  expect(screen.getByText('新版本未能在 My PC 上启动，因此已恢复至上一个版本。')).toBeInTheDocument();
  await act(async () => { await i18next.changeLanguage('en'); });
  expect(screen.getByText('The new version didn’t start on My PC, so it went back to the previous version.')).toBeInTheDocument();
});

// K-225: a request the computer never answers ends in an error, and a computer
// that came back online on the old version without a status no longer says
// "isn't back online yet" forever.
it('a request the computer never answers ends with an error that can be dismissed (K-225)', () => {
  vi.useFakeTimers();
  try {
    useStore.getState().setUpdateProgress('pc', { phase: 'requested', at: Date.now() });
    render(<DeviceUpdateBox device={device} />);
    expect(screen.getByText('Asking My PC to update…')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(screen.queryByText('Asking My PC to update…')).not.toBeInTheDocument();
    expect(screen.getByText('Couldn’t update')).toBeInTheDocument();
    expect(screen.getByText('My PC didn’t answer', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useStore.getState().updateProgress.has('pc')).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('a computer back online on the old version without a status shows the update did not take (K-225)', () => {
  vi.useFakeTimers();
  try {
    useStore.getState().setUpdateProgress('pc', { phase: 'installing', from: '0.40.0', to: '0.41.0', at: Date.now() });
    const view = render(<DeviceUpdateBox device={{ ...device, online: false }} />);
    act(() => { vi.advanceTimersByTime(185_000); });
    expect(screen.getByText('My PC isn’t back online yet')).toBeInTheDocument();
    view.rerender(<DeviceUpdateBox device={device} />);
    expect(screen.queryByText('My PC isn’t back online yet')).not.toBeInTheDocument();
    expect(screen.getByText('Update didn’t work, so nothing changed')).toBeInTheDocument();
    expect(screen.getByText('The new version didn’t start on My PC, so it went back to 0.40.0.', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useStore.getState().updateProgress.has('pc')).toBe(false);
  } finally { vi.useRealTimers(); }
});
