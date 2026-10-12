/** Claude Code's environment: settings env, config dir, keychain access, logged-out detection, model alias env keys. */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './claude-session.js';

/**
 * Load `env` overrides from `~/.claude/settings.json` (the same file
 * Claude Code itself reads) and merge them into `process.env`.
 *
 * This lets users running kraki as a launchd / systemd daemon — which
 * does not inherit their interactive shell environment — point the
 * Claude SDK at custom Anthropic-compatible providers (e.g. DeepSeek,
 * a self-hosted gateway) by writing standard ANTHROPIC_* keys into
 * settings.json instead of a shell rc file.
 *
 * Existing values in `process.env` win, so a user who *does* have the
 * vars exported (e.g. via plist EnvironmentVariables) keeps that
 * behaviour.
 *
 * Errors are non-fatal — a missing or malformed file just means we
 * fall back to whatever is already in `process.env`.
 */
export function loadClaudeSettingsEnv(configDir: string): Record<string, string> {
  const settingsPath = join(configDir, 'settings.json');
  const out: Record<string, string> = {};
  if (!existsSync(settingsPath)) return out;
  try {
    const raw = readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const env = parsed.env;
    if (!env || typeof env !== 'object') return out;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') continue;
      if (process.env[key] !== undefined) continue;
      out[key] = value;
    }
    if (Object.keys(out).length > 0) {
      logger.debug({ path: settingsPath, count: Object.keys(out).length }, 'Loaded env from Claude settings.json');
    }
  } catch (err) {
    logger.warn(
      { error: (err as Error).message, path: settingsPath },
      'Failed to load Claude settings.json env (continuing with process env only)',
    );
  }
  return out;
}


/** The user's real Claude Code config root: an explicit CLAUDE_CONFIG_DIR,
 *  otherwise ~/.claude. Kraki's per-session shadow homes are built FROM this. */
export function claudeConfigSource(): { dir: string; explicit: boolean } {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? { dir: explicit, explicit: true } : { dir: join(homedir(), '.claude'), explicit: false };
}

/**
 * Claude Code names its macOS Keychain credential item after the config dir:
 * `Claude Code-credentials` for the default dir, `...-<sha256(dir)[:8]>` once
 * CLAUDE_CONFIG_DIR is set (verified in Claude Code 2.1.220). Kraki's shadow
 * CLAUDE_CONFIG_DIR would therefore look up a Keychain item that does not
 * exist, and subscription (OAuth) logins could never work. The CLI's
 * CLAUDE_SECURESTORAGE_CONFIG_DIR pins secure storage to the REAL config root
 * (empty string = the default, unsuffixed item).
 */
export function secureStorageEnv(): Record<string, string> {
  if (process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return {};
  const source = claudeConfigSource();
  return { CLAUDE_SECURESTORAGE_CONFIG_DIR: source.explicit ? source.dir : '' };
}

/** True when SDK accountInfo proves no credential is configured at all. */
export function isClaudeLoggedOut(info: unknown): boolean {
  if (!info || typeof info !== 'object') return false;
  const a = info as { email?: string; apiKeySource?: string; tokenSource?: string; apiProvider?: string };
  if (a.apiProvider && a.apiProvider !== 'firstParty') return false; // Bedrock/Vertex/… auth is external
  return !a.email && !a.apiKeySource && (!a.tokenSource || a.tokenSource === 'none');
}

/** Map an SDK model alias (`opus`, `opus[1m]`, …) to its ANTHROPIC_* override key. */
export function aliasEnvKey(alias: string): string | undefined {
  const base = alias.replace(/\[[^\]]*\]$/, '');
  return ({
    default: 'ANTHROPIC_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  } as Record<string, string>)[base];
}
