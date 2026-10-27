// Provider-only regressions adapted from repro/transport at 4f4c85f.
// Real store/outbox/message-db. No transport sockets, agents, or crypto substitution.
import { useStore } from '../../hooks/useStore';
import { outbox, useOutbox } from '../chat/outbox';
import { messageProvider } from '../message-provider';
import * as db from '../message-db';
import { handleDataMessage } from '../message-router';
import { CommandState } from '../commands';
import type { InnerMessage } from '@kraki/protocol';
import type { ChatMessage } from '../../types/store';
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
export async function until(check: () => boolean, label: string, timeout = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
let runNumber = 0;
export let sessionId = 'transport-synthetic-session';
const deviceId = 'transport-synthetic-tentacle';
const appId = 'transport-synthetic-app';
const message = (seq: number, type = 'agent_message', payload: object = { content: `row ${seq}` }): ChatMessage =>
  ({ type, seq, sessionId, deviceId, timestamp: '2026-10-15T00:00:00Z', payload }) as ChatMessage;
const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => message(from + i));

export async function reset() {
  messageProvider.clear();
  useStore.getState().reset();
  outbox.reset();
  await db.clearAllMessages();
  // Unique session isolates fire-and-forget IDB writes from earlier scenarios.
  sessionId = `transport-synthetic-session-${++runNumber}`;
  useStore.getState().setAuth(appId);
  useStore.getState().setStatus('connected');
  useStore.getState().setDevices([{ id: deviceId, role: 'tentacle', online: true, name: 'Synthetic only' }]);
  useStore.getState().setSessions([{ id: sessionId, deviceId, deviceName: 'Synthetic only', agent: 'pi', state: 'active', messageCount: 10, lastSeq: 10, readSeq: 4 }]);
  outbox.configure({ send: async () => true, isDeliveryPathUp: () => false });
}

export async function replayConfirmation(source: 'cache' | 'range' | 'unsolicited' | 'restore' | 'live' | 'wrong-session' | 'wrong-type') {
  await reset();
  const id = outbox.send(sessionId, 'synthetic accepted input');
  const echo = { ...message(1, source === 'wrong-type' ? 'agent_message' : 'user_message', { clientId: id, content: 'synthetic accepted input' }), ...(source === 'wrong-session' ? { sessionId: 'other-synthetic-session' } : {}) } as ChatMessage;
  messageProvider.setTentacleInfo(sessionId, 1, deviceId);
  if (source === 'live') {
    handleDataMessage(echo as InnerMessage, { cmdState: new CommandState(), sendEncrypted: () => {}, onSessionList: () => {} });
  } else if (source === 'range') {
    let sent = false;
    messageProvider.setSend(() => { sent = true; });
    const work = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
    await until(() => sent, 'range request');
    messageProvider.handleRangeBatch(sessionId, [echo], 1, 1, false);
    await work;
  } else if (source === 'unsolicited' || source === 'wrong-session' || source === 'wrong-type') {
    messageProvider.handleRangeBatch(source === 'wrong-session' ? 'other-synthetic-session' : sessionId, [echo], 1, 1, false);
  } else {
    await db.putMessages(sessionId, [echo]);
    if (source === 'restore') outbox.reloadForTesting();
    await messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
  }
  const remaining = useOutbox.getState().entries.length;
  const persisted = JSON.parse(localStorage.getItem('kraki-outbox-v1') ?? '[]').length;
  return { invariant: remaining === (source.startsWith('wrong-') ? 1 : 0), remaining, persisted, messages: useStore.getState().messages.get(sessionId)?.length ?? 0 };
}

// Delay delivery of one REAL IDB getAll success to the idb promise wrapper.
// The engine query itself completes normally; only its asynchronous continuation is held.
function deferNextIDBRead() {
  const gate = deferred();
  const started = deferred();
  const original = IDBObjectStore.prototype.getAll;
  let captured = false;
  IDBObjectStore.prototype.getAll = function (...args: Parameters<IDBObjectStore['getAll']>) {
    const request = original.apply(this, args);
    if (this.name !== 'messages' || captured) return request;
    captured = true;
    const add = request.addEventListener.bind(request);
    request.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => {
      if (type !== 'success') return add(type, listener, options);
      add(type, (event) => {
        started.resolve();
        void gate.promise.then(() => typeof listener === 'function' ? listener.call(request, event) : listener.handleEvent(event));
      }, options);
    }) as typeof request.addEventListener;
    return request;
  };
  return { started: started.promise, release: () => gate.resolve(), restore: () => { IDBObjectStore.prototype.getAll = original; gate.resolve(); } };
}

