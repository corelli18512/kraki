/** Resuming Copilot sessions: resume config, events-file repair, unavailable sessions, the session store link. */

import type { ResumeSessionConfig, MCPServerConfig } from '@github/copilot-sdk';
import { existsSync, readFileSync, mkdirSync, unlinkSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getKrakiHome } from '../config.js';
import { TurnTracker } from './turn-tracker.js';
import { CopilotAdapter } from './copilot.js';
import { wireEvents } from './copilot-events.js';
import { touchSession } from './copilot-eviction.js';
import { broadcastPendingResolutions, cleanupSessionPermissions, makePermissionHandler, makeQuestionHandler } from './copilot-permissions.js';
import { sanitizeCopilotEventsFile, getCopilotConfigDir } from './copilot-paths.js';
import { logger, type PendingPermission, type PendingQuestion, type SessionEntry, getErrorMessage } from './copilot-session.js';

export function makeResumeConfig(
  adapter: CopilotAdapter,
  sessionId: string,
  pendingPermissions: Map<string, PendingPermission>,
  pendingQuestions: Map<string, PendingQuestion>,
): ResumeSessionConfig {
  // Load MCP servers for resumed sessions too
  const mcpConfigPath = join(homedir(), '.copilot', 'mcp-config.json');
  let mcpServers: Record<string, MCPServerConfig> | undefined;
  if (existsSync(mcpConfigPath)) {
    try {
      const rawServers = JSON.parse(readFileSync(mcpConfigPath, 'utf8')).mcpServers ?? {};
      if (Object.keys(rawServers).length > 0) {
        mcpServers = {};
        for (const [name, cfg] of Object.entries(rawServers)) {
          mcpServers[name] = { ...(cfg as MCPServerConfig), tools: (cfg as MCPServerConfig & { tools?: string[] }).tools ?? ['*'] };
        }
      }
    } catch { /* ignore parse errors on resume */ }
  }

  // Wire Kraki MCP into resumed sessions, scoped by the session id.
  if (adapter.krakiMcp) {
    const krakiEntry: MCPServerConfig = {
      type: 'http' as const,
      url: adapter.krakiMcp.urlForSession(sessionId),
      headers: { Authorization: `Bearer ${adapter.krakiMcp.tokenForSession(sessionId)}` },
      tools: ['*'],
    } as MCPServerConfig;
    mcpServers = { ...(mcpServers ?? {}), kraki: krakiEntry };
  }

  const systemPromptContent = adapter.krakiMcp
    ? `${CopilotAdapter.SYSTEM_PROMPT}\n\n${CopilotAdapter.KRAKI_MCP_PROMPT}`
    : CopilotAdapter.SYSTEM_PROMPT;

  return {
    configDirectory: getCopilotConfigDir(),
    streaming: true,
    ...(mcpServers && { mcpServers }),
    systemMessage: { mode: 'append' as const, content: systemPromptContent },
    onPermissionRequest: makePermissionHandler(adapter, pendingPermissions),
    onUserInputRequest: makeQuestionHandler(adapter, pendingQuestions),
  };
}

/** `carriedTurn`: the open turn of a send retrying across a runtime rebuild
 *  (the rebuild cleared the session entries). */
export async function resumeTrackedSession(adapter: CopilotAdapter, sessionId: string, carriedTurn?: TurnTracker): Promise<SessionEntry> {
  adapter.ensureClient();

  sanitizeEventsBeforeResume(adapter, sessionId);

  // A resume during a running turn (send recovery) keeps that turn and its
  // still-open permission/question requests, so their cards stay answerable.
  const existing = adapter.sessions.get(sessionId);
  const pendingPermissions = existing?.pendingPermissions ?? new Map<string, PendingPermission>();
  const pendingQuestions = existing?.pendingQuestions ?? new Map<string, PendingQuestion>();
  const session = await adapter.client!.resumeSession(
    sessionId,
    makeResumeConfig(adapter, sessionId, pendingPermissions, pendingQuestions),
  );
  const previous = carriedTurn ?? adapter.sessions.get(sessionId)?.turn;
  const entry = { session, pendingPermissions, pendingQuestions, turn: previous ?? new TurnTracker(adapter, sessionId) };

  adapter.sessions.set(sessionId, entry);
  touchSession(adapter, sessionId);
  wireEvents(adapter, sessionId, session);
  linkCopilotStore(adapter, sessionId);
  logger.debug({ sessionId }, 'session resumed');

  return entry;
}

/**
 * Pre-scan events.jsonl for known Copilot CLI writer-side bugs that cause
 * the SDK's loader-side Zod validation to throw "Session file is corrupted"
 * on resume.
 *
 * The CLI has a recurring pattern: its writer produces values that fail
 * its own bundled schema (github/copilot-cli #3454 exitCode<0,
 * #3432 totalPremiumRequests as float, #3520 ephemeral missing). When this
 * happens, `session.resume()` rejects the whole file and every conversation
 * turn is lost.
 *
 * We clamp known-bad values to schema-valid equivalents before resume so
 * the SDK accepts the file. Atomic file replace; no-op (fast read-only
 * scan) when nothing is wrong.
 */
export function sanitizeEventsBeforeResume(adapter: CopilotAdapter, sessionId: string): void {
  const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
  const fixed = sanitizeCopilotEventsFile(eventsPath);
  if (fixed > 0) {
    logger.info({ sessionId, fixed }, 'sanitized Copilot events.jsonl before resume');
  }
}

export function handleUnavailableSession(adapter: CopilotAdapter, sessionId: string, err: unknown): void {
  broadcastPendingResolutions(adapter, sessionId);

  cleanupSessionPermissions(adapter, sessionId);
  logger.warn({ err, sessionId }, 'Session became unavailable');
  adapter.emitError(sessionId, `Copilot could not reopen this session: ${getErrorMessage(err)}`);
  adapter.sessions.delete(sessionId);
  // Not terminal: the on-disk session may still be resumable (runtime
  // restart, transient corruption fixed by sanitize). Mark it evicted so the
  // next message retries a lazy resume instead of hitting a zombie.
  adapter.onSessionEvicted?.(sessionId);
}

/**
 * Wait for the SDK to finish writing to events.jsonl after a turn completes,
 * then fire onFlushComplete. Uses offset-based stabilization: stat the file
 * size and compare to the previous reading. If stable, fire immediately.
 * Otherwise retry a few times (max ~600ms total).
 */
/**
 * Co-located store pointer. Copilot's SDK ties its session-state to the
 * client (COPILOT_HOME), not to an individual session, so — unlike pi and
 * claude — its private transcript can't be physically relocated into the
 * Kraki session dir without a per-session client (rejected: too invasive for
 * the shared-client pool). Instead we drop a symlink inside the session dir
 * pointing at the real events.jsonl, so the session dir is self-describing
 * (Option A's discoverability intent) with zero risk to the write path.
 */
export function copilotEventsPath(adapter: CopilotAdapter, sessionId: string): string {
  return join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
}

export function linkCopilotStore(adapter: CopilotAdapter, sessionId: string): void {
  try {
    const dir = join(getKrakiHome(), 'sessions', sessionId);
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'copilot.jsonl');
    try { lstatSync(link); unlinkSync(link); } catch { /* no stale link */ }
    // Target may not exist yet (SDK writes lazily) — a dangling symlink is
    // fine and resolves once the first events are written.
    symlinkSync(copilotEventsPath(adapter, sessionId), link);
  } catch (err) {
    logger.debug({ err: (err as Error).message, sessionId }, 'linkCopilotStore failed');
  }
}
