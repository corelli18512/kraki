// ------------------------------------------------------------
// APNs push provider — HTTP/2 + JWT
// ------------------------------------------------------------

import { createSign } from 'node:crypto';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { getLogger } from '../logger.js';
import type { PushPayload, PushProvider, PushResult } from './provider.js';

const APNS_HOST_PRODUCTION = 'api.push.apple.com';
const APNS_HOST_SANDBOX = 'api.sandbox.push.apple.com';
const JWT_ALGORITHM = 'ES256';
const JWT_TTL_MS = 50 * 60 * 1000; // Refresh JWT every 50 minutes (APNs requires < 1 hour)

/** Errors that indicate a dead/stale TCP connection — worth retrying with a fresh session. */
export function isConnectionError(error: string | undefined): boolean {
  if (!error) return false;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|GOAWAY|socket hang up/i.test(error);
}

/** APNs reasons meaning this token will never work for this topic again.
 *  Retrying them on every push only burns requests; drop the token and let
 *  the device re-register on its next connection. */
const PERMANENT_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
export function isPermanentTokenFailure(reason: string | undefined): boolean {
  return !!reason && PERMANENT_TOKEN_REASONS.has(reason);
}

/** An APNs request that has not answered within this time is abandoned. */
const APNS_REQUEST_TIMEOUT_MS = 10_000;

export function buildApnsPayload(payload?: PushPayload): string {
  return JSON.stringify({
    aps: {
      alert: { title: 'Kraki', body: 'Open Kraki to view the update.' },
      sound: 'default',
      badge: 1,
      ...(payload ? { 'mutable-content': 1 } : {}),
    },
    ...(payload ? { kraki: { blob: payload.blob, key: payload.key } } : {}),
  });
}

/** Opens the HTTP/2 session to an APNs host (tests substitute their own). */
export type ApnsConnect = (authority: string) => http2.ClientHttp2Session;

export interface ApnsConfig {
  /** Path to the .p8 private key file */
  keyPath: string;
  /** Key ID from Apple Developer */
  keyId: string;
  /** Team ID from Apple Developer */
  teamId: string;
  /** Default bundle ID (APNs topic) */
  bundleId: string;
  /** Default environment */
  environment?: 'production' | 'sandbox';
  connect?: ApnsConnect;
}

export class ApnsProvider implements PushProvider {
  readonly name = 'apns';

  private readonly key: string;
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly defaultBundleId: string;
  private readonly defaultEnvironment: 'production' | 'sandbox';

  private sessions = new Map<string, http2.ClientHttp2Session>();
  private readonly connect: ApnsConnect;
  private jwt: { token: string; issuedAt: number } | null = null;

  constructor(config: ApnsConfig) {
    this.key = readFileSync(config.keyPath, 'utf8');
    this.keyId = config.keyId;
    this.teamId = config.teamId;
    this.defaultBundleId = config.bundleId;
    this.defaultEnvironment = config.environment ?? 'production';
    this.connect = config.connect ?? ((authority) => http2.connect(authority));
  }

  async send(token: string, payload: PushPayload, opts?: {
    environment?: string;
    bundleId?: string;
  }): Promise<PushResult> {
    const logger = getLogger();
    const env = (opts?.environment ?? this.defaultEnvironment) as 'production' | 'sandbox';
    const bundleId = opts?.bundleId ?? this.defaultBundleId;
    const host = env === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

    const apnsPayload = buildApnsPayload(payload);

    // Check 4KB APNs limit
    if (Buffer.byteLength(apnsPayload) > 4096) {
      logger.warn('APNs payload exceeds 4KB, sending without preview', { tokenSuffix: token.slice(-8) });
      // Fall back to opaque notification without preview data
      const fallback = buildApnsPayload();
      return this.sendRaw(host, token, bundleId, fallback);
    }

    return this.sendRaw(host, token, bundleId, apnsPayload);
  }