export async function staleIDB(deleted = false, control = false) {
  await reset();
  await db.putMessages(sessionId, [message(1)]);
  const gate = deferNextIDBRead();
  try {
    const old = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
    await gate.started;
    if (control) { gate.release(); await old; return { invariant: true, count: useStore.getState().messages.get(sessionId)?.length, loading: messageProvider.isLoading(sessionId) }; }
    messageProvider.clear();
    if (deleted) {
      useStore.getState().removeSession(sessionId);
      await db.deleteSessionMessages(sessionId);
      gate.release(); await old;
      const count = useStore.getState().messages.get(sessionId)?.length ?? 0;
      return { invariant: count === 0, orphanCount: count, sessionExists: useStore.getState().sessions.has(sessionId) };
    }
    messageProvider.setTentacleInfo(sessionId, 2, deviceId);
    let requested = false;
    messageProvider.setSend(() => { requested = true; });
    const fresh = messageProvider.fetchRange(sessionId, 2, 2, { initial: true });
    await until(() => requested, 'new generation pending');
    const loadingBefore = messageProvider.isLoading(sessionId);
    gate.release(); await old;
    const result = { invariant: messageProvider.isLoading(sessionId), loadingBefore, loadingAfter: messageProvider.isLoading(sessionId), oldRows: useStore.getState().messages.get(sessionId)?.length };
    messageProvider.handleRangeBatch(sessionId, [message(2)], 2, 2, false); await fresh;
    return result;
  } finally { gate.restore(); }
}


// Optional lookup permits ordinary desired-invariant RED assertions on the unpatched base.
export const status = () => (messageProvider as any).getRangeStatus?.(sessionId) ?? { state: 'idle' };
const snapshot = () => (useStore.getState().messages.get(sessionId) ?? []).map(m => ({ seq: (m as any).seq, payload: m.payload }));

export async function gap(head = 100, truncated = false, contiguous = false) {
  await reset();
  await db.putMessages(sessionId, rows(1, contiguous ? 50 : 10));
  useStore.getState().prependMessages(sessionId, rows(1, contiguous ? 50 : 10));
  messageProvider.setTentacleInfo(sessionId, head, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => {
    const p = m.payload as any;
    requests.push(p);
    // Deterministic truncated first page; all later pages answer the exact request.
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId,
      rows(p.fromSeq, truncated && requests.length === 1 ? p.fromSeq + 9 : p.toSeq),
      p.fromSeq, truncated && requests.length === 1 ? p.fromSeq + 9 : p.toSeq,
      truncated && requests.length === 1));
  });
  const stages: any[] = [];
  for (let n = 0; n < (head > 100 ? 4 : 1); n++) {
    messageProvider.ensureLoaded(sessionId);
    await until(() => !messageProvider.isLoading(sessionId), 'bounded reconciliation');
    const seqs = snapshot().map(m => m.seq);
    stages.push({ status: status(), missing: Array.from({ length: head }, (_, i) => i + 1).filter(s => !seqs.includes(s)) });
  }
  return { requests, stages, count: snapshot().length };
}

export async function replacement() {
  await reset();
  await db.putMessages(sessionId, [message(1), message(3, 'agent_message', { content: 'stale' })]);
  messageProvider.setTentacleInfo(sessionId, 3, deviceId);
  messageProvider.setSend(() => queueMicrotask(() => messageProvider.handleRangeBatch(sessionId,
    [message(2), message(3, 'agent_message', { content: 'authoritative' })], 2, 3, false)));
  await messageProvider.fetchRange(sessionId, 1, 3);
  return { rows: snapshot() };
}

