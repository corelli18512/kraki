/**
 * Triage #14: a multi-select question reaches the apps as a flag on
 * `agent_message.payload.question`, not as an English hint in its text.
 * Real SessionManager on a temp dir, no sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../session-manager.js';
import { RelayClient } from '../relay-client.js';
import type { AgentAdapter } from '../adapters/base.js';

vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kraki-question-multiselect-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function questionRows(sm: SessionManager, sessionId: string): Array<Record<string, unknown>> {
  return sm.getMessagesAfterSeq(sessionId, 0)
    .map((m) => (JSON.parse(m.payload) as { payload: { question?: Record<string, unknown> } }).payload.question)
    .filter((q): q is Record<string, unknown> => !!q);
}

describe('question multiSelect flag (triage #14)', () => {
  it('is carried on the stored question, only when there are choices to pick from', () => {
    const adapter = {
      onQuestionRequest: null,
      generateTitle: vi.fn(async () => null),
      getSessionUsage: vi.fn(() => null),
    } as unknown as AgentAdapter;
    const sm = new SessionManager(dir);
    new RelayClient(adapter, sm, { relayUrl: 'ws://unused', authMethod: 'open', device: { name: 'Test', role: 'tentacle' } });
    const { sessionId } = sm.createSession('claude');

    adapter.onQuestionRequest!(sessionId, { id: 'q1', question: 'Which databases?', choices: ['Postgres', 'SQLite'], multiSelect: true });
    adapter.onQuestionRequest!(sessionId, { id: 'q2', question: 'Which one?', choices: ['A', 'B'] });
    adapter.onQuestionRequest!(sessionId, { id: 'q3', question: 'Anything else?', multiSelect: true });

    expect(questionRows(sm, sessionId)).toEqual([
      { id: 'q1', text: 'Which databases?', choices: ['Postgres', 'SQLite'], multiSelect: true },
      { id: 'q2', text: 'Which one?', choices: ['A', 'B'] },
      { id: 'q3', text: 'Anything else?' },
    ]);
  });
});
