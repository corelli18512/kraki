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
