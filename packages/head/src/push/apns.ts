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
}

export class ApnsProvider implements PushProvider {
  readonly name = 'apns';

  private readonly key: string;
  private readonly keyId: string;
  private readonly teamId: string;
  private readonly defaultBundleId: string;
  private readonly defaultEnvironment: 'production' | 'sandbox';

  private sessions = new Map<string, http2.ClientHttp2Session>();
  private jwt: { token: string; issuedAt: number } | null = null;

  constructor(config: ApnsConfig) {
    this.key = readFileSync(config.keyPath, 'utf8');
    this.keyId = config.keyId;
    this.teamId = config.teamId;
    this.defaultBundleId = config.bundleId;
    this.defaultEnvironment = config.environment ?? 'production';
  }

  async send(token: string, payload: PushPayload, opts?: {
    environment?: string;
    bundleId?: string;
  }): Promise<PushResult> {
    const logger = getLogger();
    const env = (opts?.environment ?? this.defaultEnvironment) as 'production' | 'sandbox';
    const bundleId = opts?.bundleId ?? this.defaultBundleId;
    const host = env === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

    const apnsPayload = JSON.stringify({
      aps: {
        alert: { title: 'Kraki', body: 'Needs your attention' },
        'mutable-content': 1,
      },
      kraki: {
        blob: payload.blob,
        key: payload.key,
      },
    });

    // Check 4KB APNs limit
    if (Buffer.byteLength(apnsPayload) > 4096) {
      logger.warn('APNs payload exceeds 4KB, sending without preview', { tokenSuffix: token.slice(-8) });
      // Fall back to opaque notification without preview data
      const fallback = JSON.stringify({
        aps: {
          alert: { title: 'Kraki', body: 'Needs your attention' },
        },
      });
      return this.sendRaw(host, token, bundleId, fallback);
    }

    return this.sendRaw(host, token, bundleId, apnsPayload);
  }

  private async sendRaw(host: string, token: string, bundleId: string, body: string): Promise<PushResult> {
    const logger = getLogger();
    const jwt = this.getJwt();
    const session = this.getSession(host);

    return new Promise<PushResult>((resolve) => {
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

      req.on('response', (headers) => {
        statusCode = headers[':status'] as number;
      });

      req.on('data', (chunk: Buffer) => {
        responseData += chunk.toString();
      });

      req.on('end', () => {
        if (statusCode === 200) {
          resolve({ success: true });
        } else if (statusCode === 410) {
          logger.info('APNs token gone (410), marking for removal', { tokenSuffix: token.slice(-8) });
          resolve({ success: false, gone: true, error: 'Token no longer valid' });
        } else {
          let errorReason = `HTTP ${statusCode}`;
          try {
            const parsed = JSON.parse(responseData);
            if (parsed.reason) errorReason = parsed.reason;
          } catch { /* ignore parse errors */ }
          logger.warn('APNs send failed', { status: statusCode, reason: errorReason, tokenSuffix: token.slice(-8) });
          resolve({ success: false, error: errorReason });
        }
      });

      req.on('error', (err) => {
        logger.error('APNs request error', { error: (err as Error).message, tokenSuffix: token.slice(-8) });
        resolve({ success: false, error: (err as Error).message });
      });

      req.end(body);
    });
  }

  private getSession(host: string): http2.ClientHttp2Session {
    let session = this.sessions.get(host);
    if (session && !session.destroyed && !session.closed) return session;

    session = http2.connect(`https://${host}`);
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
    const signature = signer.sign(this.key, 'base64url');

    const token = `${header}.${payload}.${signature}`;
    this.jwt = { token, issuedAt: now };
    return token;
  }

  close(): void {
    for (const session of this.sessions.values()) {
      try { session.close(); } catch { /* best effort */ }
    }
    this.sessions.clear();
  }
}
