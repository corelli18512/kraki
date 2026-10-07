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
import { clientIp } from './client-ip.js';

export interface AccountApiOptions {
  authBackend: LocalAuthBackend;
  serviceKey?: string;
  /** Requests per minute per IP on the public routes. Default 60. */
  publicRateLimit?: number;
}

type ServiceCaller = { admin: true } | { admin: false; region: string };

export class AccountApi {
  private backend: LocalAuthBackend;
  private serviceKey?: string;
  private publicLimiter: IpRateLimiter;

  constructor(options: AccountApiOptions) {
    this.backend = options.authBackend;
    this.serviceKey = options.serviceKey;
    this.publicLimiter = new IpRateLimiter(options.publicRateLimit ?? 60);
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
      || (path === '/api/auth/github/token' && req.method === 'POST')
      // Public sign-in info (methods + GitHub OAuth client id), the same the
      // WebSocket auth_info exposes. Clients behind an HTTP proxy can't use
      // that WebSocket probe before they are set up, so they read it here.
      || (path === '/api/config' && req.method === 'GET')
      || (path === '/api/edge/join' && req.method === 'POST');

    let caller: ServiceCaller | null = null;
    if (!publicRoute) {
      caller = this.checkServiceKey(req, res);
      if (!caller) return true;
    }
    if (publicRoute && !this.publicLimiter.take(clientIp(req))) {
      res.setHeader('Retry-After', '60');
      this.json(res, 429, { ok: false, code: 'rate_limited', message: 'Too many requests' });
      return true;
    }

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
        case '/api/auth/github/token':
          if (req.method === 'POST') return await this.handleGitHubToken(req, res);
          break;
        case '/api/auth/challenge':
          if (req.method === 'POST') return await this.handleChallenge(req, res);
          break;
        case '/api/auth/verify':
          if (req.method === 'POST') return await this.handleVerify(req, res);
          break;
        case '/api/pairing/create':
          if (req.method === 'POST') return await this.handleCreatePairing(req, res, caller!);
          break;
        case '/api/pairing/request':
          if (req.method === 'POST') return await this.handleRequestPairing(req, res, caller!);
          break;
        case '/api/config':
          if (req.method === 'GET') return this.handleGetConfig(req, res);
          break;
        case '/api/devices/remove':
          if (req.method === 'POST') return await this.handleRemoveDevice(req, res, caller!);
          break;
        case '/api/account/delete':
          if (req.method === 'POST') return await this.handleDeleteAccount(req, res, caller!);
          break;
        case '/api/edge/join':
          if (req.method === 'POST') return await this.handleEdgeJoin(req, res);
          break;
        case '/api/edge/announce':
          if (req.method === 'POST') return await this.handleEdgeAnnounce(req, res);
          break;
      }
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        this.json(res, 413, { ok: false, code: 'payload_too_large', message: 'Request body too large' });
        return true;
      }
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

    const ip = clientIp(req);

    const result = await this.backend.resolveLogin(
      body.auth as import('@kraki/protocol').AuthMethod,
      body.preferredRegion as string | undefined,
      ip === 'unknown' ? undefined : ip,
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

    // Service-key route: the caller is an edge relaying an end user's login,
    // so the user's IP comes in the body (the socket address is the edge's).
    const result = await this.backend.authenticate(
      body.auth as import('@kraki/protocol').AuthMethod,
      body.device as import('@kraki/protocol').DeviceInfo,
      body.headRegion as string | undefined,
      typeof body.clientIp === 'string' ? body.clientIp : undefined,
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

  /** Service-key route: an edge forwards a user's device removal here. */
  private async handleRemoveDevice(req: IncomingMessage, res: ServerResponse, caller: ServiceCaller): Promise<boolean> {
    const body = await readBody(req);
    if (typeof body?.userId !== 'string' || typeof body?.deviceId !== 'string') {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'userId and deviceId required' });
      return true;
    }
    if (!this.mayActForUser(caller, body.userId, res)) return true;
    const removed = await this.backend.removeDevice(body.userId, body.deviceId);
    this.json(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, code: 'not_found', message: 'Device not found' });
    return true;
  }

  /** Service-key route: an edge forwards a user's account deletion here. */
  private async handleDeleteAccount(req: IncomingMessage, res: ServerResponse, caller: ServiceCaller): Promise<boolean> {
    const body = await readBody(req);
    if (typeof body?.userId !== 'string' || !body.userId) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'userId required' });
      return true;
    }
    if (!this.mayActForUser(caller, body.userId, res)) return true;
    if (!this.backend.deleteAccount) {
      this.json(res, 501, { ok: false, code: 'not_supported', message: 'Account deletion is not supported' });
      return true;
    }
    const deviceIds = await this.backend.deleteAccount(body.userId);
    getLogger().info('Account deleted via account API', { userId: body.userId, devices: deviceIds.length });
    this.json(res, 200, { ok: true, deviceIds });
    return true;
  }

  private async handleCreatePairing(req: IncomingMessage, res: ServerResponse, caller: ServiceCaller): Promise<boolean> {
    const body = await readBody(req);
    if (typeof body?.userId !== 'string' || !body.userId) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'userId required' });
      return true;
    }
    if (!this.mayActForUser(caller, body.userId, res)) return true;

    const result = this.backend.createPairingToken(body.userId as string);
    this.json(res, 200, result);
    return true;
  }

  private async handleRequestPairing(req: IncomingMessage, res: ServerResponse, caller: ServiceCaller): Promise<boolean> {
    const body = await readBody(req);

    if (typeof body?.userId === 'string' && body.userId) {
      if (!this.mayActForUser(caller, body.userId, res)) return true;
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

  /**
   * PKCE code → GitHub token for native clients (public route). Only a caller
   * holding the code verifier can redeem a code, so this reveals nothing to
   * anyone else; the server just adds the client secret GitHub requires.
   */
  private async handleGitHubToken(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    const code = body?.code;
    const codeVerifier = body?.codeVerifier;
    const redirectUri = body?.redirectUri;
    if (typeof code !== 'string' || typeof codeVerifier !== 'string' || typeof redirectUri !== 'string'
      || !code || codeVerifier.length < 43) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'code, codeVerifier and redirectUri are required' });
      return true;
    }
    const result = await this.backend.exchangeGitHubCode(code, { codeVerifier, redirectUri });
    if (!result.ok) {
      getLogger().warn('GitHub code exchange failed', { reason: result.message });
      this.json(res, 400, { ok: false, code: 'exchange_failed', message: result.message });
      return true;
    }
    this.json(res, 200, { ok: true, token: result.token });
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

  /**
   * Edge announce — idempotent update of an edge region's relay URL.
   * Authenticated by the region's existing service key (Bearer header).
   * Edges call this on startup so their `PUBLIC_RELAY_URL` always reflects
   * the latest config without rotating the service key.
   */
  private async handleEdgeAnnounce(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) {
      this.json(res, 401, { ok: false, code: 'unauthorized', message: 'Bearer service key required' });
      return true;
    }

    const body = await readBody(req);
    if (!body?.region || !body?.relayUrl) {
      this.json(res, 400, { ok: false, code: 'bad_request', message: 'region and relayUrl are required' });
      return true;
    }

    const result = this.backend.announceEdgeRegion(
      token,
      body.region as string,
      body.relayUrl as string,
      body.displayName as string | undefined,
    );
    if (!result.ok) {
      const status = result.code === 'unauthorized' ? 401
        : result.code === 'region_mismatch' ? 403
        : 400;
      this.json(res, status, result);
    } else {
      this.json(res, 200, result);
    }
    return true;
  }

  // ── Helpers ───────────────────────────────────────────

  /** The admin key, or the region of a registered edge; null when invalid. */
  private checkServiceKey(req: IncomingMessage, res: ServerResponse): ServiceCaller | null {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token && this.serviceKey && safeEqual(token, this.serviceKey)) return { admin: true };
    const edge = token ? this.backend.validateServiceKey(token) : { valid: false as const };
    if (edge.valid && edge.region) return { admin: false, region: edge.region };
    this.json(res, 401, { ok: false, code: 'unauthorized', message: 'Invalid service key' });
    return null;
  }

  /**
   * An edge key acts only for users assigned to that edge's region; one
   * compromised edge must not be able to pair devices into, or remove devices
   * from, accounts that live elsewhere. Users not yet assigned a region are
   * allowed (they are being onboarded through this edge).
   */
  private mayActForUser(caller: ServiceCaller, userId: string, res: ServerResponse): boolean {
    if (caller.admin) return true;
    const userRegion = this.backend.getUserRegion(userId);
    if (userRegion && userRegion !== caller.region) {
      getLogger().warn('Edge tried to act for a user of another region', { edgeRegion: caller.region, userRegion });
      this.json(res, 403, { ok: false, code: 'wrong_region', message: 'User is not assigned to this region' });
      return false;
    }
    return true;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    if (res.headersSent) return;
    // An identity-provider outage is not a rejected credential (G4).
    if (status === 401 && (data as { code?: string } | null)?.code === 'service_unavailable') status = 503;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

/** Largest JSON body the account API reads (G3). Real requests are < 8 KB. */
export const MAX_BODY_BYTES = 64 * 1024;

class BodyTooLargeError extends Error {}

/** Read JSON body from request; rejects with BodyTooLargeError past MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        chunks.length = 0;
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => { if (!done) { done = true; resolve(null); } });
  });
}

/**
 * Fixed-window request counter per client IP for the public routes (G3).
 * Service-key routes are not limited: every user of a regional relay reaches
 * them from that relay's single address.
 */
export class IpRateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit = 60, private readonly windowMs = 60_000, private readonly now = () => Date.now()) {}

  /** Count one request; false when the IP is over its limit. */
  take(ip: string): boolean {
    const now = this.now();
    if (this.windows.size > 10_000) this.prune(now);
    const entry = this.windows.get(ip);
    if (!entry || now - entry.start >= this.windowMs) {
      this.windows.set(ip, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private prune(now: number): void {
    for (const [ip, entry] of this.windows) {
      if (now - entry.start >= this.windowMs) this.windows.delete(ip);
    }
  }
}
