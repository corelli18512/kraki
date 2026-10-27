// Real store/provider/DB. Faults hold real API continuations, never replace
// persistence or copy the store's message reconciliation algorithms.
import { useStore } from '../../hooks/useStore';
import * as db from '../message-db';
import { messageProvider } from '../message-provider';
import { handleDataMessage } from '../message-router';
import { CommandState } from '../commands';
import type { InnerMessage } from '@kraki/protocol';
import { captureMessageGeneration } from '../message-persistence-generation';
import type { ChatMessage } from '../../types/store';
import { deferred, until } from './message-provider.scenarios';

let counter = 0;
const id = (label: string) => `persistence-synthetic-${label}-${++counter}`;
const row = (sessionId: string, seq: number): ChatMessage => ({
  type: 'agent_message', sessionId, seq, deviceId: 'synthetic', timestamp: '2026-10-15T00:00:00Z', payload: { content: `row ${seq}` },
});
const seqs = async (sessionId: string) => (await db.getMessages(sessionId)).map(m => (m as { seq: number }).seq);

/** Raw disk diagnostic only: intentionally observes rows a guarded public read
 * must NOT expose. No transient filtering/reconciliation/product logic copied. */
async function inspectRawSessionSeqs(sessionId: string): Promise<number[]> {
  if (!sessionId.startsWith('persistence-')) throw new Error('Synthetic session required');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('kraki-messages');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const raw = request.result;
      const tx = raw.transaction('messages', 'readonly');
      const query = tx.objectStore('messages').index('sessionId').getAll(sessionId);
      tx.oncomplete = () => { raw.close(); resolve(query.result.map((entry: { seq: number }) => entry.seq)); };
      tx.onabort = () => { raw.close(); reject(tx.error); };
    };
  });
}

/** Hold a real lazy-module callback, including its resulting completion. */
export function holdModuleCallback(failure?: Error) {
  const original = Promise.prototype.then;
  const started = deferred();
  const gate = deferred();
  const completed = deferred();
  let held = false;
  let matches = 0;
  Promise.prototype.then = function(onfulfilled: any, onrejected: any) {
    return original.call(this, (value: any) => {
      // Rejection injection must target the actual store callback, NOT Vite's
      // internal loader continuation that also resolves to this module.
      const storeDeletion = /\(?db\)?\s*=>\s*db\.deleteSessionMessages\(sessionId,\s*deletion\)/.test(String(onfulfilled));
      const persistenceCallback = /\(?db\)?\s*=>\s*db\.(?:putMessage|putMessages|deleteSessionMessages|seedFork)\(/.test(String(onfulfilled));
      const matchesOperation = value?.putMessages === db.putMessages && (failure ? storeDeletion : persistenceCallback);
      if (failure && matchesOperation) matches++;
      if (!held && matchesOperation) {
        held = true;
        started.resolve();
        return original.call(gate.promise, async () => {
          try {
            if (failure) throw failure;
            return await onfulfilled?.(value);
          } finally { completed.resolve(); }
        });
      }
      return onfulfilled ? onfulfilled(value) : value;
    }, onrejected) as any;
  };
  return { started: started.promise, completed: completed.promise, matches: () => matches, release: () => gate.resolve(), restore: () => { Promise.prototype.then = original; gate.resolve(); } };
}

export async function delayedWriter(kind: 'append' | 'prepend') {
  const session = id(kind);
  const gate = holdModuleCallback();
  try {
    if (kind === 'append') useStore.getState().appendMessage(session, row(session, 1));
    else useStore.getState().prependMessages(session, [row(session, 1)]);
    await gate.started;
    useStore.getState().removeSession(session);
    await captureMessageGeneration(session).ready;
    // Deliberate same-id recreation must survive the released OLD callback.
    await db.putMessage(session, row(session, 2));
    gate.release();
    await gate.completed;
    return { rows: await seqs(session), removedFromMemory: !useStore.getState().messages.has(session) };
  } finally { gate.restore(); }
}

export async function delayedDeleteImport() {
  const session = id('delete-import');
  const other = id('other');
  await db.putMessage(session, row(session, 1));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(session);
    const deletion = captureMessageGeneration(session).ready;
    await gate.started;
    let written = false;
    const write = db.putMessage(session, row(session, 2)).then(() => { written = true; });
    // Other sessions are not behind this session's import/barrier.
    await db.putMessage(other, row(other, 7));
    const waiting = !written;
    const before = await inspectRawSessionSeqs(session);
    gate.release();
    await deletion; await gate.completed; await write;
    // Repeated delete is idempotent; new writes after it are still legitimate.
    await db.deleteSessionMessages(session);
    await db.deleteSessionMessages(session);
    await db.putMessage(session, row(session, 3));
    return { waiting, before, rows: await seqs(session), other: await seqs(other) };
  } finally { gate.restore(); }
}

