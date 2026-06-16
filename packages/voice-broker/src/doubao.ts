/**
 * Doubao / Volcengine streaming ASR (大模型版) protocol client.
 *
 * Wire format reverse-engineered from the official protocol notes + the
 * production references cited in the handover doc (proma-ai/Proma's
 * doubao-asr-service.ts and 78/voicestick's docs).
 *
 * Frame layout
 * ────────────
 * Every frame:  4-byte header | 4-byte big-endian payload size | payload
 *
 * Header bytes (4):
 *   [0] = (PROTOCOL_VERSION << 4) | HEADER_SIZE        // 0x11
 *   [1] = (MESSAGE_TYPE     << 4) | FLAGS
 *   [2] = (SERIALIZATION    << 4) | COMPRESSION
 *   [3] = 0x00
 *
 * Server frames may include a 4-byte sequence number between header and
 * payload size when the SEQUENCE flag bit is set. SERVER_LAST_SEQUENCE marks
 * the final transcript frame for a session.
 *
 * Reference impls
 * ───────────────
 *   proma-ai/Proma           apps/electron/src/main/lib/doubao-asr-service.ts
 *   78/voicestick            docs/volcengine-asr.md
 */

import { gunzipSync, gzipSync } from 'node:zlib';

// ─── Protocol constants ──────────────────────────────────────────────────

export const PROTOCOL_VERSION = 0b0001;
export const HEADER_SIZE = 0b0001; // in 4-byte words → 1 = 4 bytes

export const MessageType = {
  FULL_CLIENT_REQUEST: 0b0001,
  AUDIO_ONLY_REQUEST: 0b0010,
  FULL_SERVER_RESPONSE: 0b1001,
  SERVER_ERROR: 0b1111,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const Flags = {
  NO_SEQUENCE: 0b0000,
  /** Set on the final (empty) AUDIO_ONLY_REQUEST to signal end-of-stream. */
  LAST_NO_SEQUENCE: 0b0010,
  /** Server frame carries a 4-byte sequence after the header. */
  SERVER_SEQUENCE: 0b0001,
  /** Server frame is both sequenced AND the last for this session. */
  SERVER_LAST_SEQUENCE: 0b0011,
} as const;
export type Flags = (typeof Flags)[keyof typeof Flags];

export const Serialization = {
  NONE: 0b0000,
  JSON: 0b0001,
} as const;
export type Serialization = (typeof Serialization)[keyof typeof Serialization];

export const Compression = {
  NONE: 0b0000,
  GZIP: 0b0001,
} as const;
export type Compression = (typeof Compression)[keyof typeof Compression];

// ─── Frame codec (pure, no IO) ───────────────────────────────────────────

export function buildHeader(
  messageType: MessageType,
  flags: Flags,
  serialization: Serialization,
  compression: Compression,
): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
}

export function buildFrame(
  messageType: MessageType,
  flags: Flags,
  serialization: Serialization,
  compression: Compression,
  payload: Buffer,
): Buffer {
  const header = buildHeader(messageType, flags, serialization, compression);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

/** Convenience: build the first config frame (gzipped JSON). */
export function buildClientConfigFrame(config: ClientConfigRequest): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(config), 'utf-8'));
  return buildFrame(
    MessageType.FULL_CLIENT_REQUEST,
    Flags.NO_SEQUENCE,
    Serialization.JSON,
    Compression.GZIP,
    payload,
  );
}

/** Convenience: build one audio chunk frame (gzipped raw bytes). */
export function buildAudioFrame(audio: Buffer, isLast: boolean): Buffer {
  return buildFrame(
    MessageType.AUDIO_ONLY_REQUEST,
    isLast ? Flags.LAST_NO_SEQUENCE : Flags.NO_SEQUENCE,
    Serialization.NONE,
    Compression.GZIP,
    gzipSync(audio),
  );
}

/** Build a server response frame — used by the mock server. */
export function buildServerResponseFrame(
  json: unknown,
  opts: { isLast?: boolean; sequence?: number } = {},
): Buffer {
  const sequence = opts.sequence ?? 1;
  const flags: Flags = opts.isLast ? Flags.SERVER_LAST_SEQUENCE : Flags.SERVER_SEQUENCE;
  const header = buildHeader(MessageType.FULL_SERVER_RESPONSE, flags, Serialization.JSON, Compression.GZIP);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(sequence, 0);
  const payload = gzipSync(Buffer.from(JSON.stringify(json), 'utf-8'));
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, seqBuf, sizeBuf, payload]);
}

/** Build a server error frame — used by the mock server. */
export function buildServerErrorFrame(code: number, message: string): Buffer {
  const header = buildHeader(MessageType.SERVER_ERROR, Flags.NO_SEQUENCE, Serialization.JSON, Compression.NONE);
  const msgBuf = Buffer.from(message, 'utf-8');
  const codeBuf = Buffer.alloc(4);
  codeBuf.writeUInt32BE(code, 0);
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(msgBuf.length, 0);
  return Buffer.concat([header, codeBuf, sizeBuf, msgBuf]);
}

/**
 * Parse a server frame. Returns `null` if the frame is not a JSON transcript
 * (e.g. server-internal heartbeats), throws on SERVER_ERROR.
 */
