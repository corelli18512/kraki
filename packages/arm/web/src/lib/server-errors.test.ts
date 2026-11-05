import { afterEach, describe, expect, it } from 'vitest';
import i18next from 'i18next';
import '../i18n';
import { requestErrorText, serverErrorText } from './server-errors';
import { AttachmentPullQueue } from './attachment-pull-queue';

afterEach(async () => { await i18next.changeLanguage('en'); });

describe('K-218: relay and attachment errors are shown localized, never raw', () => {
  it('maps actionable relay errors and hides protocol jargon', async () => {
    expect(serverErrorText('Device not found')).toBe('That device is no longer on this account.');
    expect(serverErrorText('unicast target is not reachable')).toBe("That computer can't be reached right now. Check that it is online.");
    expect(serverErrorText('multicast contains a forbidden target')).toBe("The server couldn't complete that. Try again.");
    expect(serverErrorText(undefined)).toBe("The server couldn't complete that. Try again.");
    await i18next.changeLanguage('zh-Hans');
    expect(serverErrorText('Device not found')).toBe('该设备已不在此账户中。');
    expect(serverErrorText('toString')).toBe('服务器无法完成此操作。请重试。');
  });

  it('frames create, copy and import failures by their own prefix and keeps the computer\'s detail', async () => {
    expect(requestErrorText("Couldn't create the session: model not available")).toBe("Couldn't create the session: model not available");
    expect(requestErrorText("Couldn't copy the session: Source session not found: s1")).toBe("Couldn't copy the session: Source session not found: s1");
    expect(requestErrorText("Couldn't import the session: no such file")).toBe("Couldn't import the session: no such file");
    expect(requestErrorText('Session already imported as sess_1')).toBe('This session has already been imported.');
    expect(requestErrorText('model not available')).toBe('model not available');
    await i18next.changeLanguage('zh-Hans');
    expect(requestErrorText("Couldn't create the session: model not available")).toBe('无法创建会话：model not available');
    expect(requestErrorText("Couldn't copy the session: Source session not found: s1")).toBe('无法复制会话：Source session not found: s1');
    expect(requestErrorText("Couldn't import the session: no such file")).toBe('无法导入会话：no such file');
    expect(requestErrorText('Session already imported as sess_1')).toBe('此会话已导入。');
    expect(requestErrorText(undefined)).toBe('电脑无法完成此操作。请重试。');
  });

  it('a timed-out attachment chunk reads in the UI language', async () => {
    await i18next.changeLanguage('zh-Hans');
    const failures: string[] = [];
    const queue = new AttachmentPullQueue(() => true, {
      chunkTimeoutMs: 1,
      maxRetries: 0,
      onFailure: (_s, _r, reason) => failures.push(reason),
    });
    queue.request('s1', { id: 'a'.repeat(32), mimeType: 'image/png', size: 1 } as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(failures).toEqual(['接收附件超时（第 1 部分，已尝试 1 次）。']);
  });
});