// This case runs FIRST in both runtimes, before the DB's first open. Delay the
// real IDB open success listener, not a fake DB or a substituted DB algorithm.
export async function delayedOpen() {
  localStorage.setItem('kraki-idb-transient-swept', '1');
  const session = id('open');
  const other = id('open-other');
  const original = IDBFactory.prototype.open;
  const started = deferred();
  const gate = deferred();
  let held = false;
  IDBFactory.prototype.open = function(...args: Parameters<IDBFactory['open']>) {
    const request = original.apply(this, args);
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
  };
  try {
    const old = db.updateSessionMessages(session, [row(session, 1)]);
    await started.promise;
    useStore.getState().removeSession(session);
    const deleted = captureMessageGeneration(session).ready;
    let written = false;
    const fresh = db.putMessage(session, row(session, 2)).then(() => { written = true; });
    const independent = db.putMessage(other, row(other, 7));
    await Promise.resolve();
    const waiting = !written;
    gate.resolve();
    await Promise.all([old, deleted, fresh, independent]);
    return { waiting, rows: await seqs(session), other: await seqs(other) };
  } finally { IDBFactory.prototype.open = original; gate.resolve(); }
}

export async function startedTransaction(kind: 'put' | 'batch' | 'update') {
  const session = id(`tx-${kind}`);
  const original = IDBObjectStore.prototype.put;
  const started = deferred();
  let deletion!: Promise<void>;
  let writeTransaction!: IDBTransaction;
  let finishedBeforeDelete = false;
  let finished = false;
  IDBObjectStore.prototype.put = function(...args: Parameters<IDBObjectStore['put']>) {
    const request = original.apply(this, args);
    if (this.name === 'messages' && (args[0] as { sessionId: string }).sessionId === session && !writeTransaction) {
      writeTransaction = this.transaction;
      writeTransaction.addEventListener('complete', () => { finished = true; });
      // The real readwrite transaction has already submitted its first row.
      useStore.getState().removeSession(session);
      deletion = captureMessageGeneration(session).ready!.then(() => { finishedBeforeDelete = finished; });
      started.resolve();
    }
    return request;
  };
  try {
    const rows = [1, 2, 3].map(seq => row(session, seq));
    const old = kind === 'put' ? db.putMessage(session, rows[0])
      : kind === 'batch' ? db.putMessages(session, rows) : db.updateSessionMessages(session, rows);
    await started.promise;
    const fresh = db.putMessage(session, row(session, 100));
    await Promise.all([old, deletion, fresh]);
    return { finishedBeforeDelete, rows: await seqs(session) };
  } finally { IDBObjectStore.prototype.put = original; }
}

export async function overlappingDeletes() {
  const session = id('overlapping-delete');
  const other = id('overlapping-other');
  await db.putMessage(session, row(session, 1));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(session);
    const first = captureMessageGeneration(session).ready;
    await gate.started;
    const middle = db.putMessage(session, row(session, 2));
    useStore.getState().removeSession(session);
    const second = captureMessageGeneration(session).ready;
    let written = false;
    const fresh = db.putMessage(session, row(session, 3)).then(() => { written = true; });
    await db.putMessage(other, row(other, 7));
    const waiting = !written;
    gate.release();
    await Promise.all([first, second, middle, fresh, gate.completed]);
    return { waiting, rows: await seqs(session), other: await seqs(other) };
  } finally { gate.restore(); }
}

