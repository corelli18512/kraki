import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types/store';
import { projectSpineMessages } from './turn-projection';

describe('projectSpineMessages', () => {
  it('folds error + final agent reply + failed status into one terminal bubble', () => {
    const messages: ChatMessage[] = [
      { type: 'user_message', deviceId: 'd1', seq: 70, timestamp: '', sessionId: 's1', payload: { content: 'retry' } } as ChatMessage,
      { type: 'error', deviceId: 'd1', seq: 71, timestamp: '', sessionId: 's1', payload: { message: '524 status code (no body)' } } as ChatMessage,
      { type: 'error', deviceId: 'd1', seq: 72, timestamp: '', sessionId: 's1', payload: { message: '524 status code (no body)' } } as ChatMessage,
      { type: 'agent_message', deviceId: 'd1', seq: 73, timestamp: '', sessionId: 's1', payload: { content: 'Restarted successfully', steps: 2 } } as ChatMessage,
      { type: 'turn_status', deviceId: 'd1', seq: 74, timestamp: '', sessionId: 's1', payload: {
        draft: '',
        action: { type: 'failed', payload: { message: '524 status code (no body)', source: 'backend', failedAt: '' } },
        finishedAt: '',
        steps: 2,
      } } as ChatMessage,
      { type: 'idle', deviceId: 'd1', seq: 75, timestamp: '', sessionId: 's1', payload: { reason: 'failed' } } as ChatMessage,
    ];

    const projected = projectSpineMessages(messages);
    expect(projected.map((message) => message.type)).toEqual(['user_message', 'turn_status', 'idle']);
    expect(projected[1].payload.draft).toBe('Restarted successfully');
  });

  it('preserves final reply attachments when folding into terminal status', () => {
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' };
    const projected = projectSpineMessages([
      { type: 'agent_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1', payload: { content: '', attachments: [image] } } as ChatMessage,
      { type: 'turn_status', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 's1', payload: {
        draft: '',
        action: { type: 'failed', payload: { message: 'failed', source: 'backend', failedAt: '' } },
        finishedAt: '',
      } } as ChatMessage,
    ]);

    expect(projected).toHaveLength(1);
    expect((projected[0].payload as { attachments?: unknown[] }).attachments).toEqual([image]);
  });

  it('preserves an explicit terminal draft over an earlier agent reply', () => {
    const projected = projectSpineMessages([
      { type: 'agent_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1', payload: { content: 'Earlier' } } as ChatMessage,
      { type: 'turn_status', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 's1', payload: {
        draft: 'Frozen draft',
        action: { type: 'user_abort', payload: { abortedAt: '' } },
        finishedAt: '',
      } } as ChatMessage,
    ]);

    expect(projected).toHaveLength(1);
    expect(projected[0].payload.draft).toBe('Frozen draft');
  });

  it('hides a non-terminal error from the top-level spine without dropping normal replies', () => {
    const projected = projectSpineMessages([
      { type: 'user_message', deviceId: 'd1', seq: 1, timestamp: '', sessionId: 's1', payload: { content: 'go' } } as ChatMessage,
      { type: 'error', deviceId: 'd1', seq: 2, timestamp: '', sessionId: 's1', payload: { message: 'recoverable' } } as ChatMessage,
      { type: 'agent_message', deviceId: 'd1', seq: 3, timestamp: '', sessionId: 's1', payload: { content: 'continued' } } as ChatMessage,
      { type: 'idle', deviceId: 'd1', seq: 4, timestamp: '', sessionId: 's1', payload: { reason: 'completed' } } as ChatMessage,
    ]);

    expect(projected.map((message) => message.type)).toEqual(['user_message', 'agent_message', 'idle']);
  });
});
