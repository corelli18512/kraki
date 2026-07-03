/**
 * PulseSocket — a thin adapter binding the pure {@link Endpoint} core to a real
 * transport and real timers. This is the ONLY part of pulse that touches I/O.
 *
 * It is transport-agnostic: you supply a `connect()` that returns a minimal
 * duplex byte channel ({@link RawLink}). That same interface is satisfied by
 * Node's `ws` and the browser `WebSocket` (see the two factory helpers). The
 * adapter carries out {@link Effect}s: `transmit`→link.send, `open`→connect,
 * `close`→link.close, and surfaces `deliver`/`reset-inbound` to your callback.
 */

import { Endpoint } from './endpoint.js';
import type { Effect, EndpointOptions, Payload, Seq } from './types.js';

/** The minimal duplex byte channel the adapter needs. Both Node `ws` and the
 *  browser `WebSocket` can be wrapped to satisfy this. */
export interface RawLink {
  send(bytes: Uint8Array): void;
  close(): void;
  /** Called by the adapter to register handlers; invoke them as events occur. */
  onOpen(cb: () => void): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
}

export interface PulseSocketOptions extends EndpointOptions {
  /** Open a fresh link. Called on start and on every reconnect. */
  connect: () => RawLink;
  /** Delivered application payloads, in order, exactly once. */
  onDeliver: (seq: Seq, payload: Payload) => void;
  /** Inbound history was lost; re-sync from `fromSeq`. (spec §5.4) */
  onResetInbound?: (fromSeq: Seq, peerEpoch: string) => void;
  /** Snapshot persistence hook, called after state changes for durability. */
  onSnapshot?: (snapshot: ReturnType<Endpoint['snapshot']>) => void;
  /** Clock injection for tests. Defaults to Date.now via performance.now-ish. */
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class PulseSocket {
  private readonly ep: Endpoint;
  private readonly opts: PulseSocketOptions;
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private link: RawLink | null = null;
  private timer: unknown = null;
  private started = false;

  constructor(opts: PulseSocketOptions) {
    this.opts = opts;
    this.ep = new Endpoint(opts);
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Begin: dial the link and start the clock loop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.dial();
    this.scheduleTick();
  }

  /** Send an application payload. Safe to call while disconnected (queued). */
  send(payload: Payload): Seq {
    const { seq, effects } = this.ep.send(payload);
    this.run(effects);
    this.snapshot();
    return seq;
  }

  /** Stop the socket and release timers. Does not clear durable state. */
  stop(): void {
    this.started = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    this.link?.close();
    this.link = null;
  }

  // ── Effect execution ──────────────────────────────────────────────────────

  private run(effects: Effect[]): void {
    for (const e of effects) {
      switch (e.t) {
        case 'transmit':
          this.link?.send(e.bytes);
          break;
        case 'deliver':
          this.opts.onDeliver(e.seq, e.payload);
          break;
        case 'reset-inbound':
          this.opts.onResetInbound?.(e.fromSeq, e.peerEpoch);
          break;
        case 'open':
          this.dial();
          break;
        case 'close':
          this.link?.close();
          this.link = null;
          break;
      }
    }
    this.scheduleTick();
  }

  private dial(): void {
    // Tear down any prior link first.
    const prev = this.link;
    this.link = null;
    prev?.close();

    const link = this.opts.connect();
    this.link = link;
    link.onOpen(() => {
      this.run(this.ep.onConnected(this.now()));
    });
    link.onMessage((bytes) => {
      this.run(this.ep.onBytes(bytes, this.now()));
      this.snapshot();
    });
    link.onClose(() => {
      if (this.link === link) this.link = null;
      this.run(this.ep.onDisconnected(this.now()));
    });
    link.onError(() => {
      // Treat error as a disconnect; the close handler may also fire.
      if (this.link === link) {
        this.link = null;
        this.run(this.ep.onDisconnected(this.now()));
      }
    });
  }

  // ── Timer loop: sleep exactly until the core's next deadline ──────────────

  private scheduleTick(): void {
    if (!this.started) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const deadline = this.ep.nextDeadline();
    if (deadline === null) return;
    const delay = Math.max(0, deadline - this.now());
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.run(this.ep.onTick(this.now()));
    }, delay);
  }

  private snapshot(): void {
    this.opts.onSnapshot?.(this.ep.snapshot());
  }

  /** Expose the core for observation (link state, cursors, outbox size). */
  get endpoint(): Endpoint {
    return this.ep;
  }
}

// ── Transport factory helpers ────────────────────────────────────────────────

/**
 * Wrap a browser-style `WebSocket` constructor into a {@link RawLink} factory.
 * Usage: `connect: browserLink(() => new WebSocket(url))`.
 */
export function browserLink(make: () => WebSocketLike): () => RawLink {
  return () => {
    const ws = make();
    ws.binaryType = 'arraybuffer';
    return {
      send: (bytes) => ws.send(bytes),
      close: () => ws.close(),
      onOpen: (cb) => ws.addEventListener('open', () => cb()),
      onMessage: (cb) =>
        ws.addEventListener('message', (ev: { data: unknown }) => {
          const d = ev.data;
          if (d instanceof ArrayBuffer) cb(new Uint8Array(d));
          else if (ArrayBuffer.isView(d)) cb(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
        }),
      onClose: (cb) => ws.addEventListener('close', () => cb()),
      onError: (cb) => ws.addEventListener('error', (e: unknown) => cb(e)),
    };
  };
}

/** Minimal structural type for a browser WebSocket (avoids a DOM lib dep). */
export interface WebSocketLike {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (ev: never) => void): void;
}