export async function failedSchedulerCallbackRetry() {
  const session = id('failed-scheduler');
  await db.putMessage(session, row(session, 1));
  const failure = new Error('Synthetic store deletion callback failure');
  const gate = holdModuleCallback(failure);
  const originalError = console.error;
  let logged = false;
  console.error = (...args: unknown[]) => {
    if (args[0] === '[Kraki:idb]' && args[1] === failure) logged = true;
    originalError(...args);
  };
  try {
    useStore.getState().removeSession(session);
    await until(() => gate.matches() === 1, 'unique source store deletion callback', 2000);
    const blocked = db.putMessage(session, row(session, 2)).then(() => false, error => error === failure);
    const deletion = captureMessageGeneration(session).ready!.then(() => false, error => error === failure);
    gate.release();
    const failed = await deletion;
    const writeRejected = await blocked;
    await gate.completed;
    if (gate.matches() !== 1) throw new Error(`Expected exactly one store deletion callback; got ${gate.matches()}`);
    gate.restore();
    const before = await inspectRawSessionSeqs(session);
    await db.deleteSessionMessages(session);
    await db.putMessage(session, row(session, 3));
    return { failed, writeRejected, logged, callbackMatches: gate.matches(), before, rows: await seqs(session) };
  } finally { gate.restore(); console.error = originalError; }
}

export async function failedDeleteRetry() {
  const session = id('retry');
  const other = id('retry-other');
  await db.putMessage(session, row(session, 1));
  const original = IDBIndex.prototype.openCursor;
  let aborted = false;
  IDBIndex.prototype.openCursor = function(...args: Parameters<IDBIndex['openCursor']>) {
    if (!aborted && args[0] === session) {
      aborted = true;
      // Actual transaction abort: both request and tx.done must be consumed.
      const request = original.apply(this, args);
      this.objectStore.transaction.abort();
      return request;
    }
    return original.apply(this, args);
  };
  try {
    const deletion = db.deleteSessionMessages(session).then(() => false, () => true);
    const blocked = db.putMessage(session, row(session, 2)).then(() => false, () => true);
    const failed = await deletion;
    const writeRejected = await blocked;
    await db.putMessage(other, row(other, 7));
    // Failed deletion did not silently succeed or erase the original row.
    const before = await inspectRawSessionSeqs(session);
    const retry = db.deleteSessionMessages(session);
    const recreated = db.putMessage(session, row(session, 3));
    await Promise.all([retry, recreated]);
    return { aborted, failed, writeRejected, before, rows: await seqs(session), other: await seqs(other) };
  } finally { IDBIndex.prototype.openCursor = original; }
}

export async function forkLifecycle() {
  const source = id('source');
  const fork = id('fork');
  await db.putMessages(source, [1, 2, 3].map(seq => row(source, seq)));
  const original = IDBObjectStore.prototype.getAll;
  const started = deferred();
  const gate = deferred();
  let held = false;
  IDBObjectStore.prototype.getAll = function(...args: Parameters<IDBObjectStore['getAll']>) {
    const request = original.apply(this, args);
    if (held || this.name !== 'messages') return request;
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
  };
  try {
    const old = db.seedFork(fork, source, 1, 3);
    await started.promise;
    await db.deleteSessionMessages(fork);
    gate.resolve();
    const canceled = await old;
    const empty = await seqs(fork);
    const copied = await db.seedFork(fork, source, 2, 3);
    const duplicate = await db.seedFork(fork, source, 1, 3);
    return { canceled, empty, copied, duplicate, rows: await seqs(fork), source: await seqs(source) };
  } finally { IDBObjectStore.prototype.getAll = original; gate.resolve(); }
}

export async function recreatedFork() {
  const source = id('fork-recreate-source');
  const fork = id('fork-recreate');
  await db.putMessages(source, [1, 2, 3].map(seq => row(source, seq)));
  await db.putMessage(fork, row(fork, 9));
  const gate = holdModuleCallback();
  try {
    useStore.getState().removeSession(fork);
    await gate.started;
    let finished = false;
    const seed = db.seedFork(fork, source, 2, 3).then(count => { finished = true; return count; });
    const before = await inspectRawSessionSeqs(fork);
    const waiting = !finished;
    gate.release();
    const copied = await seed;
    await gate.completed;
    return { before, waiting, copied, rows: await seqs(fork) };
  } finally { gate.restore(); }
}

