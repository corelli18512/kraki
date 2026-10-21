import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopNotificationPresenter, formatDesktopPreview } from './desktop-notifications';

const json = (nid?: string) => JSON.stringify({ nid, sessionId: 's', type: 'question', summary: ' yes? ' });
describe('PushPreviewFormat desktop parity', () => {
  it.each([
    ['permission', 'Needs approval: Review the requested action.'],
    ['question', 'Question: Open the Session to respond.'],
    ['error', 'Failed: The turn did not finish.'],
    ['idle', 'Finished with no reply.'],
    ['unknown', 'Open Kraki to view the update.'],
  ])('formats %s fallback', (type, body) => {
    expect(formatDesktopPreview({ type, summary: ' \n\t' })).toMatchObject({ title: 'Kraki', body });
  });
  it('normalizes full summaries/titles without truncation and handles step counts', () => {
    expect(formatDesktopPreview({ type: 'permission', title: ' A\n B ', summary: ' run\tcmd ' })).toMatchObject({ title: 'A B', body: 'Needs approval: run cmd' });
    expect(formatDesktopPreview({ type: 'idle', steps: 1 }).body).toBe('Finished with 1 step and no reply.');
    expect(formatDesktopPreview({ type: 'idle', steps: 2 }).body).toBe('Finished with 2 steps and no reply.');
    expect(formatDesktopPreview({ type: 'idle', summary: 'x'.repeat(500) }).body).toHaveLength(500);
  });
});
describe('Mac NotificationDeduper desktop parity', () => {
  beforeEach(() => localStorage.clear());
  it.each([['head', 'link'], ['link', 'head']])('posts once for %s then %s', () => {
    const post = vi.fn();
    const p = new DesktopNotificationPresenter(localStorage, () => false, post);
    p.present(json('same')); p.present(json('same'));
    expect(post).toHaveBeenCalledTimes(1);
    new DesktopNotificationPresenter(localStorage, () => false, post).present(json('same'));
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('claims before suppression and permits distinct questions with no time throttle', () => {
    const post = vi.fn();
    const watching = vi.fn(() => true);
    const p = new DesktopNotificationPresenter(localStorage, watching, post);
    p.present(json('watched'));
    watching.mockReturnValue(false);
    p.present(json('watched')); p.present(json('one')); p.present(json('two'));
    expect(post).toHaveBeenCalledTimes(2);
  });
  it('claims while notifications are disabled, before the preference rule', () => {
    const post = vi.fn();
    const p = new DesktopNotificationPresenter(localStorage, () => false, post);
    localStorage.setItem('kraki:notifications.enabled', 'false');
    p.present(json('disabled'));
    localStorage.removeItem('kraki:notifications.enabled');
    p.present(json('disabled')); p.present(json('enabled'));
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('does not invent ids for missing/invalid nid and bounds persistence to 512', () => {
    const post = vi.fn();
    const p = new DesktopNotificationPresenter(localStorage, () => false, post);
    p.present(json()); p.present(json()); p.present(json('x'.repeat(65))); p.present(json('x'.repeat(65)));
    expect(post).toHaveBeenCalledTimes(4);
    for (let i = 0; i < 513; i++) p.present(json(String(i)));
    p.present(json('0'));
    expect(post).toHaveBeenCalledTimes(518);
    expect(JSON.parse(localStorage.getItem('kraki-desktop.notifications.recentIds')!)).toHaveLength(512);
  });
});

it('formats notifications in the active language at delivery time, keeping server summaries intact', async () => {
  const { i18next } = await import('../i18n');
  try {
    await i18next.changeLanguage('zh-Hans');
    expect(formatDesktopPreview({ type: 'permission' }).body).toBe('需要批准：请查看请求的操作。');
    expect(formatDesktopPreview({ type: 'question', summary: 'User question?' }).body).toBe('提问：User question?');
    expect(formatDesktopPreview({ type: 'idle', steps: 1 }).body).toBe('已完成 1 个步骤，无回复。');
    expect(formatDesktopPreview({ type: 'idle', steps: 3 }).body).toBe('已完成 3 个步骤，无回复。');
    expect(formatDesktopPreview({ type: 'idle', summary: 'Server reply' }).body).toBe('Server reply');
  } finally { await i18next.changeLanguage('en'); }
});
