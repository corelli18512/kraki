/**
 * DoubaoClient — a thin WS wrapper around the Doubao streaming ASR endpoint.
 *
 * Lifecycle:
 *   1. `new DoubaoClient({...}).connect()`     — opens WS with auth headers
 *   2. emits 'open'                            — server accepted the upgrade
 *   3. `start(config)`                         — sends the first config frame
 *   4. `sendAudio(chunk)` repeatedly           — ~200ms chunks of 16k mono PCM
 *   5. `finish()`                              — sends the empty LAST frame
 *   6. emits 'transcript' / 'final' / 'close'
 *
 * The class is provider-agnostic enough that swapping `endpoint` to the mock
 * server (see `mock-doubao.ts`) Just Works — same wire protocol both sides.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  type ClientConfigRequest,
  type ParsedServerFrame,
  type ServerResponse,
  buildAudioFrame,
  buildClientConfigFrame,
  defaultClientConfig,
  parseServerFrame,
  pickBestCandidate,
} from './doubao.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';

export interface DoubaoClientOptions {
  appKey: string;
  accessKey: string;
  resourceId: string;
  endpoint: string;
  /** Optional override for X-Api-Connect-Id (one is generated otherwise). */
  connectId?: string;
  /** Optional extra headers (for testing / proxies). */
  extraHeaders?: Record<string, string>;
  /** Logger; one is created if omitted. */
  logger?: Logger;
}

export interface TranscriptUpdate {
  /** The current full transcript string for this session (picked best candidate). */
  text: string;
  /** True when this update finalizes a segment (utterance.definite=true). */
  finalSegment: boolean;
  /** True when this is the last frame Doubao will send for the session. */
  sessionFinal: boolean;
  /** Raw parsed payload — for callers who need utterance timings/words. */
  raw: ServerResponse;
}

export type DoubaoClientEvents = {
  open: [];
  ready: [];
  transcript: [TranscriptUpdate];
  /** Convenience — fires only on session-final frames (after finish()). */
  final: [TranscriptUpdate];
  error: [Error];
  close: [code: number, reason: string];
};

export declare interface DoubaoClient {
  on<K extends keyof DoubaoClientEvents>(event: K, listener: (...args: DoubaoClientEvents[K]) => void): this;
  emit<K extends keyof DoubaoClientEvents>(event: K, ...args: DoubaoClientEvents[K]): boolean;
}

export class DoubaoClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly opts: DoubaoClientOptions;
  private readonly logger: Logger;
  private started = false;
  private finished = false;
  private closed = false;

  constructor(opts: DoubaoClientOptions) {
    super();
    this.opts = opts;
    this.logger = opts.logger ?? createLogger('doubao');
  }

  connect(): Promise<void> {
    const connectId = this.opts.connectId ?? randomUUID();
    const headers: Record<string, string> = {
      'X-Api-App-Key': this.opts.appKey,
      'X-Api-Access-Key': this.opts.accessKey,
      'X-Api-Resource-Id': this.opts.resourceId,
      'X-Api-Connect-Id': connectId,
      ...(this.opts.extraHeaders ?? {}),
    };

    this.logger.debug('connecting', { endpoint: this.opts.endpoint, connectId });
    const ws = new WebSocket(this.opts.endpoint, { headers });
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        this.logger.info('connected', { connectId });
        this.emit('open');
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        this.logger.error('connect failed', { error: err.message });
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.on('message', (data) => this.handleMessage(data as Buffer));
      ws.on('close', (code, reason) => {
        this.closed = true;
        const reasonStr = reason?.toString('utf-8') ?? '';
        this.logger.info('closed', { code, reason: reasonStr });
        this.emit('close', code, reasonStr);
      });
      ws.on('error', (err) => {
        this.logger.error('socket error', { error: err.message });
        this.emit('error', err);
      });
    });
  }

  /** Send the first FULL_CLIENT_REQUEST frame. Must be called once after connect(). */
  start(config?: Partial<ClientConfigRequest> & { uid?: string }): void {
    if (this.started) throw new Error('DoubaoClient.start() called twice');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('DoubaoClient.start() called before connect() resolved');
    }
    const base = defaultClientConfig(config?.uid ?? this.opts.connectId ?? 'kraki-voice-broker');
    const merged: ClientConfigRequest = {
      user: { ...base.user, ...config?.user },
      audio: { ...base.audio, ...config?.audio },
      request: { ...base.request, ...config?.request },
    };
    const frame = buildClientConfigFrame(merged);
    this.ws.send(frame);
    this.started = true;
    this.logger.debug('config sent', { rate: merged.audio.rate, format: merged.audio.format });
    this.emit('ready');
  }

  /**
   * Send one chunk of audio. `chunk` should be raw PCM (or whatever you
   * declared in start()'s audio.format). Recommended size: ~200ms worth.
   */
  sendAudio(chunk: Buffer): void {
    if (!this.started) throw new Error('sendAudio() called before start()');
    if (this.finished) throw new Error('sendAudio() called after finish()');
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('sendAudio() called on a closed connection');
    }
    this.ws.send(buildAudioFrame(chunk, false));
  }

  /** Send the empty LAST frame, signalling end-of-stream. */
  finish(): void {
    if (this.finished) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.finished = true;
      return;
    }
    this.ws.send(buildAudioFrame(Buffer.alloc(0), true));
    this.finished = true;
    this.logger.debug('finish sent');
  }

  /** Close the WS (after finish()'s response window). Idempotent. */
  close(code = 1000, reason = 'client done'): void {
    if (this.closed || !this.ws) return;
    try {
      this.ws.close(code, reason);
    } catch {
      // ignore
    }
  }

  // ─── internals ─────────────────────────────────────────────────────────

  private handleMessage(data: Buffer): void {
    let parsed: ParsedServerFrame;
    try {
      parsed = parseServerFrame(data);
    } catch (err) {
      this.emit('error', err as Error);
      return;
    }
    if (!parsed.json) return;
    const best = pickBestCandidate(parsed.json.result);
    const text = best?.text ?? '';
    const finalSegment = !!best?.utterances?.some((u) => u.definite === true);
    const update: TranscriptUpdate = {
      text,
      finalSegment,
      sessionFinal: parsed.isLast,
      raw: parsed.json,
    };
    this.emit('transcript', update);
    if (parsed.isLast) this.emit('final', update);
  }
}