export async function providerRemoval() {
  messageProvider.clear();
  const session = id('provider');
  const other = id('provider-other');
  const requests: string[] = [];
  messageProvider.setSend(message => { requests.push((message.payload as { sessionId: string }).sessionId); });
  messageProvider.setTentacleInfo(session, 1, 'synthetic');
  messageProvider.setTentacleInfo(other, 1, 'synthetic');
  const old = messageProvider.fetchRange(session, 1, 1, { initial: true });
  const independent = messageProvider.fetchRange(other, 1, 1, { initial: true });
  await until(() => requests.length === 2, 'both real provider requests');
  useStore.getState().removeSession(session);
  const invalidated = !messageProvider.isLoading(session) && messageProvider.getRangeStatus(session).state === 'idle';
  const otherLoading = messageProvider.isLoading(other);
  messageProvider.handleRangeBatch(other, [row(other, 1)], 1, 1, false);
  await Promise.all([old, independent, captureMessageGeneration(session).ready]);
  // Explicit same-session recreation with a new operation must still work.
  messageProvider.setTentacleInfo(session, 2, 'synthetic');
  const fresh = messageProvider.fetchRange(session, 2, 2, { initial: true });
  await until(() => requests.length === 3, 'recreated provider request');
  messageProvider.handleRangeBatch(session, [row(session, 2)], 2, 2, false);
  await fresh;
  await until(() => useStore.getState().messages.get(session)?.length === 1, 'fresh memory rows');
  // Wait for actual store-owned persistence, not an additional fixture write.
  let persisted = await seqs(session);
  for (let n = 0; n < 100 && persisted.length === 0; n++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    persisted = await seqs(session);
  }
  return { invalidated, otherLoading, rows: persisted, other: (useStore.getState().messages.get(other) ?? []).length };
}

export async function lastSeqAbort() {
  const session = id('last-seq-abort');
  await db.putMessages(session, [row(session, 1), row(session, 2)]);
  const original = IDBObjectStore.prototype.openCursor;
  let aborted = false;
  IDBObjectStore.prototype.openCursor = function(...args: Parameters<IDBObjectStore['openCursor']>) {
    const request = original.apply(this, args);
    if (!aborted && this.name === 'messages' && (args[0] as IDBKeyRange)?.lower?.[0] === session) {
      aborted = true;
      this.transaction.abort();
    }
    return request;
  };
  try {
    const error = await db.getLastSeq(session).then(() => 'unexpected-success', error => error.name);
    return { aborted, error, last: await db.getLastSeq(session), bounded: await db.getLastSeq(session, 1) };
  } finally { IDBObjectStore.prototype.openCursor = original; }
}

export async function routerFork(mode: 'deleted' | 'recreated' | 'normal' | 'failure') {
  messageProvider.clear();
  const source = id('router-source');
  const fork = id(`router-${mode}`);
  await db.putMessages(source, [1, 2, 3].map(seq => row(source, seq)));
  const requests: Array<[number, number]> = [];
  messageProvider.setSend(message => {
    const payload = message.payload as { fromSeq: number; toSeq: number };
    requests.push([payload.fromSeq, payload.toSeq]);
    queueMicrotask(() => messageProvider.handleRangeBatch(fork,
      Array.from({ length: payload.toSeq - payload.fromSeq + 1 }, (_, i) => row(fork, payload.fromSeq + i)),
      payload.fromSeq, payload.toSeq, false));
  });
  const commandState = new CommandState();
  commandState.forkSources.set('synthetic-fork-request', source);
  const gate = holdModuleCallback();
  const originalCursor = IDBObjectStore.prototype.openCursor;
  let aborted = false;
  if (mode === 'failure') {
    IDBObjectStore.prototype.openCursor = function(...args: Parameters<IDBObjectStore['openCursor']>) {
      const request = originalCursor.apply(this, args);
      if (!aborted && this.name === 'messages' && (args[0] as IDBKeyRange)?.lower?.[0] === fork) {
        aborted = true;
        this.transaction.abort();
      }
      return request;
    };
  }
  try {
    handleDataMessage({ type: 'session_created', sessionId: fork, deviceId: 'synthetic', seq: 0,
      timestamp: '2026-10-15T00:00:00Z', payload: { agent: 'pi', lastSeq: 3, requestId: 'synthetic-fork-request' },
    } as InnerMessage, { cmdState: commandState });
    await gate.started;
    if (mode === 'deleted' || mode === 'recreated') {
      useStore.getState().removeSession(fork);
      await captureMessageGeneration(fork).ready;
    }
    if (mode === 'recreated') {
      useStore.getState().upsertSession({ id: fork, deviceId: 'synthetic', deviceName: 'Synthetic only', agent: 'pi', state: 'idle', messageCount: 1, lastSeq: 9 });
      await db.putMessage(fork, row(fork, 9));
      messageProvider.setTentacleInfo(fork, 9, 'synthetic');
      await messageProvider.fetchRange(fork, 9, 9);
    }
    gate.release();
    await gate.completed;
    // Drain the real router's catch/finally continuation and any cache load it
    // initiates. The completion condition below still asserts exact row sets.
    await new Promise(resolve => setTimeout(resolve, 10));
    await until(() => !messageProvider.isLoading(fork), 'router fork continuation');
    const memory = (useStore.getState().messages.get(fork) ?? []).map(message => (message as { seq: number }).seq);
    let persisted = await seqs(fork);
    for (let n = 0; n < 100 && persisted.length < memory.length; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      persisted = await seqs(fork);
    }
    return { requests, memory, persisted, aborted, status: messageProvider.getRangeStatus(fork).state };
  } finally { gate.restore(); IDBObjectStore.prototype.openCursor = originalCursor; }
}

