import type { ContentRef } from '@kraki/protocol';

export interface AttachmentChunkProgress {
  sessionId: string;
  id: string;
  index: number;
  total: number;
  paced?: true;
  error?: string;
}

export interface AttachmentChunkRequest {
  sessionId: string;
  id: string;
  index: number;
}

interface PullTask extends AttachmentChunkRequest {
  ref: ContentRef;
  retries: number;
  priority: 'high' | 'normal';
}

type SendChunkRequest = (request: AttachmentChunkRequest) => boolean;
type PullFailure = (sessionId: string, ref: ContentRef, reason: string) => void;
type PullRetry = (sessionId: string, ref: ContentRef, index: number, attempt: number) => void;

interface AttachmentPullQueueOptions {
  chunkTimeoutMs?: number;
  maxRetries?: number;
  onFailure?: PullFailure;
  onRetry?: PullRetry;
}

const DEFAULT_CHUNK_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Limits attachment traffic to one requested chunk at a time per Arm. Tasks
 * rotate after every chunk so concurrent downloads cannot fill Pulse's ordered
 * stream ahead of live messages.
 */
export class AttachmentPullQueue {
  private readonly queued: PullTask[] = [];
  private current: PullTask | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private readonly chunkTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly onFailure?: PullFailure;
  private readonly onRetry?: PullRetry;

  constructor(
    private readonly send: SendChunkRequest,
    options: AttachmentPullQueueOptions = {},
  ) {
    this.chunkTimeoutMs = options.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.onFailure = options.onFailure;
    this.onRetry = options.onRetry;
  }

  request(sessionId: string, ref: ContentRef): void {
    if (this.has(sessionId, ref.id)) return;
    const task: PullTask = {
      sessionId,
      id: ref.id,
      ref,
      index: 0,
      retries: 0,
      priority: ref.mimeType.startsWith('image/') ? 'high' : 'normal',
    };
    const firstNormal = this.queued.findIndex((queued) => queued.priority === 'normal');
    if (task.priority === 'high' && firstNormal >= 0) this.queued.splice(firstNormal, 0, task);
    else this.queued.push(task);
    this.pump();
  }

  handleChunk(chunk: AttachmentChunkProgress): void {
    const current = this.current;
    if (
      !current
      || current.sessionId !== chunk.sessionId
      || current.id !== chunk.id
      || current.index !== chunk.index
    ) return;

    this.clearChunkTimeout();
    this.current = null;

    // An older Tentacle ignores paced mode and sends the whole attachment.
    // Release the queue on its first response; the remaining legacy chunks are
    // already in Pulse and need no follow-up requests.
    if (!chunk.paced) {
      this.pump();
      return;
    }

    if (!chunk.error && chunk.index + 1 < chunk.total) {
      current.index = chunk.index + 1;
      current.retries = 0;
      this.enqueue(current);
    }
    this.pump();
  }

  disconnect(): void {
    this.clearChunkTimeout();
    if (this.current) {
      this.current.retries = 0;
      this.queued.unshift(this.current);
      this.current = null;
    }
  }

  resume(): void {
    this.pump();
  }

  private has(sessionId: string, id: string): boolean {
    if (this.current?.sessionId === sessionId && this.current.id === id) return true;
    return this.queued.some((task) => task.sessionId === sessionId && task.id === id);
  }

  private enqueue(task: PullTask): void {
    if (task.priority === 'high') {
      const firstNormal = this.queued.findIndex((queued) => queued.priority === 'normal');
      if (firstNormal >= 0) {
        this.queued.splice(firstNormal, 0, task);
        return;
      }
    }
    this.queued.push(task);
  }

  private pump(): void {
    if (this.current || this.queued.length === 0) return;
    const next = this.queued.shift()!;
    this.current = next;
    if (!this.sendRequest(next)) {
      this.current = null;
      this.queued.unshift(next);
      return;
    }
    this.armChunkTimeout(next);
  }

  private armChunkTimeout(task: PullTask): void {
    this.clearChunkTimeout();
    this.timeout = setTimeout(() => {
      if (this.current !== task) return;
      if (task.retries < this.maxRetries) {
        if (this.sendRequest(task)) {
          task.retries += 1;
          this.onRetry?.(task.sessionId, task.ref, task.index, task.retries);
          this.armChunkTimeout(task);
          return;
        }
        this.current = null;
        this.queued.unshift(task);
        return;
      }
      this.current = null;
      this.onFailure?.(
        task.sessionId,
        task.ref,
        `Timed out receiving attachment chunk ${task.index + 1} after ${task.retries + 1} attempts`,
      );
      this.pump();
    }, this.chunkTimeoutMs);
  }

  private sendRequest(task: PullTask): boolean {
    return this.send({ sessionId: task.sessionId, id: task.id, index: task.index });
  }

  private clearChunkTimeout(): void {
    if (!this.timeout) return;
    clearTimeout(this.timeout);
    this.timeout = null;
  }
}
