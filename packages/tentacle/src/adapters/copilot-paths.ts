/** Where Copilot lives: its CLI, its config dir (with Kraki's permissions file), its events files. */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { getKrakiHome } from '../config.js';
import { linkIntoShadow } from './shadow-link.js';
import { logger } from './copilot-session.js';

export function resolveExecutableFromPath(commandName: string): string | undefined {
  const lookupCommand =
    process.platform === 'win32'
      ? `where.exe ${commandName}`
      : `command -v ${commandName}`;

  try {
    const output = execSync(lookupCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((candidate) => candidate.length > 0 && existsSync(candidate));
  } catch {
    return undefined;
  }
}

export function resolveCopilotCliPath(): string | undefined {
  return resolveExecutableFromPath('copilot');
}



/**
 * Repair known Copilot CLI writer-side schema violations in an events.jsonl
 * file so the SDK's loader-side validator accepts it on `session.resume()`.
 *
 * Returns the number of lines fixed. 0 means the file was already valid
 * (or did not exist) and was not rewritten.
 *
 * Known fixups:
 *   - `data.tokensRemoved` on `session.compaction_complete`: the schema
 *     requires `>= 0` but the writer sometimes produces negatives like -2098.
 *     We clamp to 0. This is metadata accounting only — does not affect
 *     conversation history or agent behaviour.
 *
 * Atomic file replace via tmp+rename. On any I/O error the original file is
 * left untouched and 0 is returned.
 *
 * Add new fixups here as more writer-side bugs are identified upstream
 * (github/copilot-cli has a recurring pattern of these: #3454, #3432, #3520).
 *
 * Exported for unit testing — production code should call the wrapper on
 * CopilotAdapter so the log line is attached to a sessionId.
 */
export function sanitizeCopilotEventsFile(eventsPath: string): number {
  if (!existsSync(eventsPath)) return 0;

  let raw: string;
  try {
    raw = readFileSync(eventsPath, 'utf8');
  } catch {
    return 0;
  }

  const lines = raw.split('\n');
  let fixed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const data = ev?.data as Record<string, unknown> | undefined;
      if (data && typeof data === 'object') {
        // github/copilot-cli: negative `tokensRemoved` on
        // session.compaction_complete violates the schema's `>= 0`
        // constraint. Clamp to 0.
        if (typeof data.tokensRemoved === 'number' && data.tokensRemoved < 0) {
          data.tokensRemoved = 0;
          lines[i] = JSON.stringify(ev);
          fixed++;
        }
      }
    } catch {
      // Malformed line — leave verbatim. The SDK will report its own error
      // with the original line number, which we want to preserve.
    }
  }

  if (fixed === 0) return 0;

  const tmpPath = `${eventsPath}.kraki-sanitize.tmp`;
  try {
    writeFileSync(tmpPath, lines.join('\n'), 'utf8');
    renameSync(tmpPath, eventsPath);
    return fixed;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return 0;
  }
}

/** Defensive basename — strips any leading directory components and never
 *  throws. Used to populate ContentRef.name from the absolute path the
 *  agent passed to show_image. */
export function basenameSafe(p: string): string {
  try {
    return basename(p) || 'image';
  } catch {
    return 'image';
  }
}

// ── Copilot configDir shadow ────────────────────────────
//
// The Copilot CLI loads persistent tool approval rules from
// ~/.copilot/permissions-config.json. When those rules include
// {kind:"write"}, the CLI auto-approves writes *without* calling
// the SDK's onPermissionRequest handler — bypassing Kraki's mode
// enforcement entirely.
//
// To ensure every permission flows through Kraki, we create a
// shadow configDir that symlinks all user config (MCP, hooks, etc.)
// but replaces permissions-config.json with an empty one.

export const PERMISSIONS_CONFIG_FILE = 'permissions-config.json';
export const EMPTY_PERMISSIONS = JSON.stringify({ locations: {} });
export let cachedCopilotConfigDir: string | null = null;

export function getCopilotConfigDir(): string {
  if (cachedCopilotConfigDir && existsSync(cachedCopilotConfigDir)) {
    return cachedCopilotConfigDir;
  }

  const realCopilotDir = join(homedir(), '.copilot');
  const shadowDir = join(getKrakiHome(), 'copilot-config');
  mkdirSync(shadowDir, { recursive: true });

  // Symlink every entry from ~/.copilot except permissions-config*
  if (existsSync(realCopilotDir)) {
    try {
      for (const entry of readdirSync(realCopilotDir)) {
        if (entry.startsWith('permissions-config')) continue;
        // Junction/hard-link fallback on Windows without Developer Mode,
        // where a plain symlink fails and the user's config would vanish.
        if (!linkIntoShadow(join(realCopilotDir, entry), join(shadowDir, entry))) {
          logger.warn({ entry }, 'Could not share a Copilot config entry with Kraki sessions');
        }
      }
    } catch (err) {
      logger.warn(`Failed to set up shadow copilot config: ${(err as Error).message}`);
    }
  }

  // Write an empty permissions config so the CLI starts with no pre-approved rules
  writeFileSync(join(shadowDir, PERMISSIONS_CONFIG_FILE), EMPTY_PERMISSIONS);

  cachedCopilotConfigDir = shadowDir;
  logger.debug({ shadowDir }, 'Using shadow copilot configDir (no stored tool approvals)');
  return shadowDir;
}