export interface ParsedServerFrame {
  messageType: MessageType;
  flags: Flags;
  sequence?: number;
  isLast: boolean;
  json: ServerResponse | null;
}

export function parseServerFrame(data: Buffer): ParsedServerFrame {
  if (data.length < 8) {
    throw new Error(`Doubao frame too short: ${data.length} bytes`);
  }
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = ((data[1] >> 4) & 0x0f) as MessageType;
  const flags = (data[1] & 0x0f) as Flags;
  const serialization = ((data[2] >> 4) & 0x0f) as Serialization;
  const compression = (data[2] & 0x0f) as Compression;
  let offset = headerSize;

  const hasSeq = flags === Flags.SERVER_SEQUENCE || flags === Flags.SERVER_LAST_SEQUENCE;
  let sequence: number | undefined;
  if (hasSeq) {
    sequence = data.readUInt32BE(offset);
    offset += 4;
  }

  if (messageType === MessageType.SERVER_ERROR) {
    const code = data.readUInt32BE(offset);
    offset += 4;
    const size = data.readUInt32BE(offset);
    offset += 4;
    const msg = data.subarray(offset, offset + size).toString('utf-8');
    throw new DoubaoServerError(code, msg);
  }

  if (messageType !== MessageType.FULL_SERVER_RESPONSE) {
    return { messageType, flags, sequence, isLast: flags === Flags.SERVER_LAST_SEQUENCE, json: null };
  }

  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  const payload = data.subarray(offset, offset + payloadSize);
  const decoded = compression === Compression.GZIP ? gunzipSync(payload) : payload;

  let json: ServerResponse | null = null;
  if (serialization === Serialization.JSON && decoded.length > 0) {
    json = JSON.parse(decoded.toString('utf-8')) as ServerResponse;
  }
  return {
    messageType,
    flags,
    sequence,
    isLast: flags === Flags.SERVER_LAST_SEQUENCE,
    json,
  };
}

// ─── Typed request/response shapes ───────────────────────────────────────

export interface ClientConfigRequest {
  user: { uid: string };
  audio: {
    /** "pcm" | "ogg" | "wav" — controls how Doubao decodes our bytes. */
    format: 'pcm' | 'ogg' | 'wav';
    /** "raw" for pcm, "opus" for ogg. */
    codec: 'raw' | 'opus';
    rate: 16000 | 8000;
    bits: 16;
    channel: 1;
  };
  request: {
    model_name: 'bigmodel' | 'seedasr';
    /** Two-pass: stream partials, then re-recognize for accuracy at the end. */
    enable_nonstream?: boolean;
    show_utterances?: boolean;
    result_type?: 'full' | 'incremental';
    enable_itn?: boolean;
    enable_punc?: boolean;
    enable_ddc?: boolean;
    /**
     * ms of silence before a segment is finalized (definite:true).
     * Default 800 finalizes too eagerly for dictation; the handover
     * recommends 5000ms. Minimum 200.
     */
    end_window_size?: number;
    /** ms to wait for speech before forcing a result emit. */
    force_to_speech_time?: number;
    [k: string]: unknown;
  };
}

export interface ServerUtterance {
  text: string;
  start_time?: number;
  end_time?: number;
  /** True once the utterance is finalized (no further changes). */
  definite?: boolean;
  /** Word-level breakdown when show_utterances=true. */
  words?: Array<{ text: string; start_time?: number; end_time?: number }>;
}

/**
 * Doubao response shape. Note `result` may be a single object OR an array of
 * candidates — pick the one with the highest `confidence`, do **not**
 * concatenate (causes duplicated text per handover §4).
 */
export interface ServerResponseResult {
  text?: string;
  confidence?: number;
  utterances?: ServerUtterance[];
}

export interface ServerResponse {
  code?: number;
  message?: string;
  result?: ServerResponseResult | ServerResponseResult[];
  audio_info?: { duration?: number };
  reqid?: string;
  sequence?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export class DoubaoServerError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`Doubao ASR error ${code}: ${message}`);
    this.name = 'DoubaoServerError';
    this.code = code;
  }
}

/**
 * Pick the best candidate from a ServerResponse.result (which can be a single
 * object or an array). Returns null when nothing is usable.
 */
export function pickBestCandidate(result: ServerResponse['result']): ServerResponseResult | null {
  if (!result) return null;
  if (Array.isArray(result)) {
    if (result.length === 0) return null;
    let best = result[0];
    for (const r of result) {
      if ((r.confidence ?? 0) > (best.confidence ?? 0)) best = r;
    }
    return best;
  }
  return result;
}

/** Default request body for general-purpose dictation. */
export function defaultClientConfig(uid: string): ClientConfigRequest {
  return {
    user: { uid },
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: 'bigmodel',
      enable_nonstream: true,
      show_utterances: true,
      result_type: 'full',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      end_window_size: 5000,
      force_to_speech_time: 1000,
    },
  };
}

/** Well-known error codes from the Doubao docs (subset). */
export const DOUBAO_ERROR_CODES = {
  SUCCESS: 20_000_000,
  BAD_PARAM: 45_000_001,
  EMPTY_AUDIO: 45_000_002,
  PACKET_WAIT_TIMEOUT: 45_000_081,
  INVALID_AUDIO_FORMAT: 45_000_151,
  SERVER_BUSY: 55_000_031,
} as const;