export async function truncatedNoProgress(kind: 'empty' | 'duplicate' | 'outside') {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 3, deviceId);
  let requests = 0;
  const ranges: Array<{ fromSeq: number; toSeq: number }> = [];
  messageProvider.setSend(m => {
    requests++;
    const p = m.payload as { fromSeq: number; toSeq: number };
    ranges.push({ fromSeq: p.fromSeq, toSeq: p.toSeq });
    const list = kind === 'empty' ? [] : [message(kind === 'outside' ? 100 : 2)];
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId, list, list[0]?.seq ?? 0, list.at(-1)?.seq ?? 0, true));
  });
  await messageProvider.fetchRange(sessionId, 1, 3);
  return { requests, ranges, status: status(), rows: snapshot() };
}

export async function timeout(wait = () => new Promise<void>(r => setTimeout(r, 10_100))) {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 1, deviceId);
  let requests = 0;
  messageProvider.setSend(() => { requests++; });
  const first = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
  await until(() => requests === 1, 'withheld-range fault armed');
  await wait(); await first;
  const failed = status();
  const retry = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
  await until(() => requests === 2, 'explicit range retry');
  messageProvider.handleRangeBatch(sessionId, [], 0, 0, false);
  await until(() => requests === 3, 'ambiguous empty confirmation');
  const confirming = status();
  messageProvider.handleRangeBatch(sessionId, [], 0, 0, false);
  await retry;
  return { failed, confirming, recovered: status(), requests };
}

export async function invalidateDuringRead() {
  await reset();
  await db.putMessages(sessionId, [message(1)]);
  const gate = deferNextIDBRead();
  try {
    const work = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
    await gate.started;
    (messageProvider as any).invalidateSession?.(sessionId);
    useStore.getState().removeSession(sessionId);
    await db.deleteSessionMessages(sessionId);
    gate.release(); await work;
    return { count: snapshot().length, persisted: (await db.getMessages(sessionId)).length };
  } finally { gate.restore(); }
}

// Retained downstream contract: hold the store's real lazy-module continuation
// before its DB transaction, then clear/delete. Persistence now owns cancellation.
export async function queuedStoreWrite() {
  await reset();
  const started = deferred();
  const release = deferred();
  // Hold module callback delivery before putMessages' transaction starts.
  const originalThen = Promise.prototype.then;
  let held = false;
  Promise.prototype.then = function(onfulfilled: any, onrejected: any) {
    return originalThen.call(this, (value: any) => {
      if (!held && value?.putMessages === db.putMessages) {
        held = true; started.resolve();
        return release.promise.then(() => onfulfilled?.(value));
      }
      return onfulfilled ? onfulfilled(value) : value;
    }, onrejected) as any;
  };
  try {
    messageProvider.handleRangeBatch(sessionId, [message(1)], 1, 1, false);
    await started.promise;
    messageProvider.clear();
    useStore.getState().removeSession(sessionId);
    await db.deleteSessionMessages(sessionId);
    release.resolve();
    Promise.prototype.then = originalThen;
    for (let n = 0; n < 100 && (await db.getMessages(sessionId)).length === 0; n++) await new Promise(r => setTimeout(r, 5));
    return { persisted: (await db.getMessages(sessionId)).length };
  } finally { Promise.prototype.then = originalThen; release.resolve(); }
}

export async function repeatedTruncated() {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 3, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => {
    requests.push(m.payload);
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId, [message(1)], 1, 1, true));
  });
  await messageProvider.fetchRange(sessionId, 1, 3);
  return { requests, status: status(), count: snapshot().length };
}

export async function pageLimit() {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 60, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => {
    const p = m.payload as any; requests.push(p);
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId, [message(p.fromSeq)], p.fromSeq, p.fromSeq, true));
  });
  await messageProvider.fetchRange(sessionId, 1, 60);
  const first = { requests: requests.length, status: status(), count: snapshot().length };
  (messageProvider as any).retryRange?.(sessionId);
  await until(() => !messageProvider.isLoading(sessionId), 'explicit page-limit retry');
  return { first, requests, count: snapshot().length, status: status() };
}

