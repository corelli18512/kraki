/**
 * POST /api/auth/github/token — PKCE code → GitHub token for Kraki for Mac's
 * built-in tentacle (one-click sign-in without a device code).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'http';
import { Storage } from '../storage.js';
import { LocalAuthBackend } from '../local-auth-backend.js';
import { AccountApi } from '../account-api.js';
import { GitHubAuthProvider } from '../auth.js';

const VERIFIER = 'v'.repeat(64);
const REDIRECT = 'https://app.kraki.chat/auth/callback/desktop';

describe('POST /api/auth/github/token', () => {
  let storage: Storage;
  let server: Server;
  let port: number;
  let fetcher: ReturnType<typeof vi.fn>;

  async function start(opts: { clientSecret?: string } = { clientSecret: 'secret' }) {
    storage = new Storage(':memory:');
    fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'gho_new' }), { status: 200 }));
    const providers = new Map();
    providers.set('github', new GitHubAuthProvider({ clientId: 'cid', clientSecret: opts.clientSecret, fetcher: fetcher as unknown as typeof fetch }));
    const backend = new LocalAuthBackend({ storage, authProviders: providers });
    const api = new AccountApi({ authBackend: backend, serviceKey: 'service-key' });
    server = createServer(async (req, res) => {
      if (!(await api.handleRequest(req, res))) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as { port: number }).port;
  }

  async function post(body: unknown) {
    const res = await fetch(`http://localhost:${port}/api/auth/github/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() as Record<string, unknown> };
  }

  beforeEach(async () => { await start(); });
  afterEach(() => { server.close(); storage.close(); });

  it('is public and returns the token, forwarding the PKCE verifier and redirect URI', async () => {
    const { status, data } = await post({ code: 'c1', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true, token: 'gho_new' });
    const sent = JSON.parse((fetcher.mock.calls[0][1] as RequestInit).body as string);
    expect(sent).toMatchObject({ client_id: 'cid', client_secret: 'secret', code: 'c1', code_verifier: VERIFIER, redirect_uri: REDIRECT });
  });

  it('rejects requests without a PKCE verifier', async () => {
    const { status } = await post({ code: 'c1', redirectUri: REDIRECT });
    expect(status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports GitHub errors (e.g. a reused code)', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }));
    const { status, data } = await post({ code: 'c1', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(status).toBe(400);
    expect(data.code).toBe('exchange_failed');
  });

  it('fails cleanly when the server has no client secret', async () => {
    server.close(); storage.close();
    await start({ clientSecret: undefined });
    const { status, data } = await post({ code: 'c1', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    expect(status).toBe(400);
    expect(data.code).toBe('exchange_failed');
  });
});
