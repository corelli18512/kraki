// Auth credentials: a discriminated union by method.

// ============================================================
// Auth credentials — discriminated union by method
// ============================================================

export interface GithubTokenAuth {
  method: 'github_token';
  token: string;
}

export interface GithubOAuthAuth {
  method: 'github_oauth';
  code: string;
  /**
   * PKCE code verifier — the random string whose SHA-256 hash was sent
   * as `code_challenge` when this OAuth flow was started. Optional for
   * back-compat, but required by GitHub's token-exchange endpoint when
   * a `code_challenge` was originally provided.
   */
  codeVerifier?: string;
  /**
   * The exact `redirect_uri` the client used in the authorize URL.
   * GitHub validates this matches at token-exchange time when the
   * authorize request included one. Optional to preserve back-compat
   * with older clients that never sent it.
   */
  redirectUri?: string;
}

export interface PairingAuth {
  method: 'pairing';
  token: string;
}

export interface ChallengeAuth {
  method: 'challenge';
  deviceId: string;
}

export interface ApiKeyAuth {
  method: 'apikey';
  key: string;
}

export interface OpenAuth {
  method: 'open';
  sharedKey?: string;
}

export type AuthMethod = GithubTokenAuth | GithubOAuthAuth | PairingAuth | ChallengeAuth | ApiKeyAuth | OpenAuth;
