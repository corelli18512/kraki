/**
 * Bounds how fast attachment bytes leave the tentacle.
 *
 * Attachments share one relay WebSocket with chat messages and liveness
 * pings. The relay's downlink to devices can be only a few Mbps; an old
 * client that requests a whole multi-MB report (non-paced) used to receive
 * every chunk at once, which queued megabytes in front of the relay's ping
 * and got the connection killed as stale — for every device at once.
 *
 * - Paced requests (one chunk per request, driven by the client) are sent
 *   immediately; the client already keeps at most one chunk in flight.
 *   Their bytes are still charged to the shared budget so legacy transfers
 *   back off while a user-visible transfer is running.
 * - Legacy whole-file requests become queued jobs sent one chunk at a time
 *   at `bytesPerSecond` (estimated wire bytes), round-robin across jobs,
 *   only while the requester is online. A repeated request restarts the job
 *   (the client lost its partial state), never duplicates it.
 */

export interface LegacyAttachmentJob {
  deviceId: string;
  sessionId: string;
  id: string;
  bytes: Buffer;
  mimeType: string;
}

export interface AttachmentPacerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface Job extends LegacyAttachmentJob {
  next: number;
  total: number;
  createdAt: number;
}

export class AttachmentPacer {
  static readonly DEFAULT_BYTES_PER_SECOND = 160 * 1024;
  /** Old clients pull every tool argument/result ref on their own, so many
   *  small jobs are normal; memory is bounded by queued bytes instead. */
  static readonly MAX_JOBS = 512;
  static readonly MAX_QUEUED_BYTES = 48 * 1024 * 1024;
  static readonly JOB_TTL_MS = 30 * 60_000;

  private jobs: Job[] = [];
  private nextAllowedAt = 0;
  private timer: unknown = null;

  constructor(
    private readonly options: {
      chunkBytes: number;
      /** Send one chunk; returns the estimated bytes it puts on the wire. */
      sendChunk: (job: LegacyAttachmentJob, index: number, total: number, slice: Buffer) => number;
      isOnline: (deviceId: string) => boolean;
      bytesPerSecond?: number;
      clock?: AttachmentPacerClock;
    },
  ) {}

  private get clock(): AttachmentPacerClock {
    return this.options.clock ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
  }

  private get rate(): number {
    return this.options.bytesPerSecond ?? AttachmentPacer.DEFAULT_BYTES_PER_SECOND;
  }

  /** Account for bytes sent outside the queue (paced chunks). */
  charge(wireBytes: number): void {
    const now = this.clock.now();
    this.nextAllowedAt = Math.max(this.nextAllowedAt, now) + (wireBytes / this.rate) * 1000;
  }

  enqueue(job: LegacyAttachmentJob): void {
    const total = Math.max(1, Math.ceil(job.bytes.length / this.options.chunkBytes));
    const existing = this.jobs.find(j => j.deviceId === job.deviceId && j.id === job.id);
    if (existing) {
      existing.next = 0;
      existing.createdAt = this.clock.now();
    } else {
      this.jobs.push({ ...job, next: 0, total, createdAt: this.clock.now() });
      let queued = this.jobs.reduce((sum, j) => sum + j.bytes.length, 0);
      while (this.jobs.length > 1 && (this.jobs.length > AttachmentPacer.MAX_JOBS || queued > AttachmentPacer.MAX_QUEUED_BYTES)) {
        queued -= this.jobs.shift()!.bytes.length;
      }
    }
    this.schedule(0);
  }

  /** The device came (back) online; resume its queued jobs. */
  notifyOnline(_deviceId: string): void {
    this.schedule(0);
  }

  /** Forget a device's jobs (device removed). */
  drop(deviceId: string): void {
    this.jobs = this.jobs.filter(j => j.deviceId !== deviceId);
  }

  get pendingJobs(): number {
    return this.jobs.length;
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(0, delayMs));
  }

  private pump(): void {
    const now = this.clock.now();
    this.jobs = this.jobs.filter(j => now - j.createdAt < AttachmentPacer.JOB_TTL_MS);
    if (this.jobs.length === 0) return;
    if (now < this.nextAllowedAt) {
      this.schedule(this.nextAllowedAt - now);
      return;
    }
    const index = this.jobs.findIndex(j => this.options.isOnline(j.deviceId));
    // Nobody reachable: wait for notifyOnline (or a new request).
    if (index < 0) return;
    const job = this.jobs[index];
    const start = job.next * this.options.chunkBytes;
    const slice = job.bytes.subarray(start, Math.min(start + this.options.chunkBytes, job.bytes.length));
    const i = job.next;
    job.next += 1;
    // Round-robin: move the job to the back (or drop it when complete).
    this.jobs.splice(index, 1);
    if (job.next < job.total) this.jobs.push(job);
    let wire = slice.length;
    try {
      wire = this.options.sendChunk(job, i, job.total, slice);
    } catch {
      // A send failure must not wedge the queue; the client can re-request.
    }
    this.charge(wire);
    if (this.jobs.length > 0) this.schedule(this.nextAllowedAt - this.clock.now());
  }
}
