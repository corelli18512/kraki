import { describe, expect, it, vi } from 'vitest';

import { AttachmentPullQueue } from './attachment-pull-queue';

describe('AttachmentPullQueue', () => {
  it('round-robins concurrent attachments one chunk at a time', () => {
    const sent: Array<{ sessionId: string; id: string; index: number }> = [];
    const queue = new AttachmentPullQueue((request) => {
      sent.push(request);
      return true;
    });

    queue.request('session-a', 'attachment-a');
    queue.request('session-b', 'attachment-b');
    expect(sent).toEqual([
      { sessionId: 'session-a', id: 'attachment-a', index: 0 },
    ]);

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 0, total: 3, paced: true });
    expect(sent.at(-1)).toEqual({ sessionId: 'session-b', id: 'attachment-b', index: 0 });

    queue.handleChunk({ sessionId: 'session-b', id: 'attachment-b', index: 0, total: 2, paced: true });
    expect(sent.at(-1)).toEqual({ sessionId: 'session-a', id: 'attachment-a', index: 1 });

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 1, total: 3, paced: true });
    expect(sent.at(-1)).toEqual({ sessionId: 'session-b', id: 'attachment-b', index: 1 });
  });

  it('releases the queue when an older tentacle returns an unpaced response', () => {
    const send = vi.fn(() => true);
    const queue = new AttachmentPullQueue(send);

    queue.request('session-a', 'legacy');
    queue.request('session-b', 'next');
    queue.handleChunk({ sessionId: 'session-a', id: 'legacy', index: 0, total: 3 });

    expect(send).toHaveBeenNthCalledWith(2, { sessionId: 'session-b', id: 'next', index: 0 });
  });

  it('retries the in-flight chunk after reconnect', () => {
    let connected = true;
    const sent: Array<{ sessionId: string; id: string; index: number }> = [];
    const queue = new AttachmentPullQueue((request) => {
      if (!connected) return false;
      sent.push(request);
      return true;
    });

    queue.request('session-a', 'attachment-a');
    queue.disconnect();
    connected = false;
    queue.resume();
    expect(sent).toHaveLength(1);

    connected = true;
    queue.resume();
    expect(sent).toEqual([
      { sessionId: 'session-a', id: 'attachment-a', index: 0 },
      { sessionId: 'session-a', id: 'attachment-a', index: 0 },
    ]);
  });

  it('ignores duplicate and out-of-order chunks', () => {
    const send = vi.fn(() => true);
    const queue = new AttachmentPullQueue(send);
    queue.request('session-a', 'attachment-a');

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 1, total: 3, paced: true });
    expect(send).toHaveBeenCalledTimes(1);

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 0, total: 3, paced: true });
    expect(send).toHaveBeenNthCalledWith(2, { sessionId: 'session-a', id: 'attachment-a', index: 1 });
  });
});
