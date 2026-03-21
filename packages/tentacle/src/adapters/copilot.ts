/**
 * Copilot SDK adapter for Kraki.
 *
 * Wraps `@github/copilot-sdk` and normalises Copilot CLI events
 * into the abstract `AgentAdapter` callback interface.
 *
 * Key responsibilities:
 *  - Manage the CopilotClient lifecycle (start/stop the CLI server)
 *  - Create/resume/kill sessions via the SDK
 *  - Wire SDK streaming events → `on*` callbacks
 *  - Implement the permission-request / question blocking pattern:
 *    the SDK handler returns a Promise that resolves when the
 *    remote user approves/denies/answers via the tentacle runtime.
 */

import type {
  CopilotClient as CopilotClientType,
  CopilotSession,
  SessionConfig,
  ResumeSessionConfig,
  MessageOptions,
  PermissionRequest,
  PermissionRequestResult,
  SessionMetadata,
} from '@github/copilot-sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
} from './base.js';
import { parsePermission } from '../parse-permission.js';
import { createLogger } from '../logger.js';

const logger = createLogger('copilot-adapter');
type CopilotClientCtor = typeof import('@github/copilot-sdk').CopilotClient;
let copilotClientCtorPromise: Promise<CopilotClientCtor> | null = null;

// ── Local type aliases for SDK handler params ───────────
// (UserInputRequest / UserInputResponse are not re-exported by the SDK)

interface UserInputRequest {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}

interface UserInputResponse {
  answer: string;
  wasFreeform: boolean;
}

// ── Types for internal bookkeeping ──────────────────────

/** Resolve function stored while a permission request is pending. */
interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  /** Tool kind from the SDK request (e.g. 'shell', 'write', 'read') */
  toolKind: string;
}

/** Resolve function stored while a question is pending. */
interface PendingQuestion {
  resolve: (result: UserInputResponse) => void;
}

/** Everything we track per session. */
interface SessionEntry {
  session: CopilotSession;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
}

