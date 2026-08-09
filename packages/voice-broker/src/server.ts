/**
 * Standalone Kraki voice broker used by local development and direct Doubao
 * tests. Production uses the matching @coinfra/voice gateway adapter.
 *
 * A signed lease authorizes the WebSocket once; the connection then carries
 * many sequential start / binary PCM / finish cycles.
 */

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { DoubaoClient } from './doubao-client.js';
import type { ClientConfigRequest } from './doubao.js';
import { createLogger, type Logger } from './logger.js';
import { verifyLease, type VerifyReason } from './lease-verifier.js';
import type { VoiceLease, VoiceResource } from '@kraki/protocol';

export interface BrokerOptions {
  port?: number;
  host?: string;
  doubaoEndpoint: string;
  doubaoAppKey?: string;
  doubaoAccessKey: string;
  doubaoResourceId: string;
  logger?: Logger;
  path?: string;
  leasePublicKeyPem?: string;
  devNoAuth?: boolean;
  resource?: VoiceResource;
  sampleRateHz?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  expiryGraceSeconds?: number;
}

export interface BrokerServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface ClientAuthorizeMessage {
  type: 'authorize';
  uid?: string;
  deviceId?: string;
  authorization?: VoiceLease;
}

interface ClientStartMessage {
  type: 'start';
  uid?: string;
  deviceId?: string;
  config?: Partial<ClientConfigRequest>;
}

interface ClientFinishMessage {
  type: 'finish';
}

type ClientControlMessage = ClientAuthorizeMessage | ClientStartMessage | ClientFinishMessage;

interface ConnectionOwner {
  replace(): void;
  audioBytes(): number;
}

function closeCodeFor(_reason: VerifyReason | 'missing_lease' | 'no_pubkey' | 'quota_exhausted'): number {
  return 1008;
}

