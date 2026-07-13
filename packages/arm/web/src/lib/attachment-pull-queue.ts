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

interface PullTask extends AttachmentChunkRequest {}

type SendChunkRequest = (request: AttachmentChunkRequest) => boolean;

/**
 * Limits attachment traffic to one requested chunk at a time per Arm. Tasks
 * rotate after every chunk so concurrent downloads cannot fill Pulse's ordered
 * stream ahead of live messages.
 */
export class AttachmentPullQueue {
  private readonly queued: PullTask[] = [];
  private current: PullTask | null = null;

  constructor(private readonly send: SendChunkRequest) {}

  request(sessionId: string, id: string): void {
    if (this.has(sessionId, id)) return;
    this.queued.push({ sessionId, id, index: 0 });
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
      this.queued.push(current);
    }
    this.pump();
  }

  disconnect(): void {
    if (this.current) {
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

  private pump(): void {
    if (this.current || this.queued.length === 0) return;
    const next = this.queued.shift()!;
    this.current = next;
    if (!this.send(next)) {
      this.current = null;
      this.queued.unshift(next);
    }
  }
}