export async function newerTail() {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 100, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => { requests.push(m.payload); });
  messageProvider.ensureLoaded(sessionId);
  await until(() => requests.length === 1, 'first foreground tail');
  messageProvider.reconcileTail(sessionId, 120);
  messageProvider.reconcileTail(sessionId, 110); // coalesce to newest, never backwards
  messageProvider.handleRangeBatch(sessionId, rows(51, 100), 51, 100, false);
  await until(() => requests.length === 2, 'newest tail priority');
  messageProvider.handleRangeBatch(sessionId, rows(101, 120), 101, 120, false);
  await until(() => !messageProvider.isLoading(sessionId), 'newest tail done');
  return { requests, status: status(), count: snapshot().length };
}

export async function unsolicitedDuringRead() {
  await reset();
  await db.putMessages(sessionId, [message(1)]);
  const gate = deferNextIDBRead();
  try {
    const work = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
    await gate.started;
    messageProvider.handleRangeBatch(sessionId, [message(2)], 2, 2, false);
    const loading = messageProvider.isLoading(sessionId);
    gate.release(); await work;
    return { loading, count: snapshot().length };
  } finally { gate.restore(); }
}

export async function replayIdempotence() {
  await reset();
  const clientId = outbox.send(sessionId, 'same text');
  // Text without a clientId is not sufficient for durable replay confirmation.
  messageProvider.handleRangeBatch(sessionId, [message(1, 'user_message', { content: 'same text' })], 1, 1, false);
  const withoutClient = outbox.forSession(sessionId).length;
  messageProvider.handleRangeBatch(sessionId, [{ ...message(2, 'user_message', { clientId }), sessionId: 'unrelated' } as ChatMessage], 2, 2, false);
  const mismatchedRow = outbox.forSession(sessionId).length;
  outbox.retry(clientId);
  const echo = message(2, 'user_message', { content: 'same text', clientId });
  messageProvider.handleRangeBatch(sessionId, [echo], 2, 2, false);
  messageProvider.handleRangeBatch(sessionId, [echo], 2, 2, false);
  outbox.reloadForTesting();
  return { withoutClient, mismatchedRow, remaining: outbox.forSession(sessionId).length, persisted: JSON.parse(localStorage.getItem('kraki-outbox-v1') ?? '[]').length };
}

export async function statusSubscription() {
  await reset();
  const states: string[] = [];
  const api = messageProvider as any;
  const unsubscribe = api.subscribeRangeStatus?.(() => states.push(status().state));
  messageProvider.setTentacleInfo(sessionId, 1, deviceId);
  messageProvider.setSend(() => queueMicrotask(() => messageProvider.handleRangeBatch(sessionId, [], 0, 0, false)));
  const idle = status();
  const stable = status() === idle;
  await messageProvider.fetchRange(sessionId, 1, 1);
  unsubscribe?.();
  const before = states.length;
  messageProvider.clear();
  return { states, stable, unsubscribed: states.length === before, cleared: status().state };
}

export async function clearPendingRequest() {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 1, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => { requests.push(m.payload); });
  const old = messageProvider.fetchRange(sessionId, 1, 1, { initial: true });
  await until(() => requests.length === 1, 'old pending range');
  messageProvider.clear();
  messageProvider.setTentacleInfo(sessionId, 2, deviceId);
  const fresh = messageProvider.fetchRange(sessionId, 2, 2, { initial: true });
  await until(() => requests.length === 2, 'fresh pending range');
  await old;
  const retained = messageProvider.isLoading(sessionId) && status().state === 'loading';
  // Do not pretend to distinguish delayed old untagged packets: supply only the fresh reply.
  messageProvider.handleRangeBatch(sessionId, [message(2)], 2, 2, false);
  await fresh;
  return { retained, count: snapshot().length, status: status() };
}

export async function foregroundPreemptsContinuation() {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 100, deviceId);
  const requests: any[] = [];
  messageProvider.setSend(m => { requests.push(m.payload); });
  const background = messageProvider.fetchRange(sessionId, 51, 100);
  await until(() => requests.length === 1, 'background range');
  messageProvider.reconcileTail(sessionId, 120);
  messageProvider.handleRangeBatch(sessionId, rows(51, 60), 51, 60, true);
  await background;
  await until(() => requests.length === 2, 'foreground preemption');
  const next = requests[1];
  messageProvider.handleRangeBatch(sessionId, rows(71, 120), 71, 120, false);
  await until(() => requests.length === 3, 'bounded foreground bridge');
  messageProvider.handleRangeBatch(sessionId, rows(61, 70), 61, 70, false);
  await until(() => !messageProvider.isLoading(sessionId), 'foreground finished');
  return { next, count: snapshot().length, requests };
}

