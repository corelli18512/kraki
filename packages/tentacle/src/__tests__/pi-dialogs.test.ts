/**
 * Pi extension dialogs: Kraki's own (ask_user, permission gate — tagged with
 * KRAKI_DIALOG_PREFIX) versus other loaded extensions' dialogs, and delegate
 * mode auto-answering the agent's own questions.
 */
import { describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi.js';
import { handleEvent } from '../adapters/pi-events.js';
import { KRAKI_DIALOG_PREFIX } from '../adapters/pi-kraki-tools.js';
import { DELEGATE_ANSWER } from '../adapters/permission-policy.js';
import { turnFixture } from './helpers/turn-fixture.js';

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function setup(mode: string) {
  const adapter = new PiAdapter({ cliPath: '/unused' });
  const sid = 's1';
  const proc = { alive: true, request: vi.fn().mockResolvedValue({}), kill: vi.fn(), sendRaw: vi.fn() };
  const session = {
    proc, cwd: '/tmp', model: 'p/m', mode, usage: {}, lastActivity: Date.now(),
    turn: turnFixture(adapter, sid, { open: true }),
    exitObserved: false, pendingPerms: new Map<string, string>(), pendingQuestions: new Map<string, string>(),
    lastStopReason: undefined, pendingMaintenanceIdle: false, aborting: false,
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sid, session);
  Object.assign(adapter, { persistMeta: () => {} });
  const onQuestionRequest = vi.fn();
  const onPermissionRequest = vi.fn();
  const onQuestionAutoResolved = vi.fn();
  Object.assign(adapter, { onQuestionRequest, onPermissionRequest, onQuestionAutoResolved });
  const ui = (e: Record<string, unknown>) => handleEvent(adapter, sid, { type: 'extension_ui_request', ...e });
  return { adapter, sid, proc, session, ui, onQuestionRequest, onPermissionRequest, onQuestionAutoResolved };
}

const envelope = (text: string) => JSON.stringify({ __krakiAnswer: 1, text });

describe('pi dialogs of other extensions', () => {
  it('select gets a plain question card and the plain chosen value', async () => {
    const t = setup('auto');
    await t.ui({ id: 'd1', method: 'select', title: 'Pick env', options: ['staging', 'prod'] });
    expect(t.onQuestionRequest).toHaveBeenCalledWith('s1', { id: 'd1', question: 'Pick env', choices: ['staging', 'prod'] });
    expect(await t.adapter.respondToQuestion('s1', 'd1', 'staging', false)).toBe('accepted');
    expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'd1', value: 'staging' });
  });

  it('editor is answered (it no longer waits forever)', async () => {
    const t = setup('auto');
    await t.ui({ id: 'd2', method: 'editor', title: 'Commit message' });
    expect(t.onQuestionRequest).toHaveBeenCalledWith('s1', { id: 'd2', question: 'Commit message', choices: undefined });
    await t.adapter.respondToQuestion('s1', 'd2', 'fix: x', true);
    expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'd2', value: 'fix: x' });
  });

  it('confirm is shown to the human even in auto/delegate, never run through tool policy', async () => {
    for (const mode of ['auto', 'delegate', 'safe']) {
      const t = setup(mode);
      await t.ui({ id: 'd3', method: 'confirm', title: 'Deploy?', message: 'Ship to prod' });
      expect(t.proc.sendRaw).not.toHaveBeenCalled();
      expect(t.onPermissionRequest).not.toHaveBeenCalled();
      expect(t.onQuestionRequest).toHaveBeenCalledWith('s1', { id: 'd3', question: 'Deploy?\n\nShip to prod', choices: ['Yes', 'No'] });
      await t.adapter.respondToQuestion('s1', 'd3', 'No', false);
      expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'd3', confirmed: false });
    }
  });

  it('a confirm titled like a read-only tool is not auto-approved in safe', async () => {
    const t = setup('safe');
    await t.ui({ id: 'd4', method: 'confirm', title: 'read', message: 'Wipe the cache?' });
    expect(t.proc.sendRaw).not.toHaveBeenCalled();
    await t.adapter.respondToQuestion('s1', 'd4', 'Yes', false);
    expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'd4', confirmed: true });
  });
});

describe('pi delegate mode questions', () => {
  it('auto-answers Kraki ask_user without a card', async () => {
    const t = setup('delegate');
    await t.ui({ id: 'q1', method: 'select', title: `${KRAKI_DIALOG_PREFIX}Which one?`, options: ['a', 'b'] });
    expect(t.onQuestionRequest).not.toHaveBeenCalled();
    expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'q1', value: envelope(DELEGATE_ANSWER) });
    expect(t.session.pendingQuestions.size).toBe(0);
  });

  it('entering delegate answers the open ask_user but not another extension dialog', async () => {
    const t = setup('auto');
    await t.ui({ id: 'q1', method: 'input', title: `${KRAKI_DIALOG_PREFIX}Name?` });
    await t.ui({ id: 'd1', method: 'input', title: 'Other extension asks' });
    t.adapter.setSessionMode('s1', 'delegate');
    expect(t.proc.sendRaw).toHaveBeenCalledWith({ type: 'extension_ui_response', id: 'q1', value: envelope(DELEGATE_ANSWER) });
    expect(t.onQuestionAutoResolved).toHaveBeenCalledWith('s1', 'q1');
    expect(t.proc.sendRaw).toHaveBeenCalledTimes(1);
    expect([...t.session.pendingQuestions.keys()]).toEqual(['d1']);
  });
});
