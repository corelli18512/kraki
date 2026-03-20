import { describe, it, expect } from 'vitest';
import { GitHubAuthProvider, OpenAuthProvider, ApiKeyAuthProvider, ThrottledAuthProvider } from '../auth.js';

function mockFetch(status: number, body: Record<string, unknown>): typeof fetch {
  return async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetchError(message: string): typeof fetch {
  return async () => { throw new Error(message); };
}

describe('GitHubAuthProvider', () => {
  it('should return user info for a valid token', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetch(200, { id: 12345, login: 'corelli' }) });
    const result = await provider.authenticate({ token: 'valid_token' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe('12345');
      expect(result.user.login).toBe('corelli');
      expect(result.user.provider).toBe('github');
    }
  });

  it('should return error for 401 unauthorized', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetch(401, { message: 'Bad credentials' }) });
    const result = await provider.authenticate({ token: 'bad_token' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('401');
    }
  });

  it('should return error for 403 forbidden', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetch(403, { message: 'Forbidden' }) });
    const result = await provider.authenticate({ token: 'limited_token' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('403');
    }
  });

  it('should return error on network failure', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetchError('Network unreachable') });
    const result = await provider.authenticate({ token: 'any_token' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Network unreachable');
    }
  });

  it('should return error when no token provided', async () => {
    const provider = new GitHubAuthProvider();
    const result = await provider.authenticate({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Token required');
    }
  });

  it('should have name "github"', () => {
    const provider = new GitHubAuthProvider();
    expect(provider.name).toBe('github');
  });

  it('should reject unexpected GitHub API response shape', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetch(200, { unexpected: 'data' }) });
    const result = await provider.authenticate({ token: 'token' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Unexpected');
    }
  });
});

describe('OpenAuthProvider', () => {
  it('should return local user', async () => {
    const provider = new OpenAuthProvider();
    const result = await provider.authenticate({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe('local');
      expect(result.user.login).toBe('local');
      expect(result.user.provider).toBe('open');
    }
  });

  it('should have name "open"', () => {
    expect(new OpenAuthProvider().name).toBe('open');
  });
});

describe('ApiKeyAuthProvider', () => {
  it('should accept valid key', async () => {
    const provider = new ApiKeyAuthProvider('secret123');
    const result = await provider.authenticate({ token: 'secret123' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.provider).toBe('apikey');
    }
  });

  it('should reject invalid key', async () => {
    const provider = new ApiKeyAuthProvider('secret123');
    const result = await provider.authenticate({ token: 'wrong' });
    expect(result.ok).toBe(false);
  });

  it('should reject missing key', async () => {
    const provider = new ApiKeyAuthProvider('secret123');
    const result = await provider.authenticate({});
    expect(result.ok).toBe(false);
  });

  it('should have name "apikey"', () => {
    expect(new ApiKeyAuthProvider('x').name).toBe('apikey');
  });
});

describe('OpenAuthProvider with shared key', () => {
  it('should accept matching shared key', async () => {
    const provider = new OpenAuthProvider('my-shared-secret');
    const result = await provider.authenticate({ token: 'my-shared-secret' });
    expect(result.ok).toBe(true);
  });

  it('should reject wrong shared key', async () => {
    const provider = new OpenAuthProvider('my-shared-secret');
    const result = await provider.authenticate({ token: 'wrong' });
    expect(result.ok).toBe(false);
  });

  it('should reject missing token when shared key is set', async () => {
    const provider = new OpenAuthProvider('my-shared-secret');
    const result = await provider.authenticate({});
    expect(result.ok).toBe(false);
  });

  it('should accept any connection when no shared key', async () => {
    const provider = new OpenAuthProvider();
    const result = await provider.authenticate({});
    expect(result.ok).toBe(true);
  });
});

describe('ThrottledAuthProvider', () => {
  it('should pass through successful auth', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 3, 60_000);
    const result = await throttled.authenticate({ token: 'secret', ip: '1.2.3.4' });
    expect(result.ok).toBe(true);
  });

  it('should pass through failed auth under limit', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 3, 60_000);
    const result = await throttled.authenticate({ token: 'wrong', ip: '1.2.3.4' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Invalid API key');
    }
  });

  it('should block after max failures from same IP', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 3, 60_000);

    // 3 failures
    await throttled.authenticate({ token: 'wrong', ip: '5.5.5.5' });
    await throttled.authenticate({ token: 'wrong', ip: '5.5.5.5' });
    await throttled.authenticate({ token: 'wrong', ip: '5.5.5.5' });

    // 4th should be blocked
    const result = await throttled.authenticate({ token: 'secret', ip: '5.5.5.5' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Too many');
    }
  });

  it('should not block different IPs', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 2, 60_000);

    await throttled.authenticate({ token: 'wrong', ip: '1.1.1.1' });
    await throttled.authenticate({ token: 'wrong', ip: '1.1.1.1' });

    // Different IP should still work
    const result = await throttled.authenticate({ token: 'secret', ip: '2.2.2.2' });
    expect(result.ok).toBe(true);
  });

  it('should reset after successful auth', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 3, 60_000);

    await throttled.authenticate({ token: 'wrong', ip: '3.3.3.3' });
    await throttled.authenticate({ token: 'wrong', ip: '3.3.3.3' });
    // Success resets the counter
    await throttled.authenticate({ token: 'secret', ip: '3.3.3.3' });
    // Should be allowed again
    const result = await throttled.authenticate({ token: 'wrong', ip: '3.3.3.3' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Invalid API key'); // not "Too many"
    }
  });

  it('should delegate name from inner provider', () => {
    const inner = new GitHubAuthProvider();
    const throttled = new ThrottledAuthProvider(inner);
    expect(throttled.name).toBe('github');
  });

  it('should reset after window expires', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    // Very short window: 1ms
    const throttled = new ThrottledAuthProvider(inner, 2, 1);

    await throttled.authenticate({ token: 'wrong', ip: '9.9.9.9' });
    await throttled.authenticate({ token: 'wrong', ip: '9.9.9.9' });

    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should be allowed again (window expired)
    const result = await throttled.authenticate({ token: 'secret', ip: '9.9.9.9' });
    expect(result.ok).toBe(true);
  });

  it('should use "unknown" when no IP provided', async () => {
    const inner = new ApiKeyAuthProvider('secret');
    const throttled = new ThrottledAuthProvider(inner, 2, 60_000);

    // No ip field at all
    await throttled.authenticate({ token: 'wrong' });
    await throttled.authenticate({ token: 'wrong' });
    const result = await throttled.authenticate({ token: 'secret' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Too many');
  });
});