/** Fixed producer-shaped pages, not a second implementation of its cap logic.
 * history.ts keeps the newer 500 rows; relay-client.test.ts verifies 1..1000
 * produces 501..1000 with truncated=true. */
export async function producerSuffix(mode: 'single' | 'multiple' | 'duplicate' = 'single') {
  await reset();
  const head = mode === 'multiple' ? 1500 : 1000;
  const pages = mode === 'multiple'
    ? [{ from: 1001, to: 1500, truncated: true }, { from: 501, to: 1000, truncated: true }, { from: 1, to: 500, truncated: false }]
    : mode === 'duplicate'
      ? [{ from: 501, to: 1000, truncated: true }, { from: 501, to: 1000, truncated: true }]
      : [{ from: 501, to: 1000, truncated: true }, { from: 1, to: 500, truncated: false }];
  messageProvider.setTentacleInfo(sessionId, head, deviceId);
  const requests: Array<{ fromSeq: number; toSeq: number }> = [];
  messageProvider.setSend(m => {
    const p = m.payload as { fromSeq: number; toSeq: number };
    requests.push({ fromSeq: p.fromSeq, toSeq: p.toSeq });
    const page = pages[requests.length - 1];
    if (!page) throw new Error('Producer-shaped fixture exhausted');
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId,
      rows(page.from, page.to), page.from, page.to, page.truncated));
  });
  await messageProvider.fetchRange(sessionId, 1, head);
  const seqs = snapshot().map(m => m.seq);
  return { requests, status: status(), count: seqs.length,
    missing: Array.from({ length: head }, (_, i) => i + 1).filter(seq => !seqs.includes(seq)) };
}

/** A progressing middle page leaves two disjoint intervals. An authoritative
 * empty answer for one must settle it without suppressing the other. */
export async function middlePage(emptyOlder = false) {
  await reset();
  messageProvider.setTentacleInfo(sessionId, 3, deviceId);
  const pages = [
    { messages: [message(2)], truncated: true },
    { messages: emptyOlder ? [] : [message(1)], truncated: false },
    { messages: [message(3)], truncated: false },
  ];
  const requests: Array<{ fromSeq: number; toSeq: number }> = [];
  messageProvider.setSend(m => {
    const p = m.payload as { fromSeq: number; toSeq: number };
    requests.push({ fromSeq: p.fromSeq, toSeq: p.toSeq });
    const page = pages[requests.length - 1];
    if (!page) throw new Error('Middle-page fixture exhausted');
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId, page.messages, page.messages[0]?.seq ?? 0, page.messages.at(-1)?.seq ?? 0, page.truncated));
  });
  await messageProvider.fetchRange(sessionId, 1, 3);
  return { requests, status: status(), seqs: snapshot().map(m => m.seq) };
}

/** Hold every real store import->putMessages callback until after the scenario
 * has performed its immediate retry/automatic tail follow-up. No flush/wait is
 * inserted before either decision, and the in-memory delivery remains real. */
async function withHeldStorePersistence(run: () => Promise<any>) {
  const originalThen = Promise.prototype.then;
  const release = deferred();
  let held = 0;
  Promise.prototype.then = function(onfulfilled: any, onrejected: any) {
    return originalThen.call(this, (value: any) => {
      // Vitest also chains module resolution through .then. Hold only the
      // actual store writer callback, never provider import/read continuations.
      if (value?.putMessages === db.putMessages && typeof onfulfilled === 'function'
        && Function.prototype.toString.call(onfulfilled).includes('.putMessages(')) {
        held++;
        return originalThen.call(release.promise, () => onfulfilled ? onfulfilled(value) : value);
      }
      return onfulfilled ? onfulfilled(value) : value;
    }, onrejected) as any;
  };
  try {
    const result = await run();
    return { ...result, heldPersistenceCallbacks: held };
  } finally {
    Promise.prototype.then = originalThen;
    release.resolve();
  }
}