export async function startBroker(opts: BrokerOptions): Promise<BrokerServer> {
  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/voice';
  const logger = opts.logger ?? createLogger('broker');
  const expectedResource: VoiceResource = opts.resource ?? 'voice/doubao';
  const sampleRateHz = opts.sampleRateHz ?? 16000;
  const bytesPerSecond = sampleRateHz * 2;
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
  const expiryGraceSeconds = opts.expiryGraceSeconds ?? 60;

  if (opts.devNoAuth && opts.leasePublicKeyPem) {
    throw new Error(
      'voice-broker refusing to start: both devNoAuth=true and leasePublicKeyPem are set. ' +
      'Pick one — devNoAuth disables auth entirely (local dev only).',
    );
  }
  if (!opts.devNoAuth && !opts.leasePublicKeyPem) {
    throw new Error(
      'voice-broker refusing to start: no leasePublicKeyPem configured and devNoAuth!=true. ' +
      'Set BROKER_LEASE_PUBLIC_KEY_PEM (or _PATH) to the head\'s public key, or BROKER_DEV_NO_AUTH=1 for local dev.',
    );
  }
  if (opts.devNoAuth) {
    logger.warn('!! BROKER_DEV_NO_AUTH=1 — lease verification disabled, anyone reachable can use this broker !!');
  } else {
    logger.info('lease verification enabled', { resource: expectedResource });
  }

  const http = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'voice-broker' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http, path });
  const owners = new Map<string, ConnectionOwner>();
  const pongTimeouts = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  const closeConnections = new Set<() => void>();

  const pingTimer = pingIntervalMs > 0
    ? setInterval(() => {
        for (const ws of wss.clients) {
          const previousTimeout = pongTimeouts.get(ws);
          if (previousTimeout) {
            clearTimeout(previousTimeout);
            pongTimeouts.delete(ws);
            ws.terminate();
            continue;
          }
          try {
            ws.ping();
            const timeout = setTimeout(() => {
              pongTimeouts.delete(ws);
              ws.terminate();
            }, Math.max(1, pongTimeoutMs));
            timeout.unref();
            pongTimeouts.set(ws, timeout);
          } catch {
            ws.terminate();
          }
        }
      }, pingIntervalMs)
    : null;
  pingTimer?.unref();

  wss.on('connection', (ws: WebSocket, req) => {
    const remote = req.socket.remoteAddress ?? 'unknown';
    const clientLog = logger.child(`c:${remote}`);
    clientLog.info('client connected');
    ws.on('pong', () => {
      const timeout = pongTimeouts.get(ws);
      if (timeout) clearTimeout(timeout);
      pongTimeouts.delete(ws);
    });

    let doubao: DoubaoClient | null = null;
    let recordingToken = 0;
    let started = false;
    let finishing = false;
    let doubaoReady = false;
    let sessionFinal = false;
    const audioBuffer: Buffer[] = [];
    let closed = false;
    let authorized = opts.devNoAuth === true;
    let quotaSeconds = Number.POSITIVE_INFINITY;
    let bytesConsumed = 0;
    let leaseJti: string | undefined;
    let leaseExp: number | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;

    const sendJson = (obj: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try { ws.send(JSON.stringify(obj)); } catch (err) {
        clientLog.warn('send failed', { error: (err as Error).message });
      }
    };

    const closeDoubao = () => {
      const client = doubao;
      doubao = null;
      doubaoReady = false;
      try { client?.close(); } catch { /* ignore */ }
    };

    const resetRecording = () => {
      closeDoubao();
      started = false;
      finishing = false;
      sessionFinal = false;
      audioBuffer.length = 0;
    };

    const closeAll = (code = 1000, reason = 'done') => {
      if (closed) return;
      closed = true;
      expiryTimer && clearTimeout(expiryTimer);
      expiryTimer = null;
      try { doubao?.finish(); } catch { /* ignore */ }
      closeDoubao();
      if (leaseJti && owners.get(leaseJti) === connectionOwner) owners.delete(leaseJti);
      try { ws.close(code, reason); } catch { /* ignore */ }
    };

    const connectionOwner: ConnectionOwner = {
      replace: () => {
        sendJson({ type: 'session_denied', reason: 'connection_replaced' });
        closeAll(4001, 'connection_replaced');
      },
      audioBytes: () => bytesConsumed,
    };

    const deny = (reason: string, detail?: string) => {
      sendJson({ type: 'session_denied', reason, detail });
      closeAll(1008, reason);
    };

    const scheduleExpiry = () => {
      if (leaseExp === undefined) return;
      const delayMs = Math.max(0, (leaseExp + expiryGraceSeconds - Date.now() / 1000) * 1000);
      expiryTimer = setTimeout(() => closeAll(1008, 'authorization_expired'), delayMs);
      expiryTimer.unref?.();
    };

    const startRecording = async (msg: ClientStartMessage) => {
      if (!authorized) {
        deny('missing_lease', 'authorize the connection before start');
        return;
      }
      if (started) {
        sendJson({ type: 'error', message: 'recording already active' });
        return;
      }
      if (leaseExp !== undefined && Date.now() / 1000 >= leaseExp) {
        deny('expired', 'lease expired');
        return;
      }

      started = true;
      finishing = false;
      sessionFinal = false;
      doubaoReady = false;
      audioBuffer.length = 0;
      recordingToken += 1;
      const token = recordingToken;
      const client = new DoubaoClient({
        appKey: opts.doubaoAppKey || undefined,
        accessKey: opts.doubaoAccessKey,
        resourceId: opts.doubaoResourceId,
        endpoint: opts.doubaoEndpoint,
        logger: clientLog.child('doubao'),
      });
      doubao = client;
      client.on('transcript', (u) => {
        if (token !== recordingToken || closed) return;
        sendJson({
          type: 'transcript',
          text: u.text,
          finalSegment: u.finalSegment,
          sessionFinal: u.sessionFinal,
          raw: u.raw,
        });
        if (u.sessionFinal) {
          sessionFinal = true;
          resetRecording();
        }
      });
      client.on('error', (err) => {
        if (token !== recordingToken || sessionFinal) return;
        sendJson({ type: 'error', message: err.message });
        resetRecording();
      });
      client.on('close', (code, reason) => {
        if (token !== recordingToken) return;
        sendJson({ type: 'closed', code, reason });
        if (!sessionFinal && started) resetRecording();
      });

      try {
        await client.connect();
        if (token !== recordingToken || closed) {
          client.close();
          return;
        }
        client.start({ uid: msg.uid, ...msg.config });
        doubaoReady = true;
        for (const chunk of audioBuffer) client.sendAudio(chunk);
        audioBuffer.length = 0;
        sendJson({ type: 'ready' });
        if (finishing) client.finish();
      } catch (err) {
        sendJson({ type: 'error', message: `doubao connect failed: ${(err as Error).message}` });
        resetRecording();
      }
    };

    ws.on('message', async (data: RawData, isBinary: boolean) => {
      if (closed) return;
      if (isBinary) {
        if (!started || finishing) {
          sendJson({ type: 'error', message: !started ? 'audio sent before start' : 'audio sent after finish' });
          return;
        }
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const prospectiveBytes = bytesConsumed + chunk.length;
        if (prospectiveBytes / bytesPerSecond > quotaSeconds) {
          clientLog.info('lease quota exhausted mid-stream', {
            jti: leaseJti,
            usedSec: (bytesConsumed / bytesPerSecond).toFixed(1),
            quotaSec: quotaSeconds,
          });
          deny('quota_exhausted', 'lease seconds exhausted');
          return;
        }
        bytesConsumed = prospectiveBytes;
        if (!doubaoReady || !doubao) audioBuffer.push(chunk);
        else {
          try { doubao.sendAudio(chunk); } catch (err) {
            sendJson({ type: 'error', message: (err as Error).message });
            resetRecording();
          }
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

      if (msg.type === 'authorize') {
        if (opts.devNoAuth) {
          authorized = true;
          sendJson({ type: 'authorized' });
          return;
        }
        if (authorized || started) {
          deny('already_authorized');
          return;
        }
        if (!opts.leasePublicKeyPem) {
          deny('no_pubkey', 'broker misconfigured');
          return;
        }
        if (!msg.authorization) {
          deny('missing_lease', 'missing authorization lease');
          return;
        }
        const deviceId = msg.deviceId ?? msg.authorization.payload.did;
        const result = verifyLease(msg.authorization, opts.leasePublicKeyPem, {
          resource: expectedResource,
          deviceId,
        });
        if (!result.ok) {
          deny(result.reason, result.detail);
          return;
        }
        if (msg.uid !== undefined && msg.uid !== result.payload.sub) {
          deny('wrong_user', 'lease does not match user');
          return;
        }
        authorized = true;
        quotaSeconds = result.payload.quota_seconds;
        leaseJti = result.payload.jti;
        leaseExp = result.payload.exp;
        const previous = owners.get(leaseJti);
        if (previous && previous !== connectionOwner) {
          bytesConsumed = Math.max(bytesConsumed, previous.audioBytes());
        }
        owners.set(leaseJti, connectionOwner);
        if (previous && previous !== connectionOwner) previous.replace();
        scheduleExpiry();
        sendJson({ type: 'authorized' });
        return;
      }

      if (msg.type === 'start') {
        await startRecording(msg);
        return;
      }

      if (msg.type === 'finish') {
        if (!started || finishing) return;
        finishing = true;
        if (doubaoReady) {
          try { doubao?.finish(); } catch (err) {
            sendJson({ type: 'error', message: (err as Error).message });
          }
        }
        return;
      }

      sendJson({ type: 'error', message: `unknown control type: ${(msg as { type: string }).type}` });
    });

    const closeForShutdown = () => closeAll(1001, 'server_shutdown');
    closeConnections.add(closeForShutdown);
    ws.on('close', (code, reason) => {
      closeConnections.delete(closeForShutdown);
      const pongTimeout = pongTimeouts.get(ws);
      if (pongTimeout) clearTimeout(pongTimeout);
      pongTimeouts.delete(ws);
      expiryTimer && clearTimeout(expiryTimer);
      if (leaseJti && owners.get(leaseJti) === connectionOwner) owners.delete(leaseJti);
      clientLog.info('client disconnected', { code, reason: reason?.toString('utf-8') });
      if (!closed) {
        closed = true;
        closeDoubao();
      }
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
    close: () => new Promise<void>((resolve, reject) => {
      pingTimer && clearInterval(pingTimer);
      for (const timeout of pongTimeouts.values()) clearTimeout(timeout);
      pongTimeouts.clear();
      for (const closeConnection of [...closeConnections]) closeConnection();
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
