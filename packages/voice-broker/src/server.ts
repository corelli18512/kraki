/**
 * Broker WSS server (Phase 1).
 *
 * arm clients connect here. Per connection lifecycle:
 *
 *   ws.send({type:"start", uid?, config?})           — open a Doubao session
 *   ws.send(<binary chunk>)                          — raw PCM (16k mono int16)
 *   ws.send({type:"finish"})                         — stop dictating
 *
 * The broker replies with control + transcript messages, all JSON:
 *
 *   {type:"ready"}                                   — Doubao session live
 *   {type:"transcript", text, finalSegment, sessionFinal, raw}
 *   {type:"error", message, code?}
 *   {type:"closed", code, reason}                    — Doubao closed
 *
 * Note: NO auth in this phase. That's deliberate — handover §5 says auth is
 * post-MVP. When the lease layer is added it will sit in front of `start`,
 * verifying the lease signature with core's public key (offline).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { DoubaoClient } from './doubao-client.js';
import type { ClientConfigRequest } from './doubao.js';
import { createLogger, type Logger } from './logger.js';

export interface BrokerOptions {
  port?: number;
  host?: string;
  /** Doubao endpoint (real or mock). */
  doubaoEndpoint: string;
  /** Optional — only needed for the legacy "old console" auth scheme. */
  doubaoAppKey?: string;
  doubaoAccessKey: string;
  doubaoResourceId: string;
  logger?: Logger;
  /** Optional path the WSS listens on. Defaults to "/voice". */
  path?: string;
}

export interface BrokerServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ClientStartMessage {
  type: 'start';
  uid?: string;
  config?: Partial<ClientConfigRequest>;
}
interface ClientFinishMessage {
  type: 'finish';
}
type ClientControlMessage = ClientStartMessage | ClientFinishMessage;

export async function startBroker(opts: BrokerOptions): Promise<BrokerServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/voice';
  const logger = opts.logger ?? createLogger('broker');

  const http = createServer((req, res) => {
    // Tiny health endpoint for ops.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'voice-broker' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http, path });

  wss.on('connection', (ws: WebSocket, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const clientLog = logger.child(`c:${remote}`);
    clientLog.info('client connected');

    let doubao: DoubaoClient | null = null;
    let started = false;          // arm client has sent {type:'start'}
    let doubaoReady = false;      // doubao WS is open AND start frame sent
    const audioBuffer: Buffer[] = []; // chunks that arrived before doubao was ready
    let closed = false;

    const sendJson = (obj: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(obj));
      } catch (err) {
        clientLog.warn('send failed', { error: (err as Error).message });
      }
    };

    const closeAll = (code = 1000, reason = 'done') => {
      if (closed) return;
      closed = true;
      try {
        doubao?.finish();
      } catch {
        // ignore
      }
      setTimeout(() => doubao?.close(), 500);
      try {
        ws.close(code, reason);
      } catch {
        // ignore
      }
    };

    ws.on('message', async (data: RawData, isBinary: boolean) => {
      if (closed) return;
      if (isBinary) {
        if (!started) {
          sendJson({ type: 'error', message: 'audio sent before start' });
          return;
        }
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        // Doubao might still be handshaking — buffer until ready, then flush.
        if (!doubaoReady || !doubao) {
          audioBuffer.push(chunk);
          return;
        }
        try {
          doubao.sendAudio(chunk);
        } catch (err) {
          sendJson({ type: 'error', message: (err as Error).message });
          closeAll(1011, 'doubao send failed');
        }
        return;
      }

      let msg: ClientControlMessage;
      try {
        const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data);
        msg = JSON.parse(text) as ClientControlMessage;
      } catch (err) {
        sendJson({ type: 'error', message: `bad control json: ${(err as Error).message}` });
        return;
      }

      if (msg.type === 'start') {
        if (started) {
          sendJson({ type: 'error', message: 'already started' });
          return;
        }
        started = true;
        doubao = new DoubaoClient({
          appKey: opts.doubaoAppKey || undefined,
          accessKey: opts.doubaoAccessKey,
          resourceId: opts.doubaoResourceId,
          endpoint: opts.doubaoEndpoint,
          logger: clientLog.child('doubao'),
        });
        doubao.on('transcript', (u) => {
          sendJson({
            type: 'transcript',
            text: u.text,
            finalSegment: u.finalSegment,
            sessionFinal: u.sessionFinal,
            raw: u.raw,
          });
        });
        doubao.on('error', (err) => {
          sendJson({ type: 'error', message: err.message });
          closeAll(1011, 'doubao error');
        });
        doubao.on('close', (code, reason) => {
          sendJson({ type: 'closed', code, reason });
          closeAll(1000, 'doubao closed');
        });

        try {
          await doubao.connect();
          doubao.start({ uid: msg.uid, ...msg.config });
          doubaoReady = true;
          // Flush any audio chunks that arrived during the handshake.
          if (audioBuffer.length > 0) {
            clientLog.debug('flushing buffered audio', { chunks: audioBuffer.length });
            for (const chunk of audioBuffer) {
              try {
                doubao.sendAudio(chunk);
              } catch (err) {
                sendJson({ type: 'error', message: (err as Error).message });
                closeAll(1011, 'doubao send failed');
                return;
              }
            }
            audioBuffer.length = 0;
          }
          sendJson({ type: 'ready' });
        } catch (err) {
          sendJson({ type: 'error', message: `doubao connect failed: ${(err as Error).message}` });
          closeAll(1011, 'doubao connect failed');
        }
        return;
      }

      if (msg.type === 'finish') {
        // If we're mid-handshake, wait for it to complete (the buffered audio
        // will be flushed first by the start handler) then finish.
        const tryFinish = () => {
          try {
            doubao?.finish();
          } catch (err) {
            sendJson({ type: 'error', message: (err as Error).message });
          }
        };
        if (doubaoReady) tryFinish();
        else {
          // Defer until ready; cheap poll because handshake completes in <1s.
          const t = setInterval(() => {
            if (closed) {
              clearInterval(t);
              return;
            }
            if (doubaoReady) {
              clearInterval(t);
              tryFinish();
            }
          }, 50);
          // Safety timeout.
          setTimeout(() => clearInterval(t), 10_000);
        }
        return;
      }

      sendJson({ type: 'error', message: `unknown control type: ${(msg as { type: string }).type}` });
    });

    ws.on('close', (code, reason) => {
      clientLog.info('client disconnected', { code, reason: reason?.toString('utf-8') });
      closeAll(code, reason?.toString('utf-8') ?? '');
    });
    ws.on('error', (err) => clientLog.warn('client error', { error: err.message }));
  });

  await new Promise<void>((resolve) => http.listen(port, host, () => resolve()));
  const addr = http.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `ws://${host}:${boundPort}${path}`;
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