// ── Helpers ─────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function patchCopilotSdkSessionImport(currentUrl: string = import.meta.url): boolean {
  const sessionPath = resolveCopilotSdkSessionPath(currentUrl);
  if (!sessionPath) {
    return false;
  }
  const source = readFileSync(sessionPath, 'utf8');
  const patched = source.replace(/from ['"]vscode-jsonrpc\/node['"]/g, 'from "vscode-jsonrpc/node.js"');

  if (patched === source) {
    return false;
  }

  writeFileSync(sessionPath, patched, 'utf8');
  return true;
}

export function resolveCopilotSdkSessionPath(currentUrl: string = import.meta.url): string | null {
  let dir = dirname(fileURLToPath(currentUrl));

  while (true) {
    const candidate = join(dir, 'node_modules', '@github', 'copilot-sdk', 'dist', 'session.js');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

async function loadCopilotClient(): Promise<CopilotClientCtor> {
  if (!copilotClientCtorPromise) {
    copilotClientCtorPromise = (async () => {
      try {
        if (patchCopilotSdkSessionImport()) {
          logger.info('Patched @github/copilot-sdk ESM import compatibility');
        }
      } catch {
        // If the SDK layout changes, let the dynamic import surface the real error.
      }

      try {
        const mod = await import('@github/copilot-sdk');
        return mod.CopilotClient;
      } catch (err) {
        copilotClientCtorPromise = null;
        throw err;
      }
    })();
  }

  return copilotClientCtorPromise;
}

// ── Adapter ─────────────────────────────────────────────

export class CopilotAdapter extends AgentAdapter {
  private client: CopilotClientType | null = null;
  private sessions = new Map<string, SessionEntry>();
  private cliPath: string | undefined;
  /** Per-session auto-approve sets (populated by "Always Allow" clicks) */
  private sessionAllowSets = new Map<string, Set<string>>();
  /** Session permission mode: 'ask' (default) or 'auto' */
  private sessionModes = new Map<string, 'ask' | 'auto'>();

  constructor(options: { cliPath?: string } = {}) {
    super();
    this.cliPath = options.cliPath;
  }

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    // Resolve GitHub token from `gh` CLI to bypass macOS Keychain prompts.
    let githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!githubToken) {
      try {
        githubToken = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
        if (githubToken) logger.info('Using GitHub token from `gh auth token`');
      } catch {
        // gh CLI unavailable — SDK will use its own auth chain
      }
    }

    const opts = {
      useLoggedInUser: false,
      ...(githubToken && { githubToken }),
      ...(this.cliPath && { cliPath: this.cliPath }),
    };

    const CopilotClient = await loadCopilotClient();
    this.client = new CopilotClient(opts);
    await this.client.start();
    logger.info('started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.sessions.clear();
    logger.info('stopped');
  }

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    this.ensureClient();

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();

    const sessionConfig: SessionConfig = {
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.model && { model: config.model }),
      ...(config.cwd && { workingDirectory: config.cwd }),
      streaming: true,
      onPermissionRequest: this.makePermissionHandler(pendingPermissions),
      onUserInputRequest: this.makeQuestionHandler(pendingQuestions),
    };

    const session = await this.client!.createSession(sessionConfig);
    const sid = session.sessionId;

    this.sessions.set(sid, { session, pendingPermissions, pendingQuestions });
    this.wireEvents(sid, session);

    logger.info(`session created: ${sid} (model: ${config.model ?? 'default'})`);

    this.onSessionCreated?.({
      sessionId: sid,
      agent: 'copilot',
      model: config.model,
    });

    return { sessionId: sid };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    this.ensureClient();

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();

    const resumeConfig: ResumeSessionConfig = {
      onPermissionRequest: this.makePermissionHandler(pendingPermissions),
      onUserInputRequest: this.makeQuestionHandler(pendingQuestions),
    };

    const session = await this.client!.resumeSession(sessionId, resumeConfig);

    this.sessions.set(sessionId, { session, pendingPermissions, pendingQuestions });
    this.wireEvents(sessionId, session);
    logger.info(`session resumed: ${sessionId}`);

    return { sessionId };
  }

  async sendMessage(sessionId: string, text: string, attachments?: string[]): Promise<void> {
    const entry = this.getSession(sessionId);
    const opts: MessageOptions = { prompt: text };
    if (attachments?.length) {
      opts.attachments = attachments.map((path) => ({ type: 'file' as const, path }));
    }
    await entry.session.send(opts);
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(`respondToPermission: session not found: ${sessionId}`);
      return;
    }
    const pending = entry.pendingPermissions.get(permissionId);
    if (!pending) {
      logger.warn(`respondToPermission: no pending permission: ${permissionId} (already resolved or timed out)`);
      return;
    }

    // For always_allow: add tool kind to session-scope allow set
    if (decision === 'always_allow' && pending.toolKind) {
      if (!this.sessionAllowSets.has(sessionId)) {
        this.sessionAllowSets.set(sessionId, new Set());
      }
      this.sessionAllowSets.get(sessionId)!.add(pending.toolKind);
      logger.info(`Always allow "${pending.toolKind}" for session ${sessionId}`);

      // Auto-approve any OTHER pending permissions of the same tool kind in this session
      for (const [otherId, otherPending] of entry.pendingPermissions) {
        if (otherId !== permissionId && otherPending.toolKind === pending.toolKind) {
          otherPending.resolve({ kind: 'approved' });
          entry.pendingPermissions.delete(otherId);
          this.onPermissionAutoResolved?.(sessionId, otherId);
          logger.info(`permission ${otherId}: auto-approved (same tool kind as always_allow)`);
        }
      }
    }

    const kindMap: Record<PermissionDecision, PermissionRequestResult> = {
      approve: { kind: 'approved' },
      deny: { kind: 'denied-interactively-by-user' },
      always_allow: { kind: 'approved' },
    };

    pending.resolve(kindMap[decision] ?? { kind: 'denied-interactively-by-user' });
    entry.pendingPermissions.delete(permissionId);
    logger.info(`permission ${permissionId}: ${decision}`);
  }

  async respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
    wasFreeform: boolean,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(`respondToQuestion: session not found: ${sessionId}`);
      return;
    }
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warn(`respondToQuestion: no pending question: ${questionId}`);
      return;
    }

    pending.resolve({ answer, wasFreeform });
    entry.pendingQuestions.delete(questionId);
    logger.info(`question ${questionId}: "${answer}" (freeform: ${wasFreeform})`);
  }

  async killSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      for (const [, p] of entry.pendingPermissions) p.resolve({ kind: 'denied-interactively-by-user' });
      for (const [, q] of entry.pendingQuestions) q.resolve({ answer: '', wasFreeform: true });
      await entry.session.abort().catch(() => {});
      await entry.session.disconnect();
      this.sessions.delete(sessionId);
    }
    this.cleanupSessionPermissions(sessionId);
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
    logger.info(`session killed: ${sessionId}`);
  }

  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      for (const [, p] of entry.pendingPermissions) p.resolve({ kind: 'denied-interactively-by-user' });
      for (const [, q] of entry.pendingQuestions) q.resolve({ answer: '', wasFreeform: true });
      entry.pendingPermissions.clear();
      entry.pendingQuestions.clear();
      await entry.session.abort();
      logger.info(`session aborted: ${sessionId}`);
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    if (!this.client) return [];
    const list: SessionMetadata[] = await this.client.listSessions();
    return list.map((s) => ({
      id: s.sessionId,
      state: this.sessions.has(s.sessionId) ? 'active' as const : 'ended' as const,
      model: undefined,
      cwd: s.context?.cwd,
      summary: s.summary ?? '',
    }));
  }

  async listModels(): Promise<string[]> {
    if (!this.client) return [];
    try {
      const models = await this.client.listModels();
      return models.map((m: { id: string }) => m.id);
    } catch {
      return [];
    }
  }

  /** Set permission mode for a session ('ask' or 'auto') */
  setSessionMode(sessionId: string, mode: 'ask' | 'auto'): void {
    this.sessionModes.set(sessionId, mode);
    logger.info(`Session ${sessionId} permission mode: ${mode}`);
  }

  /** Clean up session-scoped permission state */
  private cleanupSessionPermissions(sessionId: string): void {
    this.sessionAllowSets.delete(sessionId);
    this.sessionModes.delete(sessionId);
  }

  // ── SDK → callback wiring ─────────────────────────

  private wireEvents(sessionId: string, session: CopilotSession): void {
    session.on('assistant.message_delta', (event) => {
      this.onMessageDelta?.(sessionId, { content: event.data.deltaContent });
    });

    session.on('assistant.message', (event) => {
      // Skip empty messages (SDK sends these before tool calls)
      if (event.data.content) {
        this.onMessage?.(sessionId, { content: event.data.content });
      }
    });

    session.on('tool.execution_start', (event) => {
      const data = event.data as Record<string, unknown>;
      this.onToolStart?.(sessionId, {
        toolName: data.toolName as string,
        args: (data.args ?? data.arguments ?? {}) as Record<string, unknown>,
        toolCallId: data.toolCallId as string | undefined,
      });
    });

    session.on('tool.execution_complete', (event) => {
      const data = event.data as Record<string, unknown>;
      const rawResult = data.result;
      // SDK sends result as { content: string } or as a plain string
      const result = typeof rawResult === 'object' && rawResult !== null
        ? (rawResult as Record<string, unknown>).content as string ?? ''
        : (rawResult ?? data.output ?? '') as string;
      this.onToolComplete?.(sessionId, {
        toolName: data.toolName as string,
        result,
        toolCallId: data.toolCallId as string | undefined,
      });
    });

    session.on('session.idle', () => {
      this.onIdle?.(sessionId);
    });

    session.on('assistant.turn_end', (event) => {
      const data = event.data as Record<string, unknown>;
      const reason = data?.reason;
      if (reason === 'error') {
        this.onError?.(sessionId, {
          message: (data?.error as string) ?? 'Unknown agent error',
        });
      }
    });
  }

  // ── Permission handler factory ────────────────────

  private makePermissionHandler(pending: Map<string, PendingPermission>) {
    return (req: PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> | PermissionRequestResult => {
      const sessionId = invocation.sessionId;
      const toolKind = req.kind; // e.g. 'shell', 'write', 'read', 'url', 'mcp'

      // Layer 1: Auto mode — approve everything in this session
      if (this.sessionModes.get(sessionId) === 'auto') {
        logger.info(`permission auto-approved (auto mode): ${toolKind}`);
        return { kind: 'approved' };
      }

      // Layer 3: Session allow set — auto-approve if previously "Always Allowed"
      if (this.sessionAllowSets.get(sessionId)?.has(toolKind)) {
        logger.info(`permission auto-approved (session allow): ${toolKind}`);
        return { kind: 'approved' };
      }

      // Not auto-approved — send to relay for user decision
      const permId = makeId('perm');
      const parsed = parsePermission(req);

      logger.info(`permission [${permId}]: ${parsed.toolArgs.toolName} — ${parsed.description}`);

      this.onPermissionRequest?.(sessionId, {
        id: permId,
        ...parsed,
      });

      const promise = new Promise<PermissionRequestResult>((resolve) => {
        pending.set(permId, { resolve, toolKind });
      });

      return promise;
    };
  }

  // ── Question handler factory ──────────────────────

  private makeQuestionHandler(pending: Map<string, PendingQuestion>) {
    return (req: UserInputRequest, invocation: { sessionId: string }): Promise<UserInputResponse> => {
      const qId = makeId('q');

      logger.debug(`question [${qId}]: ${req.question}`);

      this.onQuestionRequest?.(invocation.sessionId, {
        id: qId,
        question: req.question ?? '',
        choices: req.choices ?? undefined,
        allowFreeform: req.allowFreeform !== false,
      });

      return new Promise<UserInputResponse>((resolve) => {
        pending.set(qId, { resolve });
      });
    };
  }

  // ── Guards ────────────────────────────────────────

  private ensureClient(): void {
    if (!this.client) throw new Error('Adapter not started — call start() first');
  }

  private getSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error(`Session not found: ${sessionId}`);
    return entry;
  }
}
