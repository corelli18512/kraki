// Synthetic range responder only; reconciliation, persistence and rendering use product modules.
import { useStore } from '../../hooks/useStore';
import { messageProvider } from '../message-provider';
import * as db from '../message-db';
import type { ChatMessage } from '../../types/store';

export const requests: Array<{ sessionId: string; fromSeq: number; toSeq: number }> = [];
let generation = 0;
export function rows(sessionId: string, from: number, to: number): ChatMessage[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({
    type: 'user_message', sessionId, deviceId: 'synthetic-device', seq: from + i,
    timestamp: '2026-10-15T00:00:00Z', payload: { content: `History row ${from + i}` },
  }));
}
export async function setup(head = 100, initial = 0, available = true) {
  messageProvider.clear();
  useStore.getState().reset();
  await db.clearAllMessages();
  requests.length = 0;
  const sessionId = `history-ui-${++generation}`;
  useStore.getState().setStatus('connected');
  useStore.getState().setDevices([{ id: 'synthetic-device', name: 'Synthetic only', role: 'tentacle', online: true }]);
  useStore.getState().setSessions([
    { id: sessionId, deviceId: 'synthetic-device', deviceName: 'Synthetic only', agent: 'pi', state: 'idle', messageCount: head, lastSeq: head },
    { id: `${sessionId}-other`, deviceId: 'synthetic-device', deviceName: 'Synthetic only', agent: 'pi', state: 'idle', messageCount: 0, lastSeq: 0 },
  ]);
  if (initial) {
    const cached = rows(sessionId, 1, initial);
    await db.putMessages(sessionId, cached);
    useStore.getState().prependMessages(sessionId, cached);
  }
  if (available) messageProvider.setTentacleInfo(sessionId, head, 'synthetic-device');
  messageProvider.setSend((message) => {
    if (message.type === 'request_session_messages_range') requests.push(message.payload as typeof requests[number]);
  });
  return sessionId;
}
export function respond(index = requests.length - 1, empty = false) {
  const request = requests[index];
  if (!request) throw new Error(`Missing request ${index}`);
  messageProvider.handleRangeBatch(request.sessionId, empty ? [] : rows(request.sessionId, request.fromSeq, request.toSeq), request.fromSeq, request.toSeq, false);
}
export function snapshot(sessionId: string) {
  return { requests: [...requests], status: messageProvider.getRangeStatus(sessionId),
    seqs: (useStore.getState().messages.get(sessionId) ?? []).map(m => 'seq' in m ? m.seq : 0) };
}
