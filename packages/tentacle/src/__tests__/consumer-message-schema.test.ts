import { describe, expect, it } from 'vitest';
import { parseConsumerMessage, CONSUMER_MESSAGE_TYPES } from '@kraki/protocol/schemas';

const env = { deviceId: 'app_1', seq: 0, timestamp: '2026-10-12T00:00:00.000Z' };
const ok = (m: unknown) => parseConsumerMessage(m).ok;

/** Messages exactly as the current apps build them (iOS CommandSender /
 *  AppState / MessageRouter, web commands.ts / outbox.ts / ws-client.ts),
 *  including fields the interfaces don't list. Every one must pass. */
const SENT_BY_APPS: Array<[string, Record<string, unknown>]> = [
  ['ios send_input', { ...env, type: 'send_input', sessionId: 's1', payload: { text: 'hi', clientId: 'C1', delivery: 'steer', attachments: [{ type: 'content_ref', id: 'a1', mimeType: 'image/jpeg', size: 1200, width: 800, height: 600 }] } }],
  ['ios send_input image', { ...env, type: 'send_input', sessionId: 's1', payload: { text: '', clientId: 'C2', attachments: [{ type: 'image', mimeType: 'image/png', data: 'iVBOR' }], answerTo: 'q1' } }],
  ['ios approve', { ...env, type: 'approve', sessionId: 's1', payload: { permissionId: 'p1' } }],
  ['ios deny', { ...env, type: 'deny', sessionId: 's1', payload: { permissionId: 'p1', reason: 'no' } }],
  ['old app always_allow', { ...env, type: 'always_allow', sessionId: 's1', payload: { permissionId: 'p1', toolKind: 'shell' } }],
  ['ios create_session', { ...env, type: 'create_session', payload: { requestId: 'r1', targetDeviceId: 't1', agentId: 'pi', model: 'm', reasoningEffort: 'high', cwd: '/tmp' } }],
  ['web create_session without model/cwd', { ...env, type: 'create_session', payload: { requestId: 'r1', targetDeviceId: 't1', agentId: 'copilot' } }],
  ['ios fork_session', { ...env, type: 'fork_session', sessionId: 's1', payload: { requestId: 'r2', sourceSessionId: 's1' } }],
  ['ios set_session_mode', { ...env, type: 'set_session_mode', sessionId: 's1', payload: { mode: 'safe' } }],
  ['old app set_session_mode execute', { ...env, type: 'set_session_mode', sessionId: 's1', payload: { mode: 'execute' } }],
  ['ios set_session_model', { ...env, type: 'set_session_model', sessionId: 's1', payload: { model: 'm', reasoningEffort: 'low' } }],
  ['ios kill_session', { ...env, type: 'kill_session', sessionId: 's1', payload: {} }],
  ['ios abort_session', { ...env, type: 'abort_session', sessionId: 's1', payload: {} }],
  ['ios delete_session', { ...env, type: 'delete_session', sessionId: 's1', payload: {} }],
  ['ios mark_read', { ...env, type: 'mark_read', sessionId: 's1', payload: { seq: 12 } }],
  ['ios mark_unread', { ...env, type: 'mark_unread', sessionId: 's1', payload: {} }],
  ['ios request_session_messages', { ...env, type: 'request_session_messages', sessionId: 's1', payload: { sessionId: 's1', beforeSeq: 40 } }],
  ['ios request_session_messages latest', { ...env, type: 'request_session_messages', sessionId: 's1', payload: { sessionId: 's1' } }],
  ['ios request_session_messages_range', { ...env, type: 'request_session_messages_range', sessionId: 's1', payload: { sessionId: 's1', fromSeq: 1, toSeq: 9 } }],
  ['web range with NaN bounds (null in JSON)', JSON.parse(JSON.stringify({ ...env, type: 'request_session_messages_range', sessionId: 's1', payload: { sessionId: 's1', fromSeq: Number.NaN, toSeq: 9 } }))],
  ['ios request_turn_trace', { ...env, type: 'request_turn_trace', sessionId: 's1', payload: { sessionId: 's1', bubbleSeq: 7 } }],
  ['ios request_card', { ...env, type: 'request_card', sessionId: 's1', payload: { sessionId: 's1' } }],
  ['ios rename_session', { ...env, type: 'rename_session', sessionId: 's1', payload: { title: 'New' } }],
  ['ios pin_session', { ...env, type: 'pin_session', sessionId: 's1', payload: { pinned: true } }],
  ['ios archive_session', { ...env, type: 'archive_session', sessionId: 's1', payload: { archived: false } }],
  ['ios request_archived_sessions', { ...env, type: 'request_archived_sessions', targetDeviceId: 't1', payload: {} }],
  ['web request_archived_sessions', { ...env, type: 'request_archived_sessions', payload: { targetDeviceId: 't1' } }],
  ['ios set_auto_archive_days', { ...env, type: 'set_auto_archive_days', targetDeviceId: 't1', payload: { days: 30 } }],
  ['ios delete_archived_sessions', { ...env, type: 'delete_archived_sessions', targetDeviceId: 't1', payload: {} }],
  ['ios request_local_sessions', { ...env, type: 'request_local_sessions', targetDeviceId: 't1', payload: { filter: { search: 'x', liveOnly: true } } }],
  ['ios import_session', { ...env, type: 'import_session', payload: { requestId: 'r3', localSessionId: 'l1', targetDeviceId: 't1', meta: { cwd: '/x', source: 'copilot-cli' } } }],
  ['ios request_attachment', { deviceId: 'app_1', type: 'request_attachment', sessionId: 's1', payload: { id: 'a1', sessionId: 's1', mode: 'paced', index: 3 } }],
  ['ios set_session_subscription', { ...env, type: 'set_session_subscription', payload: { sessionId: 's1' } }],
  ['ios set_session_subscription none', { ...env, type: 'set_session_subscription', payload: { sessionId: null } }],
  ['mac set_session_subscription with requestId (local link)', { ...env, type: 'set_session_subscription', payload: { sessionId: 's1', requestId: 'sub-3' } }],
  ['ios client_features', { ...env, type: 'client_features', payload: { features: ['fragments'] } }],
  ['web request_usage_history', { ...env, type: 'request_usage_history', payload: { since: 0 } }],
  ['ios refresh_account_usage', { ...env, type: 'refresh_account_usage', targetDeviceId: 't1', payload: { requestId: 'u1' } }],
  ['ios update_device', { ...env, type: 'update_device', targetDeviceId: 't1', payload: { requestId: 'u2', when: 'idle' } }],
  ['web client_log', { deviceId: 'app_1', type: 'client_log', payload: { entries: [{ ts: '2026-10-14T06:23:07.059Z', level: 'info', scope: 'ws-client', message: 'm' }], targetDeviceId: 't1' } }],
];

