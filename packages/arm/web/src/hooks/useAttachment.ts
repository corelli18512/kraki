/**
 * React hook for reading an attachment by ref.
 *
 * Returns a stable shape the UI can switch on:
 *   - status: 'loading' | 'ready' | 'error'
 *   - url: object URL (only when status === 'ready')
 *   - error: reason string (only when status === 'error')
 *
 * Internally subscribes to the attachment state machine in
 * `lib/attachments.ts`. The first mount per id may hydrate from IDB; if
 * that misses and we have no live push pending, it triggers a pull via
 * `wsClient.requestAttachment`.
 *
 * Object URLs are created here and revoked on unmount so they don't leak
 * across remounts (e.g. virtualised chat lists).
 */

import { useEffect, useState } from 'react';

import type { ContentRef } from '@kraki/protocol';

import {
  type AttachmentState,
  getState,
  hydrateFromIDB,
  markFetching,
  subscribe,
} from '../lib/attachments';

interface UseAttachmentResult {
  status: 'loading' | 'ready' | 'error';
  url: string | null;
  error: string | null;
}

interface UseAttachmentTextResult {
  status: 'loading' | 'ready' | 'error';
  text: string | null;
  error: string | null;
}

/** wsClient.requestAttachment thunk — kept loose to avoid an import cycle. */
type RequestPull = (sessionId: string, id: string) => void;

/** Shared hydrate guard so concurrent mounts don't fan out duplicate IDB reads. */
const hydratedIds = new Set<string>();
const hydratingIds = new Map<string, Promise<boolean>>();

function hydrateOnce(id: string): Promise<boolean> {
  if (hydratedIds.has(id)) return Promise.resolve(true);
  let p = hydratingIds.get(id);
  if (!p) {
    p = hydrateFromIDB(id).then((hit) => {
      if (hit) hydratedIds.add(id);
      hydratingIds.delete(id);
      return hit;
    });
    hydratingIds.set(id, p);
  }
  return p;
}

/** Common subscribe + auto-fetch effect shared by useAttachment and
 *  useAttachmentText. */
function useAttachmentLifecycle(
  ref: ContentRef,
  sessionId: string,
  requestPull: RequestPull,
  enabled: boolean,
): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    function onUpdate(): void {
      if (cancelled) return;
      setTick((t) => t + 1);
    }
    const unsubscribe = subscribe(ref.id, onUpdate);
    async function init(): Promise<void> {
      const existing = getState(ref.id);
      if (existing?.kind === 'ready') return;
      if (existing?.kind === 'awaiting-chunks' || existing?.kind === 'fetching') return;
      const hit = await hydrateOnce(ref.id);
      if (cancelled) return;
      if (hit) return;
      markFetching(ref.id);
      requestPull(sessionId, ref.id);
    }
    void init();
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // requestPull identity changes every render; we deliberately exclude it
    // from deps so this effect only re-runs when the id/session changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.id, sessionId, enabled]);
  return tick;
}

export function useAttachment(
  ref: ContentRef,
  sessionId: string,
  requestPull: RequestPull,
): UseAttachmentResult {
  const tick = useAttachmentLifecycle(ref, sessionId, requestPull, true);
  const [url, setUrl] = useState<string | null>(null);

  // Derive object URL from current state. Re-runs on every notify.
  useEffect(() => {
    const state = getState(ref.id);
    if (state?.kind === 'ready') {
      const objUrl = URL.createObjectURL(state.blob);
      setUrl(objUrl);
      return () => {
        URL.revokeObjectURL(objUrl);
        setUrl(null);
      };
    }
    setUrl(null);
    return undefined;
    // We re-derive on every `tick` push from the state subscriber.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.id, tick]);

  const state = getState(ref.id) as AttachmentState | undefined;
  if (state?.kind === 'ready' && url) {
    return { status: 'ready', url, error: null };
  }
  if (state?.kind === 'error') {
    return { status: 'error', url: null, error: state.reason };
  }
  return { status: 'loading', url: null, error: null };
}

/** Sibling of {@link useAttachment} that decodes the bytes as UTF-8 text.
 *  Use for tool result/args refs (mime `text/plain` or `application/json`).
 *  Set `enabled=false` to skip the fetch entirely (e.g. while a collapsed
 *  chip doesn't need the body yet). */
export function useAttachmentText(
  ref: ContentRef,
  sessionId: string,
  requestPull: RequestPull,
  enabled = true,
): UseAttachmentTextResult {
  const tick = useAttachmentLifecycle(ref, sessionId, requestPull, enabled);
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const state = getState(ref.id);
    if (state?.kind === 'ready') {
      let cancelled = false;
      void state.blob.text().then((t) => {
        if (!cancelled) setText(t);
      });
      return () => {
        cancelled = true;
      };
    }
    setText(null);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.id, tick]);

  const state = getState(ref.id) as AttachmentState | undefined;
  if (state?.kind === 'ready' && text !== null) {
    return { status: 'ready', text, error: null };
  }
  if (state?.kind === 'error') {
    return { status: 'error', text: null, error: state.reason };
  }
  return { status: 'loading', text: null, error: null };
}
