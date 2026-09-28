/**
 * Programmable L4 fault-injection proxy for Kraki resilience tests.
 *
 * Sits between a client (App or Tentacle) and Head. Every accepted client
 * connection gets its own upstream socket; bytes are forwarded per direction
 * through a scheduler that applies the current fault profile:
 *
 *   latencyMs/jitterMs   one-way delay added to each chunk (order preserved)
 *   bytesPerSec          shared token bucket per direction (0 = unlimited)
 *   blackhole            'none' | 'both' | 'up' | 'down' — bytes are held,
 *                        sockets stay open (half-open from the peers' view)
 *   refuse               new connections are accepted and closed at once
 *   stallHandshake       new connections forward nothing until healed
 *
 * Like a real bottleneck, each direction buffers at most `maxQueueBytes`;
 * beyond that the proxy stops reading from the sender (TCP backpressure), so
 * the sender's own send buffer grows as it would on a congested link.
 *
 * `reset()` destroys every live connection (RST). All actions and connection
 * lifecycles are recorded in a timeline for post-run assertions.
 *
 * Localhost only. Never pointed at production.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';

export type Direction = 'up' | 'down';

export interface FaultProfile {
  latencyMs: number;
  jitterMs: number;
  bytesPerSec: number;
  blackhole: 'none' | 'both' | Direction;
  refuse: boolean;
  stallHandshake: boolean;
}

export const HEALTHY: FaultProfile = {
  latencyMs: 0, jitterMs: 0, bytesPerSec: 0, blackhole: 'none', refuse: false, stallHandshake: false,
};

export interface TimelineEvent { t: number; link: string; event: string; detail?: Record<string, unknown> }

interface Pipe {
  id: number;
  client: Socket;
  upstream: Socket;
  openedAt: number;
  /** Connections that arrived while the handshake was stalled forward nothing
   *  until healed (like a TLS/HTTP upgrade that never completes). */
  stalled: boolean;
  queues: Record<Direction, Array<{ due: number; data: Buffer }>>;
  bytes: Record<Direction, number>;
  queued: Record<Direction, number>;
}

class TokenBucket {
  private tokens = 0;
  private last = Date.now();
  constructor(private rate: () => number) {}
  /** Bytes allowed now (Infinity when unlimited). */
  available(): number {
    const rate = this.rate();
    if (rate <= 0) return Number.POSITIVE_INFINITY;
    const now = Date.now();
    this.tokens = Math.min(rate * 0.25, this.tokens + ((now - this.last) / 1000) * rate); // ≤250 ms burst
    this.last = now;
    return this.tokens;
  }
  take(n: number): void { if (this.rate() > 0) this.tokens -= n; }
}

export class ChaosProxy {
  readonly timeline: TimelineEvent[] = [];
  profile: FaultProfile = { ...HEALTHY };
  private server: Server | null = null;
  private pipes = new Map<number, Pipe>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buckets: Record<Direction, TokenBucket>;
  port = 0;
  totalConnections = 0;
  maxQueueBytes = 256 * 1024;

  constructor(readonly link: string, private upstreamPort: () => number, private random: () => number = Math.random) {
    this.buckets = {
      up: new TokenBucket(() => this.profile.bytesPerSec),
      down: new TokenBucket(() => this.profile.bytesPerSec),
    };
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.timeline.push({ t: Date.now(), link: this.link, event, ...(detail && { detail }) });
  }