export const persistenceCases: Record<string, () => Promise<unknown>> = {
  'P1-delayed-open': delayedOpen,
  'P2-append-import': () => delayedWriter('append'),
  'P2-prepend-import': () => delayedWriter('prepend'),
  'P3-delete-import': delayedDeleteImport,
  'P4-started-put': () => startedTransaction('put'),
  'P4-started-batch': () => startedTransaction('batch'),
  'P4-started-update': () => startedTransaction('update'),
  'P5-overlapping-deletes': overlappingDeletes,
  'P5-scheduler-failure-retry': failedSchedulerCallbackRetry,
  'P5-delete-failure-retry': failedDeleteRetry,
  'P6-fork-lifecycle': forkLifecycle,
  'P6-recreated-fork': recreatedFork,
  'P7-provider-removal': providerRemoval,
  'P8-router-deleted': () => routerFork('deleted'),
  'P8-router-recreated': () => routerFork('recreated'),
  'P8-router-normal-control': () => routerFork('normal'),
  'P8-router-fallback-control': () => routerFork('failure'),
  'P9-last-seq-abort': lastSeqAbort,
};
export const expected: Record<string, unknown> = {
  'P1-delayed-open': { waiting: true, rows: [2], other: [7] },
  'P2-append-import': { rows: [2], removedFromMemory: true },
  'P2-prepend-import': { rows: [2], removedFromMemory: true },
  'P3-delete-import': { waiting: true, before: [1], rows: [3], other: [7] },
  'P4-started-put': { finishedBeforeDelete: true, rows: [100] },
  'P4-started-batch': { finishedBeforeDelete: true, rows: [100] },
  'P4-started-update': { finishedBeforeDelete: true, rows: [100] },
  'P5-overlapping-deletes': { waiting: true, rows: [3], other: [7] },
  'P5-scheduler-failure-retry': { failed: true, writeRejected: true, logged: true, callbackMatches: 1, before: [1], rows: [3] },
  'P5-delete-failure-retry': { aborted: true, failed: true, writeRejected: true, before: [1], rows: [3], other: [7] },
  'P6-fork-lifecycle': { canceled: 0, empty: [], copied: 2, duplicate: 0, rows: [2, 3], source: [1, 2, 3] },
  'P6-recreated-fork': { before: [9], waiting: true, copied: 2, rows: [2, 3] },
  'P7-provider-removal': { invalidated: true, otherLoading: true, rows: [2], other: 1 },
  'P8-router-deleted': { requests: [], memory: [], persisted: [], aborted: false, status: 'idle' },
  'P8-router-recreated': { requests: [], memory: [9], persisted: [9], aborted: false, status: 'loaded' },
  'P8-router-normal-control': { requests: [], memory: [1, 2, 3], persisted: [1, 2, 3], aborted: false, status: 'loaded' },
  'P8-router-fallback-control': { requests: [[1, 3]], memory: [1, 2, 3], persisted: [1, 2, 3], aborted: true, status: 'loaded' },
  'P9-last-seq-abort': { aborted: true, error: 'AbortError', last: 2, bounded: 1 },
};
