/**
 * F2: inactive sessions are archived and left out of session_list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';

const DAY = 24 * 3600_000;

describe('session auto-archive', () => {
  let dir: string;
  let sm: SessionManager;

  beforeEach(() => {
    dir = join(tmpdir(), `kraki-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    sm = new SessionManager(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function session(lastMessageDaysAgo: number, opts: { pinned?: boolean; active?: boolean } = {}): string {
    const { sessionId } = sm.createSession('claude');
    sm.appendMessage(sessionId, 'user_message', JSON.stringify({ type: 'user_message', payload: { content: 'hi' } }));
    if (!opts.active) sm.markIdle(sessionId);
    if (opts.pinned) sm.setPin(sessionId, true);
    const at = new Date(Date.now() - lastMessageDaysAgo * DAY);
    utimesSync(join(dir, sessionId, 'messages.jsonl'), at, at);
    return sessionId;
  }

  it('archives only unpinned, idle sessions without messages for N days', () => {
    const old = session(20);
    const recent = session(3);
    const pinned = session(20, { pinned: true });
    const running = session(20, { active: true });

    expect(sm.autoArchive(14)).toEqual([old]);
    const listed = sm.getSessionList().map((s) => s.id).sort();
    expect(listed).toEqual([recent, pinned, running].sort());
    expect(sm.getSessionList({ archived: true }).map((s) => [s.id, s.archived])).toEqual([[old, true]]);
    expect(sm.countArchived()).toBe(1);
    expect(sm.getSessionList({ all: true })).toHaveLength(4);
  });

  it('never archives when the setting is 0, and skips sessions the caller keeps', () => {
    const old = session(30);
    expect(sm.autoArchive(0)).toEqual([]);
    expect(sm.autoArchive(14, (id) => id === old)).toEqual([]);
  });

  it('unarchiving brings the session back into the list', () => {
    const old = session(30);
    sm.autoArchive(14);
    expect(sm.getSessionList()).toHaveLength(0);
    expect(sm.setArchived(old, false)).toBe(true);
    expect(sm.setArchived(old, false)).toBe(false);
    expect(sm.getSessionList().map((s) => s.id)).toEqual([old]);
  });

  it('serves cached digests until the session changes', () => {
    const id = session(1);
    const first = sm.getSessionList()[0];
    expect(sm.getSessionList()[0]).toBe(first);
    sm.appendMessage(id, 'agent_message', JSON.stringify({ type: 'agent_message', payload: { content: 'new reply' } }));
    const second = sm.getSessionList()[0];
    expect(second).not.toBe(first);
    expect(second.lastSeq).toBeGreaterThan(first.lastSeq);
  });

  it('ignores stray directories', () => {
    mkdirSync(join(dir, 'not a session'));
    writeFileSync(join(dir, 'README'), 'x');
    session(1);
    expect(sm.getSessionList()).toHaveLength(1);
  });
});
