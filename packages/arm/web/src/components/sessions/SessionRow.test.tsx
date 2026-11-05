import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { i18next } from '../../i18n';
import { MemoryRouter, useLocation } from 'react-router';
import { SessionRow } from './SessionRow';
import { useStore } from '../../hooks/useStore';
import { useOutbox } from '../../lib/chat/outbox';
import { wsClient } from '../../lib/ws-client';
import { sessionTimeLabel } from '../../lib/chat/session-card';
import type { WebSessionSummary } from '../../types/store';

const session: WebSessionSummary = { id: 's', agent: 'pi', deviceId: 'd', deviceName: 'Local Mac', model: 'deepseek/deepseek-flash', reasoningEffort: 'low', state: 'idle', messageCount: 1, title: 'Sidebar test', createdAt: '2026-01-01T09:00:00Z' };
function Location() { return <output data-testid="location">{useLocation().pathname + useLocation().search}</output>; }
function row(selected = false) {
  return render(<MemoryRouter initialEntries={['/session/s']}><SessionRow session={session} selected={selected} pinned={false} narrow={false} /><Location /></MemoryRouter>);
}
beforeEach(() => { useStore.getState().reset(); useOutbox.setState({ entries: [] }); vi.restoreAllMocks(); });

afterEach(async () => { await i18next.changeLanguage('en'); });

