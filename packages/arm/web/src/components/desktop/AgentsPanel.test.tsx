import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { i18next } from '../../i18n';
import { AgentsPanel, detailLine } from './AgentsPanel';

afterEach(async () => { await act(async () => { await i18next.changeLanguage('en'); }); });

it('translates agent details and the catalog at render time without translating agent names or CLI hints', async () => {
  const check = { agents: new Map(), installed: [], readyCount: 0, running: false, hasResults: true, run: vi.fn() };
  render(<AgentsPanel check={check} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose an agent to install…' }));
  expect(screen.getByText("Anthropic's coding agent.")).toBeInTheDocument();
  await act(async () => { await i18next.changeLanguage('zh-Hans'); });
  expect(screen.getByRole('dialog', { name: '支持的编程 Agent' })).toBeInTheDocument();
  expect(screen.getByText('Anthropic 的编程 Agent。')).toBeInTheDocument();
  expect(screen.getByText('Claude Code')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '完成' })).toBeInTheDocument();
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'ready', models: 2 })).toBe('已就绪 · 2 个模型');
  // Known agents: the login instruction is translated; the command stays literal.
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'needs_login', models: 0, hint: 'Run `pi` in Terminal and use /login, or add an API key.' }))
    .toBe('未登录。在终端中运行 `pi` 并使用 /login，或添加 API 密钥。');
  // Unknown agents fall back to the CLI's hint.
  expect(detailLine({ id: 'other', name: 'Other', status: 'needs_login', models: 0, hint: 'Run other login.' })).toBe('未登录。Run other login.');
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'error', models: 0, hint: 'CLI failure' })).toBe('CLI failure');
});

it('preserves singular and plural English agent/model counts', () => {
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'ready', models: 1 })).toBe('Ready · 1 model');
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'ready', models: 2 })).toBe('Ready · 2 models');
});
