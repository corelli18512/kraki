import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MessageStore } from '../message-store.js';

describe('MessageStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kraki-msgstore-'));
    filePath = join(dir, 'messages.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    const store = new MessageStore(filePath);
    expect(store.getLastSeq()).toBe(0);
    expect(store.count()).toBe(0);
    expect(store.getAfterSeq(0)).toEqual([]);
  });

  it('appends and retrieves messages', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"hello"}');
    store.append(2, 'sess-1', 'tool_start', '{"toolName":"bash"}');
    store.append(3, 'sess-2', 'agent_message', '{"content":"world"}');

    expect(store.getLastSeq()).toBe(3);
    expect(store.count()).toBe(3);

    const all = store.getAfterSeq(0);
    expect(all).toHaveLength(3);
    expect(all[0].seq).toBe(1);
    expect(all[2].seq).toBe(3);
  });

  it('getAfterSeq filters correctly', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"a"}');
    store.append(2, 'sess-1', 'agent_message', '{"content":"b"}');
    store.append(3, 'sess-1', 'agent_message', '{"content":"c"}');
    store.append(4, 'sess-1', 'agent_message', '{"content":"d"}');

    const after2 = store.getAfterSeq(2);
    expect(after2).toHaveLength(2);
    expect(after2[0].seq).toBe(3);
    expect(after2[1].seq).toBe(4);
  });

  it('getAfterSeq respects limit', () => {
    const store = new MessageStore(filePath);
    for (let i = 1; i <= 10; i++) {
      store.append(i, 'sess-1', 'agent_message', `{"content":"msg${i}"}`);
    }

    const limited = store.getAfterSeq(0, 3);
    expect(limited).toHaveLength(3);
    expect(limited[0].seq).toBe(1);
    expect(limited[2].seq).toBe(3);
  });

  it('getAfterSeq returns empty when afterSeq >= lastSeq', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"a"}');
    store.append(2, 'sess-1', 'agent_message', '{"content":"b"}');

    expect(store.getAfterSeq(2)).toEqual([]);
    expect(store.getAfterSeq(100)).toEqual([]);
  });

  it('persists across instances', () => {
    const store1 = new MessageStore(filePath);
    store1.append(5, 'sess-1', 'agent_message', '{"content":"persistent"}');
    store1.append(10, 'sess-1', 'tool_start', '{"toolName":"bash"}');

    // New instance reads from same file
    const store2 = new MessageStore(filePath);
    expect(store2.getLastSeq()).toBe(10);
    expect(store2.count()).toBe(2);

    const msgs = store2.getAfterSeq(0);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBe(5);
    expect(msgs[0].payload).toBe('{"content":"persistent"}');
  });

  it('deleteSession removes only target session', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"keep"}');
    store.append(2, 'sess-2', 'agent_message', '{"content":"delete"}');
    store.append(3, 'sess-1', 'agent_message', '{"content":"keep2"}');
    store.append(4, 'sess-2', 'tool_start', '{"toolName":"bash"}');

    const pruned = store.deleteSession('sess-2');
    expect(pruned).toBe(2);
    expect(store.count()).toBe(2);

    const remaining = store.getAfterSeq(0);
    expect(remaining).toHaveLength(2);
    expect(remaining.every(m => m.sessionId === 'sess-1')).toBe(true);
  });

  it('prune by maxAge removes old messages', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"old"}');
    store.append(2, 'sess-1', 'agent_message', '{"content":"new"}');

    // Prune with maxAge of 0 (everything is "old")
    const pruned = store.prune({ maxAge: 0 });
    expect(pruned).toBe(2);
    expect(store.count()).toBe(0);
  });

  it('prune by maxCount keeps newest', () => {
    const store = new MessageStore(filePath);
    for (let i = 1; i <= 5; i++) {
      store.append(i, 'sess-1', 'agent_message', `{"content":"msg${i}"}`);
    }

    const pruned = store.prune({ maxCount: 3 });
    expect(pruned).toBe(2);
    expect(store.count()).toBe(3);

    const remaining = store.getAfterSeq(0);
    expect(remaining[0].seq).toBe(3);
    expect(remaining[2].seq).toBe(5);
  });

  it('handles append after prune correctly', () => {
    const store = new MessageStore(filePath);
    store.append(1, 'sess-1', 'agent_message', '{"content":"a"}');
    store.append(2, 'sess-1', 'agent_message', '{"content":"b"}');
    store.prune({ maxCount: 1 });

    store.append(3, 'sess-1', 'agent_message', '{"content":"c"}');
    expect(store.count()).toBe(2);
    expect(store.getLastSeq()).toBe(3);

    const msgs = store.getAfterSeq(0);
    expect(msgs[0].seq).toBe(2);
    expect(msgs[1].seq).toBe(3);
  });

  it('handles unicode content', () => {
    const store = new MessageStore(filePath);
    const payload = '{"content":"こんにちは 🌍 émojis"}';
    store.append(1, 'sess-1', 'agent_message', payload);

    const store2 = new MessageStore(filePath);
    const msgs = store2.getAfterSeq(0);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toBe(payload);
  });

  it('handles missing file gracefully', () => {
    const store = new MessageStore(join(dir, 'nonexistent', 'messages.jsonl'));
    expect(store.getLastSeq()).toBe(0);
    expect(store.count()).toBe(0);

    // Should be able to append (creates dirs)
    store.append(1, 'sess-1', 'agent_message', '{"content":"first"}');
    expect(store.count()).toBe(1);
  });
});
