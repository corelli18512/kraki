/**
 * Session scanner — discovers local Copilot sessions for the import picker.
 *
 * Two data sources:
 * 1. SDK's CopilotClient.listSessions() — sessions the running CLI server knows about
 * 2. Filesystem scan of ~/.copilot/session-state/ — all sessions including historical
 *
 * Outputs a flat LocalSession[] catalog. The arm groups client-side by gitRoot/cwd.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { LocalSession, LocalSessionSource } from '@kraki/protocol';
import { createLogger } from './logger.js';

const logger = createLogger('session-scanner');

const SESSION_STATE_DIR = join(homedir(), '.copilot', 'session-state');

// ── Workspace YAML parser (simple key-value, no full YAML dep) ──

interface WorkspaceData {
  id?: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

function parseWorkspaceYaml(raw: string): WorkspaceData {
  const data: Record<string, string> = {};
  const lines = raw.split('\n');
  let inMultiline = false;
  let multilineKey = '';
  const multilineLines: string[] = [];

  for (const line of lines) {
    if (inMultiline) {
      if (line.startsWith('  ')) {
        multilineLines.push(line.trim());
        continue;
      }
      data[multilineKey] = multilineLines.join(' ').slice(0, 200);
      inMultiline = false;
      multilineLines.length = 0;
    }

    if (!line.includes(':') || line.startsWith(' ')) continue;
    const idx = line.indexOf(':');
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();

    if (!value && (key === 'summary')) {
      inMultiline = true;
      multilineKey = key;
      continue;
    }

    // Strip YAML block scalar indicators
    if (value === '|-' || value === '|' || value === '>') {
      inMultiline = true;
      multilineKey = key;
      continue;
    }

    data[key] = value;
  }

  if (inMultiline && multilineLines.length > 0) {
    data[multilineKey] = multilineLines.join(' ').slice(0, 200);
  }

  return data as WorkspaceData;
}

// ── Lock file / PID liveness check ──────────────────────

function isSessionLive(sessionDir: string): boolean {
  try {
    const files = readdirSync(sessionDir);
    const lockFile = files.find(f => f.startsWith('inuse.') && f.endsWith('.lock'));
    if (!lockFile) return false;

    const pidStr = lockFile.replace('inuse.', '').replace('.lock', '');
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) return false;

    // Check if PID is alive (signal 0 = check existence)
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH = process doesn't exist → dead
      // EPERM = process exists but different owner → alive
      return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  } catch {
    return false;
  }
}

// ── Session source detection ────────────────────────────

function detectSource(sessionDir: string): LocalSessionSource {
  const metaPath = join(sessionDir, 'vscode.metadata.json');
  if (existsSync(metaPath)) {
    try {
      const content = readFileSync(metaPath, 'utf8').trim();
      // Non-empty object means VS Code created it
      if (content && content !== '{}') return 'vscode';
    } catch { /* ignore */ }
  }
  return 'copilot-cli';
}

// ── Model extraction from events.jsonl first line ───────

function extractModelFromEvents(sessionDir: string): string | undefined {
  const eventsPath = join(sessionDir, 'events.jsonl');
  if (!existsSync(eventsPath)) return undefined;

  try {
    // Read only the first line (session.start event) without loading entire file
    const fd = require('node:fs').openSync(eventsPath, 'r');
    const buf = Buffer.alloc(2048);
    const bytesRead = require('node:fs').readSync(fd, buf, 0, 2048, 0);
    require('node:fs').closeSync(fd);

    const firstLine = buf.toString('utf8', 0, bytesRead).split('\n')[0];
    if (!firstLine) return undefined;

    const event = JSON.parse(firstLine);
    if (event.type === 'session.start') {
      return event.data?.selectedModel ?? undefined;
    }
  } catch { /* ignore parse errors */ }

  return undefined;
}

// ── Main scanner ────────────────────────────────────────

export interface ScanOptions {
  /** Additional directories to scan beyond ~/.copilot/session-state/ */
  extraDirs?: string[];
  /** Whether to read events.jsonl first line for model info (slower). Default false. */
  includeModel?: boolean;
}

/**
 * Scan local filesystem for Copilot sessions.
 * Returns a flat array of LocalSession descriptors.
 */
export function scanLocalSessions(options: ScanOptions = {}): LocalSession[] {
  const sessions: LocalSession[] = [];
  const scanDirs = [SESSION_STATE_DIR, ...(options.extraDirs ?? [])];

  for (const baseDir of scanDirs) {
    if (!existsSync(baseDir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(baseDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const sessionDir = join(baseDir, entry);
      const wsPath = join(sessionDir, 'workspace.yaml');

      if (!existsSync(wsPath)) continue;

      try {
        const raw = readFileSync(wsPath, 'utf8');
        const ws = parseWorkspaceYaml(raw);

        // Use modifiedTime from filesystem if workspace.yaml doesn't have it
        let modifiedTime = ws.updated_at ?? ws.created_at ?? '';
        if (!modifiedTime) {
          try {
            const stat = statSync(join(sessionDir, 'events.jsonl'));
            modifiedTime = stat.mtime.toISOString();
          } catch {
            modifiedTime = new Date().toISOString();
          }
        }

        const session: LocalSession = {
          sessionId: ws.id ?? entry,
          cwd: ws.cwd ?? '/',
          startTime: ws.created_at ?? modifiedTime,
          modifiedTime,
          isLive: isSessionLive(sessionDir),
          source: detectSource(sessionDir),
        };

        if (ws.git_root) session.gitRoot = ws.git_root;
        if (ws.repository) session.repository = ws.repository;
        if (ws.branch) session.branch = ws.branch;
        if (ws.summary) session.summary = ws.summary.slice(0, 200);

        // Skip Kraki daemon sessions (cwd: "/" with no git context)
        if (session.cwd === '/' && !session.gitRoot) continue;

        // Skip sessions with no events.jsonl (empty shells with no conversation)
        if (!existsSync(join(sessionDir, 'events.jsonl'))) continue;

        if (options.includeModel) {
          const model = extractModelFromEvents(sessionDir);
          if (model) session.model = model;
        }

        sessions.push(session);
      } catch (err) {
        logger.debug({ sessionDir, err: (err as Error).message }, 'Skipping unparseable session');
      }
    }
  }

  // Sort by modifiedTime descending (most recent first)
  sessions.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));

  return sessions;
}

// ── Filter helper ───────────────────────────────────────

export interface SessionFilter {
  search?: string;
  liveOnly?: boolean;
  includeLinked?: boolean;
}

export function filterSessions(
  sessions: LocalSession[],
  filter: SessionFilter,
  linkedIds: Set<string>,
): LocalSession[] {
  return sessions.filter(s => {
    if (filter.liveOnly && !s.isLive) return false;
    if (!filter.includeLinked && linkedIds.has(s.sessionId)) return false;

    if (filter.search) {
      const q = filter.search.toLowerCase();
      const haystack = [
        s.cwd, s.gitRoot, s.repository, s.branch, s.summary, s.sessionId,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}
