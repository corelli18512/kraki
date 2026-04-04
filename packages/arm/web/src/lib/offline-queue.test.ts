import { describe, it, expect, beforeEach } from 'vitest';
import { OfflineQueue } from './offline-queue';

// localStorage mock is provided by vitest's jsdom environment

beforeEach(() => {
  localStorage.clear();
});

describe('OfflineQueue', () => {
  describe('isQueueable', () => {
    it('accepts eligible types', () => {
      expect(OfflineQueue.isQueueable('mark_read')).toBe(true);
      expect(OfflineQueue.isQueueable('set_session_mode')).toBe(true);
      expect(OfflineQueue.isQueueable('delete_session')).toBe(true);
    });

    it('rejects ineligible types', () => {
      expect(OfflineQueue.isQueueable('send_input')).toBe(false);
      expect(OfflineQueue.isQueueable('approve')).toBe(false);
      expect(OfflineQueue.isQueueable('kill_session')).toBe(false);
      expect(OfflineQueue.isQueueable('create_session')).toBe(false);
    });
  });

  describe('enqueue and drain', () => {
    it('enqueues and drains messages for the correct device', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'set_session_mode', sessionId: 's1', payload: { mode: 'execute' } }, 'dev-1');

      expect(q.size).toBe(2);

      const drained = q.drain('dev-1');
      expect(drained).toHaveLength(2);
      expect(drained[0].type).toBe('mark_read');
      expect(drained[1].type).toBe('set_session_mode');
      expect(q.size).toBe(0);
    });

    it('does not drain messages for other devices', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'mark_read', sessionId: 's2', payload: { seq: 3 } }, 'dev-2');

      const drained = q.drain('dev-1');
      expect(drained).toHaveLength(1);
      expect(q.size).toBe(1); // dev-2's message remains
    });

    it('injects targetDeviceId into drained messages', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');

      const drained = q.drain('dev-1');
      expect((drained[0].payload as Record<string, unknown>).targetDeviceId).toBe('dev-1');
    });
  });

  describe('dedup', () => {
    it('replaces existing entry with same sessionId and type', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'set_session_mode', sessionId: 's1', payload: { mode: 'discuss' } }, 'dev-1');
      q.enqueue({ type: 'set_session_mode', sessionId: 's1', payload: { mode: 'execute' } }, 'dev-1');

      expect(q.size).toBe(1);
      const drained = q.drain('dev-1');
      expect((drained[0].payload as Record<string, unknown>).mode).toBe('execute');
    });

    it('keeps entries with different sessionIds', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'mark_read', sessionId: 's2', payload: { seq: 3 } }, 'dev-1');

      expect(q.size).toBe(2);
    });
  });

  describe('delete_session supersedes other messages', () => {
    it('removes queued messages for the same session when delete is enqueued', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'set_session_mode', sessionId: 's1', payload: { mode: 'execute' } }, 'dev-1');

      expect(q.size).toBe(2);

      q.enqueue({ type: 'delete_session', sessionId: 's1', payload: {} }, 'dev-1');

      expect(q.size).toBe(1);
      const drained = q.drain('dev-1');
      expect(drained[0].type).toBe('delete_session');
    });

    it('does not remove messages for other sessions', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'mark_read', sessionId: 's2', payload: { seq: 3 } }, 'dev-1');
      q.enqueue({ type: 'delete_session', sessionId: 's1', payload: {} }, 'dev-1');

      expect(q.size).toBe(2); // s2's mark_read + s1's delete
    });
  });

  describe('persistence', () => {
    it('survives reconstruction from localStorage', () => {
      const q1 = new OfflineQueue();
      q1.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');

      // Reconstruct — should load from localStorage
      const q2 = new OfflineQueue();
      expect(q2.size).toBe(1);

      const drained = q2.drain('dev-1');
      expect(drained).toHaveLength(1);
      expect(drained[0].type).toBe('mark_read');
    });
  });

  describe('expiry', () => {
    it('drops entries older than 7 days on drain', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');

      // Manually age the entry in localStorage
      const raw = JSON.parse(localStorage.getItem('kraki-offline-queue')!);
      raw[0].addedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem('kraki-offline-queue', JSON.stringify(raw));

      // Reconstruct and drain
      const q2 = new OfflineQueue();
      const drained = q2.drain('dev-1');
      expect(drained).toHaveLength(0);
      expect(q2.size).toBe(0);
    });
  });

  describe('clear', () => {
    it('removes all entries', () => {
      const q = new OfflineQueue();
      q.enqueue({ type: 'mark_read', sessionId: 's1', payload: { seq: 5 } }, 'dev-1');
      q.enqueue({ type: 'mark_read', sessionId: 's2', payload: { seq: 3 } }, 'dev-2');

      q.clear();
      expect(q.size).toBe(0);
      expect(localStorage.getItem('kraki-offline-queue')).toBe('[]');
    });
  });
});
