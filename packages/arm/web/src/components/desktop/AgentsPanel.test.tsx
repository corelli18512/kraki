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
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'needs_login', models: 0, hint: 'Run pi login.' })).toBe('未登录。Run pi login.');
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'error', models: 0, hint: 'CLI failure' })).toBe('CLI failure');
});

it('preserves singular and plural English agent/model counts', () => {
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'ready', models: 1 })).toBe('Ready · 1 model');
  expect(detailLine({ id: 'pi', name: 'Pi', status: 'ready', models: 2 })).toBe('Ready · 2 models');
});