describe('parseConsumerMessage', () => {
  it.each(SENT_BY_APPS)('accepts %s', (_name, message) => {
    const result = parseConsumerMessage(message);
    if (!result.ok) throw new Error(result.problem);
  });

  it('covers every message type the protocol knows', () => {
    const sampled = new Set(SENT_BY_APPS.map(([, m]) => m.type as string));
    const missing = [...CONSUMER_MESSAGE_TYPES].filter((t) => !sampled.has(t) && t !== 'request_session_replay');
    expect(missing).toEqual([]);
  });

  it('keeps fields it does not know (a newer app may add some)', () => {
    const result = parseConsumerMessage({ ...env, type: 'import_session', future: 1, payload: { requestId: 'r', localSessionId: 'l', targetDeviceId: 't1', extra: { a: 1 } } });
    expect(result.ok && result.message).toMatchObject({ future: 1, payload: { targetDeviceId: 't1', extra: { a: 1 } } });
  });

  it('reports an unknown type as such (not as malformed)', () => {
    const result = parseConsumerMessage({ ...env, type: 'brand_new_feature', payload: {} });
    expect(result).toMatchObject({ ok: false, type: 'brand_new_feature', unknownType: true });
    expect(parseConsumerMessage(null)).toMatchObject({ ok: false, unknownType: true });
    expect(parseConsumerMessage('nope')).toMatchObject({ ok: false, unknownType: true });
  });

  it.each<[string, Record<string, unknown>]>([
    ['send_input without text', { type: 'send_input', sessionId: 's1', payload: { clientId: 'c' } }],
    ['send_input with numeric text', { type: 'send_input', sessionId: 's1', payload: { text: 5 } }],
    ['image attachment without data', { type: 'send_input', sessionId: 's1', payload: { text: '', attachments: [{ type: 'image', mimeType: 'image/png' }] } }],
    ['image attachment with numeric data', { type: 'send_input', sessionId: 's1', payload: { text: '', attachments: [{ type: 'image', mimeType: 'image/png', data: 7 }] } }],
    ['content_ref without size', { type: 'send_input', sessionId: 's1', payload: { text: '', attachments: [{ type: 'content_ref', id: 'a', mimeType: 'image/png' }] } }],
    ['attachment of an unknown kind', { type: 'send_input', sessionId: 's1', payload: { text: '', attachments: [{ type: 'video', url: 'x' }] } }],
    ['attachments not an array', { type: 'send_input', sessionId: 's1', payload: { text: '', attachments: 'x' } }],
    ['approve without permissionId', { type: 'approve', sessionId: 's1', payload: {} }],
    ['pin_session with a string', { type: 'pin_session', sessionId: 's1', payload: { pinned: 'yes' } }],
    ['mark_read with a string seq', { type: 'mark_read', sessionId: 's1', payload: { seq: '5' } }],
    ['request_attachment without id', { type: 'request_attachment', sessionId: 's1', payload: { sessionId: 's1' } }],
    ['sessionId not a string', { type: 'kill_session', sessionId: 42, payload: {} }],
    ['payload not an object', { type: 'send_input', sessionId: 's1', payload: 'hi' }],
  ])('rejects %s, naming the field but not its value', (_name, message) => {
    const result = parseConsumerMessage(message);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unknownType).toBe(false);
    expect(result.type).toBe(message.type);
    expect(result.problem).not.toMatch(/yes|hi\b|"5"|video/);
  });

  it('does not change the message it accepts', () => {
    const message = SENT_BY_APPS[0][1];
    const result = parseConsumerMessage(message);
    expect(result.ok && result.message).toEqual(message);
  });

  it('checks a message in well under a millisecond', () => {
    const message = SENT_BY_APPS[0][1];
    const start = performance.now();
    for (let i = 0; i < 2000; i++) ok(message);
    expect((performance.now() - start) / 2000).toBeLessThan(0.5); // ms per message
  });
});