  private async sendRaw(host: string, token: string, bundleId: string, body: string): Promise<PushResult> {
    const logger = getLogger();
    // The session this attempt uses (opened now if there is none yet).
    const sessionBefore = this.getSession(host);
    const result = await this.attemptSend(host, token, bundleId, body);

    // Retry once on connection-level errors (stale session after idle: an
    // expected event, not a failure unless the retry fails too).
    // Only destroy if the session hasn't already been replaced by a concurrent retry.
    if (!result.success && isConnectionError(result.error)) {
      logger.info('APNs connection error, retrying with fresh session', { error: result.error, tokenSuffix: token.slice(-8) });
      if (this.sessions.get(host) === sessionBefore) {
        this.destroySession(host);
      }
      const startedAt = performance.now();
      const retry = await this.attemptSend(host, token, bundleId, body);
      const ms = Math.round(performance.now() - startedAt);
      if (retry.success) logger.info('APNs retry succeeded', { tokenSuffix: token.slice(-8), ms, apnsId: retry.id });
      else logger.warn('APNs retry failed', { tokenSuffix: token.slice(-8), ms, error: retry.error });
      return { ...retry, retried: true };
    }

    return result;
  }

  private attemptSend(host: string, token: string, bundleId: string, body: string): Promise<PushResult> {
    const logger = getLogger();
    const jwt = this.getJwt();
    const session = this.getSession(host);

    return new Promise<PushResult>((resolveOnce) => {
      let settled = false;
      const resolve = (result: PushResult) => {
        if (settled) return;
        settled = true;
        resolveOnce(result);
      };
      const req = session.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        'authorization': `bearer ${jwt}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });

      let responseData = '';
      let statusCode = 0;
      let apnsId: string | undefined;

      req.on('response', (headers) => {
        statusCode = headers[':status'] as number;
        const id = headers['apns-id'];
        if (typeof id === 'string') apnsId = id;
      });

      req.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      req.on('end', () => {
        if (statusCode === 200) {
          resolve({ success: true, ...(apnsId && { id: apnsId }) });
        } else if (statusCode === 410) {
          logger.info('APNs token gone (410), marking for removal', { tokenSuffix: token.slice(-8) });
          resolve({ success: false, gone: true, error: 'Token no longer valid' });
        } else {
          let errorReason = `HTTP ${statusCode}`;
          try {
            const parsed = JSON.parse(responseData);
            if (parsed.reason) errorReason = parsed.reason;
          } catch { /* ignore parse errors */ }
          if (errorReason === 'ExpiredProviderToken' || errorReason === 'InvalidProviderToken') {
            // Our signing token, not the device token: mint a fresh JWT next time.
            this.jwt = null;
          }
          if (isPermanentTokenFailure(errorReason)) {
            logger.info('APNs token rejected, marking for removal', { status: statusCode, reason: errorReason, tokenSuffix: token.slice(-8) });
            resolve({ success: false, gone: true, error: errorReason });
            return;
          }
          logger.warn('APNs send failed', { status: statusCode, reason: errorReason, tokenSuffix: token.slice(-8) });
          resolve({ success: false, error: errorReason });
        }
      });

      req.on('error', (err) => {
        const error = (err as Error).message;
        // A connection error is retried (and its outcome logged) by sendRaw.
        if (isConnectionError(error)) logger.debug('APNs request error', { error, tokenSuffix: token.slice(-8) });
        else logger.warn('APNs request error', { error, tokenSuffix: token.slice(-8) });
        resolve({ success: false, error });
      });

      req.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        logger.warn('APNs request timed out', { tokenSuffix: token.slice(-8) });
        req.close(http2.constants.NGHTTP2_CANCEL);
        resolve({ success: false, error: 'timeout' });
      });

      req.end(body);
    });
  }

  private destroySession(host: string): void {
    const session = this.sessions.get(host);
    if (session) {
      try { session.destroy(); } catch { /* best effort */ }
      this.sessions.delete(host);
    }
  }

  private getSession(host: string): http2.ClientHttp2Session {
    let session = this.sessions.get(host);
    if (session && !session.destroyed && !session.closed) return session;

    session = this.connect(`https://${host}`);
    session.on('error', () => {
      this.sessions.delete(host);
    });
    session.on('close', () => {
      this.sessions.delete(host);
    });
    this.sessions.set(host, session);
    return session;
  }

  private getJwt(): string {
    const now = Date.now();
    if (this.jwt && now - this.jwt.issuedAt < JWT_TTL_MS) {
      return this.jwt.token;
    }

    const issuedAt = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: JWT_ALGORITHM, kid: this.keyId })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: this.teamId, iat: issuedAt })).toString('base64url');

    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    // JWS ES256 wants the raw r||s signature, not Node's default DER encoding.
    const signature = signer.sign({ key: this.key, dsaEncoding: 'ieee-p1363' }, 'base64url');

    const token = `${header}.${payload}.${signature}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  close(): void {
    for (const host of this.sessions.keys()) {
      this.destroySession(host);
    }
  }
}