  async listen(port = 0): Promise<number> {
    this.server = createServer((client) => this.accept(client));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server!.address() as { port: number }).port;
    this.timer = setInterval(() => this.pump(), 5);
    this.timer.unref?.();
    return this.port;
  }

  private accept(client: Socket): void {
    client.setNoDelay(true);
    if (this.profile.refuse) {
      this.log('refused');
      client.resetAndDestroy();
      return;
    }
    const upstream = connect(this.upstreamPort(), '127.0.0.1');
    upstream.setNoDelay(true);
    const pipe: Pipe = {
      id: this.nextId++, client, upstream, openedAt: Date.now(), stalled: this.profile.stallHandshake,
      queues: { up: [], down: [] }, bytes: { up: 0, down: 0 }, queued: { up: 0, down: 0 },
    };
    this.pipes.set(pipe.id, pipe);
    this.totalConnections += 1;
    this.log('open', { conn: pipe.id, stalled: pipe.stalled });
    const enqueue = (dir: Direction) => (data: Buffer) => {
      const jitter = this.profile.jitterMs > 0 ? this.random() * this.profile.jitterMs : 0;
      const queue = pipe.queues[dir];
      // Order-preserving: never schedule before the previous chunk.
      const prev = queue.length ? queue[queue.length - 1].due : 0;
      queue.push({ due: Math.max(prev, Date.now() + this.profile.latencyMs + jitter), data });
      pipe.queued[dir] += data.length;
      if (pipe.queued[dir] > this.maxQueueBytes) (dir === 'up' ? client : upstream).pause();
    };
    client.on('data', enqueue('up'));
    upstream.on('data', enqueue('down'));
    const close = (why: string) => () => this.drop(pipe, why);
    client.on('close', close('client_closed'));
    upstream.on('close', close('upstream_closed'));
    client.on('error', () => {});
    upstream.on('error', () => {});
  }

  private drop(pipe: Pipe, why: string): void {
    if (!this.pipes.delete(pipe.id)) return;
    this.closedBytes.up += pipe.bytes.up;
    this.closedBytes.down += pipe.bytes.down;
    this.log('close', { conn: pipe.id, why, up: pipe.bytes.up, down: pipe.bytes.down, lifetimeMs: Date.now() - pipe.openedAt });
    pipe.client.destroy();
    pipe.upstream.destroy();
  }

  private blocked(dir: Direction): boolean {
    const b = this.profile.blackhole;
    return b === 'both' || b === dir;
  }

  private pump(): void {
    const now = Date.now();
    for (const dir of ['up', 'down'] as const) {
      if (this.blocked(dir)) continue;
      let budget = this.buckets[dir].available();
      // Round-robin across connections so one bulk transfer cannot starve others.
      let progressed = true;
      while (budget > 0 && progressed) {
        progressed = false;
        for (const pipe of this.pipes.values()) {
          if (pipe.stalled) continue;
          const head = pipe.queues[dir][0];
          if (!head || head.due > now || budget <= 0) continue;
          const n = Math.min(head.data.length, Math.max(1, Math.floor(Math.min(budget, 16 * 1024))));
          const chunk = head.data.subarray(0, n);
          head.data = head.data.subarray(n);
          if (head.data.length === 0) pipe.queues[dir].shift();
          (dir === 'up' ? pipe.upstream : pipe.client).write(chunk);
          pipe.bytes[dir] += n;
          pipe.queued[dir] -= n;
          if (pipe.queued[dir] <= this.maxQueueBytes / 2) (dir === 'up' ? pipe.client : pipe.upstream).resume();
          this.buckets[dir].take(n);
          budget -= n;
          progressed = true;
        }
      }
    }
  }

  /** Apply a fault profile (merged over the current one). */
  set(patch: Partial<FaultProfile>): void {
    this.profile = { ...this.profile, ...patch };
    if (patch.stallHandshake === false) for (const p of this.pipes.values()) p.stalled = false;
    this.log('fault', patch as Record<string, unknown>);
  }

  heal(): void {
    this.profile = { ...HEALTHY };
    for (const p of this.pipes.values()) p.stalled = false;
    this.log('heal');
  }

  /** Abruptly reset every live connection (like a NAT/proxy restart). */
  reset(): void {
    this.log('reset', { connections: this.pipes.size });
    for (const pipe of [...this.pipes.values()]) {
      pipe.client.resetAndDestroy();
      pipe.upstream.destroy();
      this.drop(pipe, 'reset');
    }
  }

  get liveConnections(): number { return this.pipes.size; }
  /** Total bytes forwarded per direction over the proxy's lifetime. */
  get bytesForwarded(): Record<Direction, number> {
    let up = this.closedBytes.up, down = this.closedBytes.down;
    for (const p of this.pipes.values()) { up += p.bytes.up; down += p.bytes.down; }
    return { up, down };
  }
  private closedBytes: Record<Direction, number> = { up: 0, down: 0 };

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.reset();
    await new Promise<void>((resolve) => this.server ? this.server.close(() => resolve()) : resolve());
  }
}
