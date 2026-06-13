/**
 * Mock Doubao server.
 *
 * Speaks the same binary protocol as real Doubao so our DoubaoClient (and
 * therefore the broker, probe and web client) can be exercised end-to-end
 * before real Volcengine credentials are available.
 *
 * Behavior:
 *   - Accepts a WS upgrade on any path (mimics the real endpoint).
 *   - Verifies headers are present (X-Api-App-Key / X-Api-Access-Key /
 *     X-Api-Resource-Id). If they're missing, returns SERVER_ERROR 45000001
 *     to mimic auth failure.
 *   - On the first FULL_CLIENT_REQUEST, parses the config (validates audio
 *     format + uid).
 *   - For each AUDIO_ONLY_REQUEST chunk, advances through a scripted
 *     transcript ("the quick brown fox..." by default), emitting partial
 *     transcripts every N chunks and a final transcript on LAST frame.
 *
 * NOT a faithful reproduction of every Doubao quirk — just enough to let the
 * client + broker code be wired up and tested. The moment real creds arrive,
 * `DOUBAO_MOCK` is dropped and the same code talks to ByteDance.
 */

import type { IncomingMessage } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  Compression,
  DOUBAO_ERROR_CODES,
  Flags,
  MessageType,
  Serialization,
  type ServerResponse,
  buildServerErrorFrame,
  buildServerResponseFrame,
} from './doubao.js';
import { createLogger, type Logger } from './logger.js';

export interface MockDoubaoOptions {
  port?: number;
  host?: string;
  /**
   * Words that build up over chunks. Each chunk you receive appends one
   * word to the partial transcript. When the LAST frame arrives we emit
   * the joined sentence as definite=true.
   */
  script?: string[];
  /** Emit a partial transcript every N audio chunks. Default: 1 (every chunk). */
  partialEvery?: number;
  /** Reject connections lacking app/access/resource headers. Default true. */
  requireAuthHeaders?: boolean;
  logger?: Logger;
}

export interface MockDoubaoServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

const DEFAULT_SCRIPT = [
  '你好',
  '这是',
  '一段',
  '中英混合',
  '的',
  'dictation',
  'test',
  '把',
  'useState',
  '改成',
  'useReducer',
];

export async function startMockDoubao(opts: MockDoubaoOptions = {}): Promise<MockDoubaoServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  const script = opts.script ?? DEFAULT_SCRIPT;
  const partialEvery = Math.max(1, opts.partialEvery ?? 1);
  const requireAuthHeaders = opts.requireAuthHeaders ?? true;
  const logger = opts.logger ?? createLogger('mock-doubao');

  const http = createServer();
  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const connectId = (req.headers['x-api-connect-id'] as string) ?? 'unknown';
    const appKey = req.headers['x-api-app-key'] as string | undefined;
    const accessKey = req.headers['x-api-access-key'] as string | undefined;
    const resourceId = req.headers['x-api-resource-id'] as string | undefined;

    logger.info('connection', { connectId, appKey: !!appKey, resourceId });

    if (requireAuthHeaders && (!appKey || !accessKey || !resourceId)) {
      ws.send(buildServerErrorFrame(DOUBAO_ERROR_CODES.BAD_PARAM, 'missing auth headers'));
      ws.close(1008, 'auth');
      return;
    }

    let configured = false;
    let chunkCount = 0;
    let seq = 0;

    const sendTranscript = (words: string[], isLast: boolean) => {
      seq += 1;
      const text = joinScript(words);
      const utterance = { text, start_time: 0, end_time: chunkCount * 200, definite: isLast };
      const resp: ServerResponse = {
        code: DOUBAO_ERROR_CODES.SUCCESS,
        reqid: connectId,
        sequence: seq,
        result: { text, confidence: 0.95, utterances: [utterance] },
      };
      ws.send(buildServerResponseFrame(resp, { isLast, sequence: seq }));
    };

    ws.on('message', (data: Buffer) => {
      let header: { messageType: number; flags: number; serialization: number; compression: number; payload: Buffer };
      try {
        header = parseClientFrame(data);
      } catch (err) {
        logger.warn('bad frame', { error: (err as Error).message });
        ws.send(buildServerErrorFrame(DOUBAO_ERROR_CODES.BAD_PARAM, (err as Error).message));
        return;
      }

      if (header.messageType === MessageType.FULL_CLIENT_REQUEST) {
        if (configured) {
          ws.send(buildServerErrorFrame(DOUBAO_ERROR_CODES.BAD_PARAM, 'config sent twice'));
          return;
        }
        try {
          const json = JSON.parse(header.payload.toString('utf-8'));
          logger.debug('config received', { uid: json?.user?.uid, format: json?.audio?.format });
        } catch (err) {
          ws.send(buildServerErrorFrame(DOUBAO_ERROR_CODES.BAD_PARAM, `bad config json: ${(err as Error).message}`));
          return;
        }
        configured = true;
        return;
      }

      if (header.messageType === MessageType.AUDIO_ONLY_REQUEST) {
        if (!configured) {
          ws.send(buildServerErrorFrame(DOUBAO_ERROR_CODES.BAD_PARAM, 'audio before config'));
          return;
        }
        const isLast = header.flags === Flags.LAST_NO_SEQUENCE;
        if (isLast) {
          // Full sentence as final.
          sendTranscript(script, true);
          return;
        }
        if (header.payload.length === 0) return;
        chunkCount += 1;
        if (chunkCount % partialEvery === 0) {
          const wordsSoFar = script.slice(0, Math.min(script.length, Math.ceil(chunkCount / 2)));
          sendTranscript(wordsSoFar, false);
        }
        return;
      }

      logger.warn('unexpected message type', { type: header.messageType });
    });

    ws.on('close', () => logger.debug('connection closed', { connectId, chunkCount }));
  });

  await new Promise<void>((resolve) => http.listen(port, host, () => resolve()));
  const addr = http.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `ws://${host}:${boundPort}/api/v3/sauc/bigmodel`;
  logger.info('listening', { url });

  return {
    port: boundPort,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          http.close((err2) => (err2 ? reject(err2) : resolve()));
        });
      }),
  };
}

// ─── helpers ───────────────────────────────────────────────────────────────

interface ParsedClientFrame {
  messageType: number;
  flags: number;
  serialization: number;
  compression: number;
  payload: Buffer;
}

function parseClientFrame(data: Buffer): ParsedClientFrame {
  if (data.length < 8) throw new Error(`client frame too short: ${data.length}`);
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = (data[1] >> 4) & 0x0f;
  const flags = data[1] & 0x0f;
  const serialization = (data[2] >> 4) & 0x0f;
  const compression = data[2] & 0x0f;
  let offset = headerSize;
  // Client frames never carry a sequence number.
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  const raw = data.subarray(offset, offset + payloadSize);
  const payload = compression === Compression.GZIP && raw.length > 0 ? gunzipSync(raw) : raw;
  // For server-side correctness checks
  void Serialization.JSON;
  return { messageType, flags, serialization, compression, payload };
}

function joinScript(words: string[]): string {
  // Join CJK without space, Latin with space, roughly.
  let out = '';
  for (const w of words) {
    if (out === '') {
      out = w;
      continue;
    }
    const lastChar = out.charCodeAt(out.length - 1);
    const firstChar = w.charCodeAt(0);
    const lastIsCJK = lastChar >= 0x4e00 && lastChar <= 0x9fff;
    const firstIsCJK = firstChar >= 0x4e00 && firstChar <= 0x9fff;
    out += lastIsCJK || firstIsCJK ? w : ` ${w}`;
  }
  return out;
}
