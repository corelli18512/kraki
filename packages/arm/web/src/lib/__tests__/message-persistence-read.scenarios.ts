// Source-named followup to reviewer P1. Real provider/store/DB, synthetic IDs;
// faults hold actual continuations, never replace cache or merge algorithms.
import { useStore } from '../../hooks/useStore';
import * as db from '../message-db';
import { messageProvider } from '../message-provider';
import { captureMessageGeneration } from '../message-persistence-generation';
import type { ChatMessage } from '../../types/store';
import { holdModuleCallback } from './message-persistence-generation.scenarios';
import { deferred } from './message-provider.scenarios';

let counter = 0;
const id = (label: string) => `persistence-read-synthetic-${label}-${++counter}`;
const row = (sessionId: string, seq: number, content = `row ${seq}`): ChatMessage => ({
  type: 'agent_message', sessionId, seq, deviceId: 'synthetic', timestamp: '2026-10-15T00:00:00Z', payload: { content },
});
const session = (sessionId: string) => ({ id: sessionId, deviceId: 'synthetic', deviceName: 'Synthetic only', agent: 'pi' as const, state: 'idle' as const, messageCount: 1, lastSeq: 1 });
const contents = (rows: ChatMessage[]) => rows.map(message => (message.payload as { content: string }).content);
const memory = (sessionId: string) => contents(useStore.getState().messages.get(sessionId) ?? []);

export async function recreatedProviderRead() {
  messageProvider.clear();
  const target = id('provider');
  const other = id('other');
  await db.putMessage(target, row(target, 1, 'deleted cache'));
  await db.putMessage(other, row(other, 7));
  useStore.getState().upsertSession(session(target));
  const gate = holdModuleCallback();
  const requests: string[] = [];
  messageProvider.setSend(message => {
    const requested = (message.payload as { sessionId: string }).sessionId;
    requests.push(requested === target ? 'recreated' : 'other');
    queueMicrotask(() => messageProvider.handleRangeBatch(requested, [row(requested, 1, 'fresh authoritative')], 1, 1, false));
  });
  try {
    useStore.getState().removeSession(target);
    await gate.started;
    // This is a NEW provider operation. Never await deletion before starting it.
    useStore.getState().upsertSession(session(target));
    messageProvider.setTentacleInfo(target, 1, 'synthetic');
    const fresh = messageProvider.fetchRange(target, 1, 1, { initial: true });
    messageProvider.setTentacleInfo(other, 7, 'synthetic');
    await messageProvider.fetchRange(other, 7, 7);
    const before = { loading: messageProvider.isLoading(target), memory: memory(target), requests: [...requests], other: memory(other) };
    gate.release();
    await gate.completed; await fresh;
    let disk = contents(await db.getMessages(target));
    for (let n = 0; n < 100 && disk.length === 0; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      disk = contents(await db.getMessages(target));
    }
    return { before, memory: memory(target), disk, requests, sessionExists: useStore.getState().sessions.has(target), status: messageProvider.getRangeStatus(target).state };
  } finally { gate.restore(); }
}

type ReadKind = 'messages' | 'range' | 'last';
const read = (kind: ReadKind, target: string) => kind === 'messages' ? db.getMessages(target)
  : kind === 'range' ? db.getMessagesInRange(target, 1, 10) : db.getLastSeq(target);
const empty = (kind: ReadKind) => kind === 'last' ? 0 : [];
const invalidated = (error: unknown) => error instanceof Error && error.message === 'Message cache read invalidated';

export async function pendingRead(kind: ReadKind) {
  const target = id(`pending-${kind}`);
  const other = id('pending-other');
  await db.putMessage(target, row(target, 1));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(target);
    await gate.started;
    let settled = false;
    const result = read(kind, target).then(value => { settled = true; return value; });
    await db.putMessage(other, row(other, 7));
    const independent = await db.getLastSeq(other);
    const waiting = !settled;
    gate.release();
    const value = await result;
    await gate.completed;
    return { waiting, value, independent };
  } finally { gate.restore(); }
}

export async function failedReadBarrier() {
  const target = id('failed');
  const other = id('failed-other');
  await db.putMessage(target, row(target, 1));
  const failure = new Error('Synthetic store deletion callback failure');
  const gate = holdModuleCallback(failure);
  try {
    useStore.getState().removeSession(target);
    await gate.started;
    const results = (['messages', 'range', 'last'] as const).map(kind => read(kind, target).then(() => false, error => error === failure));
    const deletion = captureMessageGeneration(target).ready!.then(() => false, error => error === failure);
    gate.release();
    const rejected = await Promise.all(results);
    const deletionRejected = await deletion;
    await gate.completed;
    if (gate.matches() !== 1) throw new Error('Expected unique source deletion callback');
    gate.restore();
    await db.putMessage(other, row(other, 7));
    const independent = await db.getLastSeq(other);
    await db.deleteSessionMessages(target);
    await db.putMessage(target, row(target, 2));
    return { rejected, deletionRejected, independent, recovered: await db.getLastSeq(target) };
  } finally { gate.restore(); }
}

export async function supersededReadBarrier() {
  const target = id('superseded');
  await db.putMessage(target, row(target, 1));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(target);
    await gate.started;
    const results = (['messages', 'range', 'last'] as const).map(kind => read(kind, target).then(() => false, invalidated));
    // Rotate ownership while reads await the first barrier. A prior read must
    // not silently capture this newer generation and read its replacement rows.
    const second = db.deleteSessionMessages(target);
    const recreated = db.putMessage(target, row(target, 2));
    gate.release();
    const rejected = await Promise.all(results);
    await Promise.all([second, recreated, gate.completed]);
    return { rejected, recreated: await db.getLastSeq(target) };
  } finally { gate.restore(); }
}

