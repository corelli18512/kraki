import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { useStore } from '../../hooks/useStore';
import { browserDeviceName } from '../../lib/auth';
import { useVoice, voiceSettings } from '../../lib/voice/voice';
import { SettingsPanel, performanceDataFooter } from './SettingsPanel';
import { BuildProvenance } from './BuildProvenance';

vi.mock('../../lib/ws-client', () => ({ wsClient: { url: 'ws://localhost', requestAccountDeletion: vi.fn() } }));

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ status: 'connected', user: { id: 'u', login: 'octocat', provider: 'github' } });
  useVoice.setState({ words: [{ term: 'PostgreSQL', heardAs: 'post gress' }], outbox: [] });
  voiceSettings.correction = true;
});
afterEach(async () => { await act(async () => { await i18next.changeLanguage('en'); }); });

const chinese = async () => { await act(async () => { await i18next.changeLanguage('zh-Hans'); }); };

describe('SettingsPanel localization', () => {
  it('localizes browser device descriptions at call time without translating product names', async () => {
    expect(browserDeviceName('Mozilla/5.0 (Macintosh) Chrome/130')).toBe('Chrome on Mac');
    await chinese();
    expect(browserDeviceName('Mozilla/5.0 (Macintosh) Chrome/130')).toBe('Mac 上的 Chrome');
    expect(browserDeviceName('unknown')).toBe('浏览器（网页版）');
  });
  it('switches an open panel, tabs and destructive confirmations without changing identities', async () => {
    render(<SettingsPanel open onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    await chinese();
    expect(screen.getByRole('dialog', { name: '设置' })).toHaveAttribute('data-testid', 'settings-window');
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['通用', '账户', '语音输入', '通知', '这台电脑', '设备', '关于']);
    fireEvent.click(screen.getByRole('tab', { name: '账户' }));
    expect(screen.getByText('通过 GitHub 登录')).toBeInTheDocument();
    expect(screen.getAllByText('octocat')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '退出登录…' }));
    expect(screen.getByRole('alertdialog', { name: '在此浏览器中退出 Kraki？' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '删除账户…' }));
    expect(screen.getByTestId('delete-explain')).toHaveTextContent('Kraki 服务器会删除你的账户');
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('alertdialog', { name: '永久删除账户？' })).toHaveTextContent('此操作无法撤销。');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(performanceDataFooter()).toContain('绝不发送消息文本、草稿、语音、附件或文件名。');
  });

  it('translates custom-word accessibility labels without translating the words', async () => {
    await chinese();
    render(<SettingsPanel open onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '语音输入' }));
    expect(screen.getByRole('textbox', { name: '词汇或名称：PostgreSQL' })).toHaveValue('PostgreSQL');
    expect(screen.getByRole('textbox', { name: '常被识别为：PostgreSQL' })).toHaveValue('post gress');
    expect(screen.getByRole('button', { name: '移除 PostgreSQL' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加词汇' }));
    expect(screen.getByRole('textbox', { name: '自定义词汇' })).toHaveAttribute('placeholder', '例如 PostgreSQL');
  });

  it('translates build metadata labels while preserving provenance URLs and identifiers', async () => {
    await chinese();
    render(<BuildProvenance info={{ schemaVersion: 1, channel: 'release', repository: 'corelli18512/kraki', commit: 'a'.repeat(40), workflow: '.github/workflows/windows-release.yml', runId: '123', runAttempt: '2' }} />);
    expect(screen.getByRole('link', { name: /GitHub 运行 ID/ })).toHaveTextContent('123 · 第 2 次尝试');
    expect(screen.getByRole('link', { name: /源代码提交/ })).toHaveAttribute('href', `https://github.com/corelli18512/kraki/commit/${'a'.repeat(40)}`);
  });
});