export async function memoryCoverageControl() {
  await reset();
  await db.putMessages(sessionId, [message(1, 'agent_message', { content: 'idb-old' }), message(3)]);
  const memory = [
    message(1, 'agent_message', { content: 'memory-new' }),
    message(3, 'agent_message', { content: 'memory-three' }),
    message(2, 'active', {}),
    message(2, 'tool_start', {}),
    message(2, 'answer', {}),
    { ...message(2), sessionId: 'wrong-session' } as ChatMessage,
    message(2.5), message(0),
  ];
  useStore.setState({ messages: new Map([[sessionId, memory]]) });
  messageProvider.setTentacleInfo(sessionId, 3, deviceId);
  const requests: Array<{ fromSeq: number; toSeq: number }> = [];
  messageProvider.setSend(m => {
    const p = m.payload as { fromSeq: number; toSeq: number };
    requests.push({ fromSeq: p.fromSeq, toSeq: p.toSeq });
    queueMicrotask(() => messageProvider.handleRangeBatch(sessionId,
      [message(2), message(3, 'agent_message', { content: 'server-three' })], 2, 3, false));
  });
  await messageProvider.fetchRange(sessionId, 1, 3);
  return { requests, rows: snapshot(), status: status() };
}

export const cases: Record<string, () => Promise<any>> = {
  'F3-held-persistence-page-limit': () => withHeldStorePersistence(pageLimit),
  'F3-held-persistence-newer-tail': () => withHeldStorePersistence(newerTail),
  'F3-memory-coverage-control': memoryCoverageControl,
  'F3-producer-suffix': () => producerSuffix(),
  'F3-producer-multiple-suffix': () => producerSuffix('multiple'),
  'F3-producer-duplicate-suffix-control': () => producerSuffix('duplicate'),
  'F3-middle-progress': () => middlePage(),
  'F3-middle-empty-control': () => middlePage(true),
  'F2-idempotence-control': replayIdempotence,
  'F2-cache': () => replayConfirmation('cache'),
  'F2-range': () => replayConfirmation('range'),
  'F2-unsolicited': () => replayConfirmation('unsolicited'),
  'F2-restore': () => replayConfirmation('restore'),
  'F2-live-control': () => replayConfirmation('live'),
  'F2-wrong-session-control': () => replayConfirmation('wrong-session'),
  'F2-wrong-type-control': () => replayConfirmation('wrong-type'),
  'F3-duplicate-truncated': repeatedTruncated,
  'F3-page-limit': pageLimit,
  'F3-preemption-control': foregroundPreemptsContinuation,
  'F3-newer-tail-control': newerTail,
  'F3-gap': () => gap(),
  'F3-truncated': () => gap(100, true),
  'F3-large-gap': () => gap(220),
  'F3-contiguous-control': () => gap(100, false, true),
  'F3-authoritative-replacement': replacement,
  'F3-empty-truncated': () => truncatedNoProgress('empty'),
  'F3-nonprefix-truncated': () => truncatedNoProgress('duplicate'),
  'F3-outside-truncated': () => truncatedNoProgress('outside'),
  'F9-status-control': statusSubscription,
  'F9-timeout': () => timeout(),
  'F10-request-clear-control': clearPendingRequest,
  'F10-unsolicited-control': unsolicitedDuringRead,
  'F10-overlap': () => staleIDB(),
  'F10-deleted': () => staleIDB(true),
  'F10-control': () => staleIDB(false, true),
  'F10-invalidate': invalidateDuringRead,
};
export function invariant(name: string, result: any): boolean {
  if (name === 'F3-held-persistence-page-limit') return result.heldPersistenceCallbacks > 0 && invariant('F3-page-limit', result);
  if (name === 'F3-held-persistence-newer-tail') return result.heldPersistenceCallbacks > 0 && invariant('F3-newer-tail-control', result);
  if (name === 'F3-memory-coverage-control') return result.status.state === 'loaded'
    && JSON.stringify(result.requests) === JSON.stringify([{ fromSeq: 2, toSeq: 3 }])
    && result.rows.find((m: any) => m.seq === 1)?.payload.content === 'memory-new'
    && result.rows.find((m: any) => m.seq === 3)?.payload.content === 'server-three';
  if (name === 'F3-producer-duplicate-suffix-control') return result.status.error === 'timeout'
    && result.count === 500 && result.missing.length === 500
    && JSON.stringify(result.requests) === JSON.stringify([{ fromSeq: 1, toSeq: 1000 }, { fromSeq: 1, toSeq: 500 }]);
  if (name === 'F3-producer-suffix' || name === 'F3-producer-multiple-suffix') {
    const expected = name === 'F3-producer-suffix'
      ? [{ fromSeq: 1, toSeq: 1000 }, { fromSeq: 1, toSeq: 500 }]
      : [{ fromSeq: 1, toSeq: 1500 }, { fromSeq: 1, toSeq: 1000 }, { fromSeq: 1, toSeq: 500 }];
    return result.status.state === 'loaded' && result.missing.length === 0
      && JSON.stringify(result.requests) === JSON.stringify(expected);
  }
  if (name === 'F3-middle-progress' || name === 'F3-middle-empty-control') {
    return result.status.state === 'loaded'
      && JSON.stringify(result.requests) === JSON.stringify([{ fromSeq: 1, toSeq: 3 }, { fromSeq: 1, toSeq: 1 }, { fromSeq: 3, toSeq: 3 }])
      && JSON.stringify(result.seqs) === JSON.stringify(name === 'F3-middle-progress' ? [1, 2, 3] : [2, 3]);
  }
  if (name === 'F3-preemption-control') return result.next.fromSeq === 71 && result.next.toSeq === 120 && result.count === 70;
  if (name === 'F10-request-clear-control') return result.retained && result.count === 1 && result.status.state === 'loaded';
  if (name === 'F2-idempotence-control') return result.withoutClient === 1 && result.mismatchedRow === 1 && result.remaining === 0 && result.persisted === 0;
  if (name === 'F3-duplicate-truncated') return result.requests.length === 2 && result.status.error === 'timeout' && result.count === 1 && result.requests[1].fromSeq === 2;
  if (name === 'F3-page-limit') return result.first.requests === 50 && result.first.status.error === 'page-limit' && result.count === 60 && result.requests[50].fromSeq === 51;
  if (name === 'F3-newer-tail-control') return result.requests.length === 2 && result.requests[1].toSeq === 120 && result.requests[1].fromSeq === 101 && result.count === 70;
  if (name === 'F9-status-control') return result.stable && result.unsubscribed && result.cleared === 'idle' && result.states.join(',') === 'loading,loaded';
  if (name === 'F10-unsolicited-control') return result.loading && result.count === 2;
  if (name.startsWith('F2-')) return result.invariant && result.persisted === result.remaining;
  if (name === 'F3-large-gap') return result.stages[0].status.state === 'incomplete'
    && result.stages[1].missing.length < result.stages[0].missing.length
    && result.stages.at(-1).missing.length === 0;
  if (name === 'F3-authoritative-replacement') return result.rows.find((m: any) => m.seq === 3)?.payload.content === 'authoritative';
  if (name === 'F3-nonprefix-truncated') return result.requests === 2 && result.status.error === 'timeout'
    && JSON.stringify(result.ranges) === JSON.stringify([{ fromSeq: 1, toSeq: 3 }, { fromSeq: 1, toSeq: 1 }])
    && JSON.stringify(result.rows.map((m: any) => m.seq)) === '[2]';
  if (name === 'F3-outside-truncated') return result.requests === 1 && result.status.error === 'timeout'
    && result.rows.length === 1 && result.rows[0].seq === 100; // Retain unsolicited rows, never cover the pull.
  if (name.includes('truncated') && !['F3-truncated'].includes(name)) return result.requests === 1 && result.status.state === 'error' && result.rows.every((m: any) => m.seq <= 3);
  if (name.startsWith('F3-')) return result.stages.at(-1).missing.length === 0;
  if (name === 'F9-timeout') return result.failed.state === 'error' && result.failed.error === 'timeout' && result.confirming.state === 'loading' && result.requests === 3 && result.recovered.state === 'loaded';
  if (name === 'F10-invalidate') return result.count === 0 && result.persisted === 0;
  return result.invariant && (name !== 'F10-overlap' || result.oldRows === undefined || result.oldRows === 0);
}
