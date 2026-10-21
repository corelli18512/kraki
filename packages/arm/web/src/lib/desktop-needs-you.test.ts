import { expect, it } from 'vitest';
import { desktopNeedsYou } from './desktop-needs-you';
import type { WebSessionSummary } from '../types/store';

it('MenuBarNeedsYou orders by timestamp/id descending, retains overflow, and never titles from the question', () => {
  const sessions = new Map<string, WebSessionSummary>();
  const previews = new Map();
  for (let i = 0; i < 7; i++) {
    const id = String(i);
    sessions.set(id, { id, deviceId: 'd', deviceName: 'PC', agent: 'pi', state: 'idle', messageCount: 0 });
    previews.set(id, { text: 'not a title', type: 'question', timestamp: i === 0 ? '2026-10-13' : '2026-10-12' });
  }
  previews.set('missing', { text: '', type: 'permission', timestamp: '2027' });
  const result = desktopNeedsYou(sessions, previews);
  expect(result.map((s) => s.id)).toEqual(['0', '6', '5', '4', '3', '2', '1']);
  expect(result[0]).toEqual({ id: '0', title: 'New Session', reason: 'Asked you a question' });
  sessions.set('0', { ...sessions.get('0')!, autoTitle: 'Auto' });
  previews.set('0', { text: '', type: 'permission', timestamp: '2027' });
  expect(desktopNeedsYou(sessions, previews)[0]).toEqual({ id: '0', title: 'Auto', reason: 'Waiting for your approval' });
});

it('recomputes tray reasons and fallback titles in the active language', async () => {
  const { i18next } = await import('../i18n');
  const sessions = new Map<string, WebSessionSummary>([['s', { id: 's', deviceId: 'd', deviceName: 'PC', agent: 'pi', state: 'idle', messageCount: 0 }]]);
  const previews = new Map([['s', { type: 'permission' as const, text: '', timestamp: '2026' }]]);
  try {
    await i18next.changeLanguage('zh-Hans');
    expect(desktopNeedsYou(sessions, previews)).toEqual([{ id: 's', title: '新建会话', reason: '正在等待你批准' }]);
    sessions.set('s', { ...sessions.get('s')!, title: 'User title' });
    expect(desktopNeedsYou(sessions, previews)[0].title).toBe('User title');
  } finally { await i18next.changeLanguage('en'); }
});