export async function invalidatedAtOpen(kind: ReadKind) {
  const target = id(`open-${kind}`);
  await db.putMessage(target, row(target, 1));
  // getDB returns an already-resolved promise; removal occurs before its
  // continuation. Reads must revalidate after that await, not just before it.
  const result = read(kind, target).then(() => false, invalidated);
  useStore.getState().removeSession(target);
  await captureMessageGeneration(target).ready;
  return { rejected: await result, empty: await read(kind, target) };
}

export async function invalidatedDuringRead(kind: ReadKind) {
  const target = id(`inflight-${kind}`);
  await db.putMessage(target, row(target, 1));
  const gate = deferred();
  const started = deferred();
  let held = false;
  // Hold delivery of one real successful request. Its engine transaction may
  // complete, allowing deletion/recreation before the old read resumes.
  function hold(request: IDBRequest) {
    if (held) return request;
    held = true;
    const add = request.addEventListener.bind(request);
    request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type !== 'success') return add(type, listener, options);
      add(type, event => {
        started.resolve();
        void gate.promise.then(() => typeof listener === 'function' ? listener.call(request, event) : listener.handleEvent(event));
      }, options);
    }) as typeof request.addEventListener;
    return request;
  }
  const indexAll = IDBIndex.prototype.getAll;
  const storeAll = IDBObjectStore.prototype.getAll;
  const cursor = IDBObjectStore.prototype.openCursor;
  if (kind === 'messages') IDBIndex.prototype.getAll = function(this: IDBIndex, ...args: Parameters<IDBIndex['getAll']>) { return hold(indexAll.apply(this, args)); } as typeof indexAll;
  if (kind === 'range') IDBObjectStore.prototype.getAll = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) { return hold(storeAll.apply(this, args)); } as typeof storeAll;
  if (kind === 'last') IDBObjectStore.prototype.openCursor = function(this: IDBObjectStore, ...args: Parameters<IDBObjectStore['openCursor']>) { return hold(cursor.apply(this, args)); } as typeof cursor;
  try {
    const result = read(kind, target).then(() => false, invalidated);
    await started.promise;
    await db.deleteSessionMessages(target);
    await db.putMessage(target, row(target, 2));
    gate.resolve();
    return { rejected: await result, recreated: await db.getLastSeq(target) };
  } finally {
    IDBIndex.prototype.getAll = indexAll;
    IDBObjectStore.prototype.getAll = storeAll;
    IDBObjectStore.prototype.openCursor = cursor;
    gate.resolve();
  }
}

export async function forkSourceRead() {
  const source = id('source');
  const fork = id('fork');
  await db.putMessage(source, row(source, 1));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(source);
    await gate.started;
    let settled = false;
    const seed = db.seedFork(fork, source, 1, 1).then(value => { settled = true; return value; });
    // Destination is independent; its read completes even though source waits.
    const destination = await db.getLastSeq(fork);
    const waiting = !settled;
    gate.release();
    const copied = await seed;
    await gate.completed;
    return { waiting, copied, destination, rows: await db.getMessages(fork) };
  } finally { gate.restore(); }
}

export const readCases: Record<string, () => Promise<unknown>> = {
  'R1-recreated-provider-read': recreatedProviderRead,
  'R2-pending-messages': () => pendingRead('messages'),
  'R2-pending-range': () => pendingRead('range'),
  'R2-pending-last': () => pendingRead('last'),
  'R3-failed-barrier': failedReadBarrier,
  'R4-superseded-barrier': supersededReadBarrier,
  'R5-open-messages': () => invalidatedAtOpen('messages'),
  'R5-open-range': () => invalidatedAtOpen('range'),
  'R5-open-last': () => invalidatedAtOpen('last'),
  'R6-inflight-messages': () => invalidatedDuringRead('messages'),
  'R6-inflight-range': () => invalidatedDuringRead('range'),
  'R6-inflight-last': () => invalidatedDuringRead('last'),
  'R7-fork-source': forkSourceRead,
};
export const readExpected: Record<string, unknown> = {
  'R1-recreated-provider-read': { before: { loading: true, memory: [], requests: [], other: ['row 7'] }, memory: ['fresh authoritative'], disk: ['fresh authoritative'], requests: ['recreated'], sessionExists: true, status: 'loaded' },
  'R2-pending-messages': { waiting: true, value: empty('messages'), independent: 7 },
  'R2-pending-range': { waiting: true, value: empty('range'), independent: 7 },
  'R2-pending-last': { waiting: true, value: empty('last'), independent: 7 },
  'R3-failed-barrier': { rejected: [true, true, true], deletionRejected: true, independent: 7, recovered: 2 },
  'R4-superseded-barrier': { rejected: [true, true, true], recreated: 2 },
  'R5-open-messages': { rejected: true, empty: [] },
  'R5-open-range': { rejected: true, empty: [] },
  'R5-open-last': { rejected: true, empty: 0 },
  'R6-inflight-messages': { rejected: true, recreated: 2 },
  'R6-inflight-range': { rejected: true, recreated: 2 },
  'R6-inflight-last': { rejected: true, recreated: 2 },
  'R7-fork-source': { waiting: true, copied: 0, destination: 0, rows: [] },
};
