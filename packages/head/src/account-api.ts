/**
 * Account API — REST endpoints for auth delegation.
 *
 * Exposed by head in standalone mode so other (remote) heads can delegate
 * auth to this instance. Handles: auth, challenge-response, pairing, config.
 *
 * Secured with a service API key (SERVICE_KEY / --service-key).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { LocalAuthBackend } from './local-auth-backend.js';
import { safeEqual } from './auth.js';
import { getLogger } from './logger.js';

export interface AccountApiOptions {
  authBackend: LocalAuthBackend;
  serviceKey?: string;
}

export class AccountApi {
  private backend: LocalAuthBackend;
  private serviceKey?: string;

  constructor(options: AccountApiOptions) {
    this.backend = options.authBackend;
    this.serviceKey = options.serviceKey;
  }

  /**
   * Handle an HTTP request if it matches an account API route.
   * Returns true if the request was handled, false otherwise.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return false;

    // CORS for all API routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    const publicRoute =
      (path === '/api/regions' && req.method === 'GET')
      || (path === '/api/login/resolve' && req.method === 'POST')
      || (path === '/api/edge/join' && req.method === 'POST');

    if (!publicRoute && !this.checkServiceKey(req, res)) return true;

    try {
      switch (path) {
        case '/api/regions':
          if (req.method === 'GET') return this.handleGetRegions(req, res);
          break;
        case '/api/login/resolve':
          if (req.method === 'POST') return await this.handleResolveLogin(req, res);
          break;
        case '/api/auth':
          if (req.method === 'POST') return await this.handleAuth(req, res);
          break;
        case '/api/auth/challenge':
          if (req.method === 'POST') return await this.handleChallenge(req, res);
          break;
        case '/api/auth/verify':
          if (req.method === 'POST') return await this.handleVerify(req, res);
          break;
        case '/api/pairing/create':
          if (req.method === 'POST') return await this.handleCreatePairing(req, res);
          break;
        case '/api/pairing/request':
          if (req.method === 'POST') return await this.handleRequestPairing(req, res);
          break;
        case '/api/config':
          if (req.method === 'GET') return this.handleGetConfig(req, res);
          break;
        case '/api/edge/join':
          if (req.method === 'POST') return await this.handleEdgeJoin(req, res);
          break;
      }
    } catch (err) {
      getLogger().error('Account API error', { path, error: (err as Error).message });
      this.json(res, 500, { ok: false, code: 'internal_error', message: 'Internal server error' });
      return true;
    }

    return false;
  }

  // ── Route handlers ────────────────────────────────────

  private handleGetRegions(_req: IncomingMessage, res: ServerResponse): boolean {
    this.json(res, 200, {
      version: this.backend.getRegionVersion(),
      ttlSec: 300,
      regions: this.backend.getRegions(),
    });
    return true;
  }

  private async handleResolveLogin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.auth) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'auth is required' });
      return true;
    }

    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0].trim()
      ?? req.socket?.remoteAddress;

    const result = await this.backend.resolveLogin(
      body.auth as import('@kraki/protocol').AuthMethod,
      body.preferredRegion as string | undefined,
      clientIp,
    );

    if (!result.ok) {
      const status = result.code === 'unknown_region' ? 400 : 401;
      this.json(res, status, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.auth || !body?.device) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'auth and device required' });
      return true;
    }

    const result = await this.backend.authenticate(
      body.auth as import('@kraki/protocol').AuthMethod,
      body.device as import('@kraki/protocol').DeviceInfo,
      body.headRegion as string | undefined,
    );

    if (!result.ok && result.code === 'wrong_region') {
      this.json(res, 403, result);
    } else if (!result.ok) {
      this.json(res, 401, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  private async handleChallenge(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.deviceId) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'deviceId required' });
      return true;
    }

    const result = await this.backend.startChallenge(
      body.deviceId as string,
      body.encryptionKey as string | undefined,
      body.headRegion as string | undefined,
    );

    if (!result.ok && result.code === 'wrong_region') {
      this.json(res, 403, result);
    } else if (!result.ok) {
      this.json(res, 401, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  private async handleVerify(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.deviceId || !body?.nonce || !body?.signature) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'deviceId, nonce, signature required' });
      return true;
    }

    const result = await this.backend.verifyChallenge(
      body.deviceId as string,
      body.nonce as string,
      body.signature as string,
      body.encryptionKey as string | undefined,
      body.headRegion as string | undefined,
    );

    if (!result.ok && result.code === 'wrong_region') {
      this.json(res, 403, result);
    } else if (!result.ok) {
      this.json(res, 401, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  private async handleCreatePairing(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.userId) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'userId required' });
      return true;
    }

    const result = this.backend.createPairingToken(body.userId as string);
    this.json(res, 200, result);
    return true;
  }

  private async handleRequestPairing(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);

    if (body?.userId) {
      // Direct create (authenticated user)
      const result = this.backend.createPairingToken(body.userId as string);
      this.json(res, 200, { ok: true, ...result });
      return true;
    }

    if (body?.token) {
      // One-shot: authenticate + create
      const result = await this.backend.requestPairingToken(body.token as string, body.ip as string | undefined);
      if (!result.ok) {
        this.json(res, 401, result);
      } else {
        this.json(res, 200, result);
      }
      return true;
    }

    this.json(res, 400, { ok: false, code: 'bad_request', message: 'userId or token required' });
    return true;
  }

  private handleGetConfig(_req: IncomingMessage, res: ServerResponse): boolean {
    this.json(res, 200, this.backend.getAuthInfo());
    return true;
  }

  private async handleEdgeJoin(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    if (!body?.token || !body?.region || !body?.relayUrl) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'token, region, and relayUrl are required' });
      return true;
    }

    const result = this.backend.completeEdgeJoin(
      body.token as string,
      body.region as string,
      body.relayUrl as string,
      body.displayName as string | undefined,
    );
    if (!result.ok) {
      const status = result.code === 'join_token_expired' ? 410 : 401;
      this.json(res, status, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  // ── Helpers ───────────────────────────────────────────

  private checkServiceKey(req: IncomingMessage, res: ServerResponse): boolean {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const valid = !!token && (
      (this.serviceKey ? safeEqual(token, this.serviceKey) : false)
      || this.backend.validateServiceKey(token).valid
    );
    if (!valid) {
      this.json(res, 401, { ok: false, code: 'unauthorized', message: 'Invalid service key' });
      return false;
    }
    return true;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

/** Read JSON body from request. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
