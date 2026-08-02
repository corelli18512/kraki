import type { ContentRef } from '@kraki/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentPullQueue } from './attachment-pull-queue';

function ref(id: string, mimeType = 'application/octet-stream'): ContentRef {
  return { type: 'content_ref', id, mimeType, size: 1 };
}

describe('AttachmentPullQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('round-robins concurrent attachments one chunk at a time', () => {
    const sent: Array<{ sessionId: string; id: string; index: number }> = [];
    const queue = new AttachmentPullQueue((request) => {
      sent.push(request);
      return true;
    });

    queue.request('session-a', ref('attachment-a'));
    queue.request('session-b', ref('attachment-b'));
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

  it('prioritizes a newly queued image ahead of waiting text attachments', () => {
    const sent: Array<{ sessionId: string; id: string; index: number }> = [];
    const queue = new AttachmentPullQueue((request) => {
      sent.push(request);
      return true;
    });

    queue.request('session', ref('active-text', 'text/plain'));
    queue.request('session', ref('waiting-text', 'application/json'));
    queue.request('session', ref('image', 'image/png'));
    queue.handleChunk({ sessionId: 'session', id: 'active-text', index: 0, total: 1, paced: true });

    expect(sent.at(-1)).toEqual({ sessionId: 'session', id: 'image', index: 0 });
  });

  it('releases the queue when an older tentacle returns an unpaced response', () => {
    const send = vi.fn(() => true);
    const queue = new AttachmentPullQueue(send);

    queue.request('session-a', ref('legacy'));
    queue.request('session-b', ref('next'));
    queue.handleChunk({ sessionId: 'session-a', id: 'legacy', index: 0, total: 3 });

    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'session-b', id: 'next', index: 0 }));
  });

  it('retries the in-flight chunk after reconnect', () => {
    let connected = true;
    const sent: Array<{ sessionId: string; id: string; index: number }> = [];
    const queue = new AttachmentPullQueue((request) => {
      if (!connected) return false;
      sent.push(request);
      return true;
    });

    queue.request('session-a', ref('attachment-a'));
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

  it('retries a timed-out chunk with a finite budget', () => {
    const send = vi.fn(() => true);
    const failure = vi.fn();
    const queue = new AttachmentPullQueue(send, {
      chunkTimeoutMs: 100,
      maxRetries: 2,
      onFailure: failure,
    });

    queue.request('session-a', ref('attachment-a'));
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(100);

    expect(send).toHaveBeenCalledTimes(3);
    expect(failure).not.toHaveBeenCalled();

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 0, total: 1, paced: true });
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('fails an exhausted chunk and continues with the next attachment', () => {
    const send = vi.fn(() => true);
    const failure = vi.fn();
    const failedRef = ref('stuck-image', 'image/png');
    const queue = new AttachmentPullQueue(send, {
      chunkTimeoutMs: 100,
      maxRetries: 1,
      onFailure: failure,
    });

    queue.request('session-a', failedRef);
    queue.request('session-b', ref('next'));
    vi.advanceTimersByTime(200);

    expect(failure).toHaveBeenCalledWith(
      'session-a',
      failedRef,
      'Timed out receiving attachment chunk 1 after 2 attempts',
    );
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'session-b', id: 'next', index: 0 }));
  });

  it('ignores duplicate and out-of-order chunks', () => {
    const send = vi.fn(() => true);
    const queue = new AttachmentPullQueue(send);
    queue.request('session-a', ref('attachment-a'));

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 1, total: 3, paced: true });
    expect(send).toHaveBeenCalledTimes(1);

    queue.handleChunk({ sessionId: 'session-a', id: 'attachment-a', index: 0, total: 3, paced: true });
    expect(send).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'session-a', id: 'attachment-a', index: 1 }));
  });
});