// --- GitHub OAuth Code Exchange ---

/** Mocks both the OAuth token endpoint and the GitHub user API */
function mockOAuthFetcher(
  oauthResponse: { status: number; body: Record<string, unknown> },
  apiResponse: { status: number; body: Record<string, unknown> },
): typeof fetch {
  return async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('login/oauth/access_token')) {
      return new Response(JSON.stringify(oauthResponse.body), {
        status: oauthResponse.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(apiResponse.body), {
      status: apiResponse.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('GitHubAuthProvider OAuth code exchange', () => {
  it('should exchange code and authenticate successfully', async () => {
    const provider = new GitHubAuthProvider({
      fetcher: mockOAuthFetcher(
        { status: 200, body: { access_token: 'gho_abc123', token_type: 'bearer', scope: 'read:user' } },
        { status: 200, body: { id: 42, login: 'testuser' } },
      ),
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    });

    const result = await provider.authenticate({ githubCode: 'code_from_github' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.id).toBe('42');
      expect(result.user.login).toBe('testuser');
      expect(result.user.provider).toBe('github');
    }
  });

  it('should fail when GitHub returns an OAuth error', async () => {
    const provider = new GitHubAuthProvider({
      fetcher: mockOAuthFetcher(
        { status: 200, body: { error: 'bad_verification_code', error_description: 'The code has expired' } },
        { status: 200, body: {} },
      ),
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    });

    const result = await provider.authenticate({ githubCode: 'expired_code' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('The code has expired');
    }
  });

  it('should fail when token exchange returns non-200', async () => {
    const provider = new GitHubAuthProvider({
      fetcher: mockOAuthFetcher(
        { status: 500, body: {} },
        { status: 200, body: {} },
      ),
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    });

    const result = await provider.authenticate({ githubCode: 'some_code' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('500');
    }
  });

  it('should fail when OAuth is not configured', async () => {
    const provider = new GitHubAuthProvider({ fetcher: mockFetch(200, {}) });

    const result = await provider.authenticate({ githubCode: 'some_code' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('not configured');
    }
  });

  it('should fail when exchange returns no access_token', async () => {
    const provider = new GitHubAuthProvider({
      fetcher: mockOAuthFetcher(
        { status: 200, body: { token_type: 'bearer' } },
        { status: 200, body: {} },
      ),
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    });

    const result = await provider.authenticate({ githubCode: 'some_code' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('missing access_token');
    }
  });

  it('should report oauthConfigured correctly', () => {
    const withOAuth = new GitHubAuthProvider({ clientId: 'id', clientSecret: 'secret' });
    expect(withOAuth.oauthConfigured).toBe(true);
    expect(withOAuth.getClientId()).toBe('id');

    const withoutOAuth = new GitHubAuthProvider();
    expect(withoutOAuth.oauthConfigured).toBe(false);
    expect(withoutOAuth.getClientId()).toBeUndefined();
  });

  it('should fail on network error during code exchange', async () => {
    const provider = new GitHubAuthProvider({
      fetcher: mockFetchError('Connection refused'),
      clientId: 'my-client-id',
      clientSecret: 'my-client-secret',
    });

    const result = await provider.authenticate({ githubCode: 'some_code' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('Connection refused');
    }
  });
});
