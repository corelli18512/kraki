// Copilot token manager.
//
// Reuses the GitHub OAuth token that `pi` already stores
// (`~/.pi/agent/auth.json` → github-copilot.refresh, a `ghu_...` token) to mint
// short-lived Copilot API tokens (`tid=...`, ~30 min TTL) via GitHub's
// copilot_internal token endpoint, and keeps one cached + auto-refreshed.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Copilot gates model access by egress region. This box routes through a local
// forward proxy (HTTPS_PROXY); curl honours it automatically but Node's global
// fetch (undici) does not — so opt in explicitly, matching curl's path.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const AUTH_PATH = process.env.COPILOT_AUTH_PATH
  || join(homedir(), '.pi', 'agent', 'auth.json');

const EDITOR_VERSION = 'vscode/1.95.0';
const PLUGIN_VERSION = 'copilot-chat/0.22.0';
const USER_AGENT = 'GitHubCopilotChat/0.22.0';

/** Read the long-lived GitHub OAuth (`ghu_`) token pi persists. */
function readGithubToken() {
  const explicit = process.env.COPILOT_GITHUB_TOKEN;
  if (explicit) return explicit;
  const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const gc = raw['github-copilot'];
  if (!gc?.refresh) {
    throw new Error(`No github-copilot.refresh token in ${AUTH_PATH}`);
  }
  return gc.refresh;
}

let cached = null; // { token, apiBase, expiresAt }

async function mint() {
  const ghToken = readGithubToken();
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      Authorization: `token ${ghToken}`,
      'Editor-Version': EDITOR_VERSION,
      'Editor-Plugin-Version': PLUGIN_VERSION,
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Copilot token exchange failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('Copilot token exchange returned no token');
  const apiBase = data.endpoints?.api || 'https://api.githubcopilot.com';
  // expires_at is unix seconds; refresh a bit early.
  const expiresAt = (data.expires_at ? data.expires_at * 1000 : Date.now() + 25 * 60_000);
  cached = { token: data.token, apiBase, expiresAt };
  return cached;
}

/** Get a valid Copilot API token + base URL, refreshing when close to expiry. */
export async function getCopilotToken() {
  const skewMs = 2 * 60_000;
  if (cached && cached.expiresAt - skewMs > Date.now()) return cached;
  return mint();
}

export const COPILOT_HEADERS = {
  'Editor-Version': EDITOR_VERSION,
  'Editor-Plugin-Version': PLUGIN_VERSION,
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent': USER_AGENT,
};