describe('SessionRow Mac sidebar', () => {
  it('updates menu actions live without translating the user title or model name', async () => {
    row();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }));
    await act(async () => { await i18next.changeLanguage('zh-Hans'); });
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['置顶', '标为未读', '重命名…', '分叉', '归档', '删除…']);
    expect(screen.getByText('Sidebar test')).toBeInTheDocument();
    expect(screen.getByText('deepseek/deepseek-flash')).toBeInTheDocument();
    expect(screen.getByText('会话已创建')).toBeInTheDocument();
  });
  it.each([
    ['question', 'Waiting for an answer'],
    ['permission', 'Waiting for approval'],
  ])('gives %s the native dark attention tint hook without changing light amber', (type, label) => {
    useStore.getState().setSessionPreview('s', { text: 'Waiting', type, timestamp: session.createdAt! });
    row();
    expect(screen.getByLabelText(label)).toHaveClass('ksr-attention', 'text-amber-600');
  });
  it('uses a small model avatar, effort, createdAt fallback, and no offline title pill', () => {
    useStore.getState().setDevices([{ id: 'd', role: 'tentacle', name: 'Local Mac', online: false }]);
    const { container } = row();
    expect(container.querySelector('[data-model-family="DeepSeek"]')).toBeInTheDocument();
    expect(container.querySelector('.h-7.w-7')).toBeInTheDocument();
    expect(screen.getByText('· low')).toBeInTheDocument();
    expect(screen.getByText(sessionTimeLabel(session.createdAt!))).toBeInTheDocument();
    expect(screen.queryByText('offline')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Offline')).toBeInTheDocument();
    expect(container.querySelector('.ksr-devdot')).toBeNull();
  });
  it('uses creation time for an invalid preview just like list ordering', () => {
    useStore.getState().setSessionPreview('s', { text: 'Invalid timestamp', type: 'agent', timestamp: 'invalid' });
    row();
    expect(screen.getByText(sessionTimeLabel(session.createdAt!))).toBeInTheDocument();
  });
  it('renders six native-worded actions with a destructive separator and routes Rename to Session Info', () => {
    row();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }), { clientX: 40, clientY: 100 });
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent?.trim())).toEqual(['Pin', 'Mark Unread', 'Rename…', 'Fork', 'Archive', 'Delete…']);
    expect(within(menu).getByRole('separator')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Rename…'));
    expect(screen.getByTestId('location')).toHaveTextContent('/session/s?info=rename');
  });
  it('archives and deselects the selected session', () => {
    const archive = vi.spyOn(wsClient, 'archiveSession').mockImplementation(() => {});
    row(true);
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    expect(archive).toHaveBeenCalledWith('s', true);
    expect(screen.getByTestId('location').textContent).toBe('/');
  });
  it('uses the canonical safe sidebar deletion alert, canceling without mutation', () => {
    const remove = vi.spyOn(wsClient, 'deleteSession').mockImplementation(() => {});
    row();
    fireEvent.contextMenu(screen.getByRole('button', { name: /Sidebar test/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this session? This cannot be undone.' })).toHaveTextContent('Delete this session? This cannot be undone.');
    expect(screen.getByRole('button', { name: 'Delete Session' })).toBeInTheDocument();
    expect(screen.queryByText(/permanently deletes.*Local Mac/)).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it('projects pending delivery before drafts and live preview, restoring draft when pending clears', () => {
    useStore.getState().setStatus('connected');
    useStore.getState().setDraft('s', 'unsent draft');
    useOutbox.setState({ entries: [{ clientId: 'p', sessionId: 's', text: 'pending send', state: 'failed', order: 1, timestamp: session.createdAt! }] });
    const { unmount } = row();
    expect(screen.getByText('Send failed · pending send')).toBeInTheDocument();
    expect(screen.getByLabelText('Send failed')).toBeInTheDocument();
    expect(screen.queryByText('unsent draft')).toBeNull();
    unmount();
    useOutbox.setState({ entries: [] });
    const { container } = row();
    expect(container.querySelector('.ksr-line3.is-draft')).toHaveTextContent('unsent draft');
    expect(container.querySelector('.ksr-status-slot')).toBeInTheDocument();
  });
});

// K-212: the row menu opens from the keyboard (Menu key / Shift+F10), focus
// moves into it, arrows move between items and Escape returns to the row; the
// row has one spoken name with its unread state.
describe('SessionRow keyboard and screen reader (K-212)', () => {
  it('opens its menu from the keyboard and returns focus on Escape', () => {
    row();
    const button = screen.getByRole('button', { name: /Sidebar test/ });
    button.focus();
    fireEvent.keyDown(button, { key: 'F10', shiftKey: true });
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: 'ContextMenu' });
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
  it('names the row with its parts separated and says it is unread', () => {
    useStore.setState({ unreadCount: new Map([['s', 2]]) });
    useStore.getState().setSessionPreview('s', { text: 'Done, tests pass', type: 'agent', timestamp: session.createdAt! });
    row();
    const button = screen.getByRole('button', { name: /^Sidebar test, Unread, Last message from agent, Local Mac, Done, tests pass/ });
    // The row opens the session, not a menu; the menu is Shift+F10.
    expect(button).not.toHaveAttribute('aria-haspopup');
    expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+F10');
    expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument();
  });
});

describe('SessionRow narrow swipe tray', () => {
  function Harness() {
    const [openId, setOpenId] = useState<string | null>('s');
    return <MemoryRouter initialEntries={['/']}><SessionRow session={session} selected={false} pinned={false} narrow openSwipeId={openId} setOpenSwipeId={setOpenId} /><Location /></MemoryRouter>;
  }
  it('closes an open tray on tap instead of opening the chat (K-106)', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Sidebar test/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    // Closed now: the next tap opens the chat.
    fireEvent.click(screen.getByRole('button', { name: /Sidebar test/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/session/s');
  });
  it('Swipe > More shows the row menu and keeps it open (K-106)', async () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'More' }));
      // In a browser React commits the menu (and its effects) while that same
      // tap is still bubbling; it then reaches window. It must not close it.
      act(() => { window.dispatchEvent(new MouseEvent('click')); });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      act(() => { vi.runAllTimers(); });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      // A later tap elsewhere still dismisses it.
      fireEvent.click(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
  it('snaps a half-dragged row back when the browser cancels the touch (K-236)', () => {
    function Closed() {
      const [openId, setOpenId] = useState<string | null>(null);
      return <MemoryRouter><SessionRow session={session} selected={false} pinned={false} narrow openSwipeId={openId} setOpenSwipeId={setOpenId} /></MemoryRouter>;
    }
    render(<Closed />);
    const content = screen.getByRole('button', { name: /Sidebar test/ }).parentElement!;
    fireEvent.touchStart(content, { touches: [{ clientX: 300, clientY: 50 }] });
    fireEvent.touchMove(content, { touches: [{ clientX: 220, clientY: 52 }] });
    expect(content.style.transform).toBe('translateX(-80px)');
    // Safari takes over the edge gesture: touchcancel, never touchend.
    fireEvent.touchCancel(content, { touches: [] });
    expect(content.style.transform).toBe('translateX(0px)');
    // The next ordinary tap opens the chat normally.
    fireEvent.touchStart(content, { touches: [{ clientX: 100, clientY: 50 }] });
    fireEvent.touchEnd(content, { changedTouches: [{ clientX: 100, clientY: 50 }] });
    expect(content.style.transform).toBe('translateX(0px)');
  });
});
