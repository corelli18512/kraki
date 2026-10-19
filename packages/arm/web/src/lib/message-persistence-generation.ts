/** Synchronous ownership shared by the lazy store scheduler and IndexedDB. */
export interface MessageGeneration {
  readonly ready?: Promise<void>;
}

export interface SessionDeletion {
  readonly sessionId: string;
  readonly previous: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const generations = new Map<string, MessageGeneration>();

export function captureMessageGeneration(sessionId: string): MessageGeneration {
  let generation = generations.get(sessionId);
  if (!generation) {
    generation = {};
    generations.set(sessionId, generation);
  }
  return generation;
}

export function isMessageGenerationCurrent(sessionId: string, generation: MessageGeneration): boolean {
  return generations.get(sessionId) === generation;
}

/** Reserve deletion BEFORE importing the DB. Future writes wait for its success;
 * old callbacks cannot acquire the new generation. Explicit deletion retries
 * may pass a failed predecessor, but must perform their own real deletion. */
export function beginSessionDeletion(sessionId: string): SessionDeletion {
  const previous = captureMessageGeneration(sessionId).ready?.catch(() => {}) ?? Promise.resolve();
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  // The scheduler may fail before any new writer observes this barrier. Keep
  // the original rejection for writers without creating an unhandled promise.
  void ready.catch(() => {});
  generations.set(sessionId, { ready });
  return { sessionId, previous, resolve, reject };
}
