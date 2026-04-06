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
  MCPServerConfig,
} from '@github/copilot-sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, unlinkSync } from 'node:fs';
import * as moduleApi from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSea } from 'node:sea';
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

const VSCODE_JSONRPC_NODE_SPECIFIER = 'vscode-jsonrpc/node';
const VSCODE_JSONRPC_NODE_JS_SPECIFIER = 'vscode-jsonrpc/node.js';
const COPILOT_SDK_COMPATIBILITY_LOADER_SOURCE = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === ${JSON.stringify(VSCODE_JSONRPC_NODE_SPECIFIER)}) {
    return nextResolve(${JSON.stringify(VSCODE_JSONRPC_NODE_JS_SPECIFIER)}, context);
  }
  return nextResolve(specifier, context);
}
`.trim();

type ModuleApiCompat = typeof moduleApi & {
  register?: (specifier: string, parentURL?: string) => void;
  registerHooks?: (hooks: {
    resolve: (
      specifier: string,
      context: Readonly<Record<string, unknown>>,
      nextResolve: (
        specifier: string,
        context: Readonly<Record<string, unknown>>,
      ) => unknown,
    ) => unknown;
  }) => void;
};

const moduleCompat = moduleApi as ModuleApiCompat;

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

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function getRuntimeUrl(): string {
  const scriptPath = process.argv[1];
  return pathToFileURL(scriptPath ?? process.execPath).href;
}

function resolveExecutableFromPath(commandName: string): string | undefined {
  const lookupCommand =
    process.platform === 'win32'
      ? `where.exe ${commandName} 2>NUL`
      : `command -v ${commandName} 2>/dev/null`;

  try {
    const output = execSync(lookupCommand, { encoding: 'utf8' }).trim();
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

function isRecoverableSessionError(err: unknown): boolean {
  const message = getErrorMessage(err);
  return message.includes('Session not found:') || message.includes('Connection is disposed');
}

export function patchCopilotSdkSessionImport(currentUrl: string = getRuntimeUrl()): boolean {
  const sessionPath = resolveCopilotSdkSessionPath(currentUrl);
  if (!sessionPath) {
    return false;
  }
  const source = readFileSync(sessionPath, 'utf8');
  const patched = source.replace(
    /from ['"]vscode-jsonrpc\/node['"]/g,
    `from "${VSCODE_JSONRPC_NODE_JS_SPECIFIER}"`,
  );

  if (patched === source) {
    return false;
  }

  writeFileSync(sessionPath, patched, 'utf8');
  return true;
}

export function resolveCopilotSdkSessionPath(currentUrl: string = getRuntimeUrl()): string | null {
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

export function installCopilotSdkImportCompatibility(currentUrl: string = getRuntimeUrl()): 'hook' | 'patch' | null {
  if (typeof moduleCompat.registerHooks === 'function') {
    moduleCompat.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === VSCODE_JSONRPC_NODE_SPECIFIER) {
          return nextResolve(VSCODE_JSONRPC_NODE_JS_SPECIFIER, context);
        }
        return nextResolve(specifier, context);
      },
    });
    return 'hook';
  }

  if (typeof moduleCompat.register === 'function') {
    moduleCompat.register(
      `data:text/javascript,${encodeURIComponent(COPILOT_SDK_COMPATIBILITY_LOADER_SOURCE)}`,
      currentUrl,
    );
    return 'hook';
  }

  if (isSea()) {
    return null;
  }

  if (patchCopilotSdkSessionImport(currentUrl)) {
    return 'patch';
  }

  return null;
}

async function loadCopilotClient(): Promise<CopilotClientCtor> {
  if (!copilotClientCtorPromise) {
    copilotClientCtorPromise = (async () => {
      const compatibility = installCopilotSdkImportCompatibility();
      if (compatibility === 'hook') {
        logger.debug('Installed @github/copilot-sdk ESM import compatibility hook');
      } else if (compatibility === 'patch') {
        logger.debug('Patched @github/copilot-sdk ESM import compatibility');
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
  /** Session permission mode */
  private sessionModes = new Map<string, 'safe' | 'discuss' | 'execute' | 'delegate'>();
  /** Sessions with a pending mode change to prepend on next user message */
  private pendingModeSignals = new Map<string, string>();
  /** Per-session cumulative token usage */
  private sessionUsage = new Map<string, import('@kraki/protocol').SessionUsage>();

  constructor(options: { cliPath?: string } = {}) {
    super();
    this.cliPath = options.cliPath;
  }

  /** System prompt appended to the SDK's built-in prompt. See system-prompt.md for docs. */
  private static readonly SYSTEM_PROMPT = [
    'You are running inside Kraki, a remote control platform. A human operator is',
    'monitoring and controlling your session from a separate device through an',
    'encrypted relay. Your tool calls are routed through a permission system that',
    'approves, denies, or prompts the operator depending on the current mode.',
    '',
    'There are four permission modes. Sessions start in discuss mode by default.',
    '',
    '- **safe**: Every tool call requires explicit operator approval, unless the',
    '  operator has previously clicked "Always Allow" for that tool kind in the',
    '  current session. Explain what you intend to do before each action so the',
    '  operator can decide.',
    '- **discuss**: Read operations are auto-approved. Write operations are',
    '  auto-denied (returns denial feedback); except `plan.md` (auto-approve).',
    '  Discuss proposed changes before attempting writes.',
    '  Do not use shell commands (sed, tee, echo >, scripts, etc.) to modify',
    '  files — use the edit/create tools instead.',
    '- **execute**: All tool calls are auto-approved. Be efficient and execute',
    '  directly without asking for confirmation. If unsure about intent or',
    '  approach, ask the operator for clarification before proceeding.',
    '- **delegate**: All tool calls are auto-approved and questions are',
    '  auto-answered on your behalf. Work fully autonomously — do not expect',
    '  interactive input.',
    '',
    'The operator may switch modes during the session. When this happens, your next',
    'message will begin with a mode switch signal in this format:',
    '',
    '    [kraki: mode changed to <mode>]',
    '',
    'When you see this signal, silently adopt the new mode\'s behavior from that',
    'point onward. Do not acknowledge or comment on the mode change — just adjust',
    'how you work. The signal is not part of the user\'s message.',
  ].join('\n');

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    // Resolve GitHub token from `gh` CLI to bypass macOS Keychain prompts.
    let githubToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!githubToken) {
      try {
        githubToken = execSync('gh auth token 2>/dev/null', { encoding: 'utf8' }).trim() || undefined;
        if (githubToken) logger.debug('Using GitHub token from `gh auth token`');
      } catch {
        // gh CLI unavailable — SDK will use its own auth chain
      }
    }

    const cliPath = this.cliPath ?? resolveCopilotCliPath();
    if (!cliPath && isSea()) {
      throw new Error('Copilot CLI not found on PATH. Install GitHub Copilot CLI so `copilot` is available.');
    }

    const opts = {
      useLoggedInUser: false,
      ...(githubToken && { githubToken }),
      ...(cliPath && { cliPath }),
    };

    const CopilotClient = await loadCopilotClient();
    this.client = new CopilotClient(opts);
    await this.client.start();
    logger.debug('started');
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.sessions.clear();
    logger.debug('stopped');
  }

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    this.ensureClient();

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();

    // Load MCP server config and inject into session
    const mcpConfigPath = join(homedir(), '.copilot', 'mcp-config.json');
    let mcpServers: Record<string, MCPServerConfig> | undefined;
    if (existsSync(mcpConfigPath)) {
      try {
        const mcpRaw = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
        const rawServers = mcpRaw.mcpServers ?? {};
        const serverNames = Object.keys(rawServers);
        if (serverNames.length > 0) {
          // CLI requires `tools` field on each server — default to all tools
          mcpServers = {};
          for (const [name, cfg] of Object.entries(rawServers)) {
            mcpServers[name] = { ...(cfg as MCPServerConfig), tools: (cfg as MCPServerConfig & { tools?: string[] }).tools ?? ['*'] };
          }
          logger.info(`MCP config found: ${serverNames.length} server(s) [${serverNames.join(', ')}]`);
        }
      } catch (err) {
        logger.warn(`MCP config exists but failed to parse: ${(err as Error).message}`);
      }
    } else {
      logger.info('No MCP config at ~/.copilot/mcp-config.json');
    }

    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
    const effort = config.reasoningEffort && validEfforts.has(config.reasoningEffort)
      ? config.reasoningEffort as SessionConfig['reasoningEffort']
      : undefined;

    const sessionConfig: SessionConfig = {
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.model && { model: config.model }),
      ...(effort && { reasoningEffort: effort }),
      ...(config.cwd && { workingDirectory: config.cwd }),
      configDir: join(homedir(), '.copilot'),
      ...(mcpServers && { mcpServers }),
      systemMessage: { mode: 'append' as const, content: CopilotAdapter.SYSTEM_PROMPT },
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
    await this.resumeTrackedSession(sessionId);
    return { sessionId };
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const sdkStateDir = join(homedir(), '.copilot', 'session-state');
    const srcDir = join(sdkStateDir, sourceSessionId);
    const dstDir = join(sdkStateDir, newSessionId);

    // Copy SDK session state if it exists
    if (existsSync(srcDir)) {
      cpSync(srcDir, dstDir, { recursive: true });

      // Update the session ID in workspace.yaml
      const yamlPath = join(dstDir, 'workspace.yaml');
      if (existsSync(yamlPath)) {
        let yaml = readFileSync(yamlPath, 'utf8');
        yaml = yaml.replace(/^id:\s*.+$/m, `id: ${newSessionId}`);
        writeFileSync(yamlPath, yaml, 'utf8');
      }

      // Rewrite all session ID references in events.jsonl so the SDK
      // treats this as a fully independent session (not a shared conversation).
      const eventsPath = join(dstDir, 'events.jsonl');
      if (existsSync(eventsPath)) {
        let events = readFileSync(eventsPath, 'utf8');
        events = events.replaceAll(sourceSessionId, newSessionId);
        writeFileSync(eventsPath, events, 'utf8');
      }
    }

    // Resume the forked session via SDK
    await this.resumeTrackedSession(newSessionId);
    logger.info({ sourceSessionId, newSessionId }, 'session forked');

    // Notify relay so it broadcasts session_created to all arms
    this.onSessionCreated?.({
      sessionId: newSessionId,
      agent: 'copilot',
    });

    return { sessionId: newSessionId };
  }

  async sendMessage(sessionId: string, text: string, attachments?: import('@kraki/protocol').Attachment[]): Promise<void> {
    // Prepend mode-switch signal if mode changed since last message
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `[kraki: mode changed to ${pendingMode}]\n\n${text}`;
    }

    const opts: MessageOptions = { prompt: text };
    const tempFiles: string[] = [];

    // Convert image attachments to files in the SDK session directory
    if (attachments?.length) {
      const entry = this.sessions.get(sessionId);
      const sdkFilesDir = entry
        ? join(homedir(), '.copilot', 'session-state', sessionId, 'files')
        : tmpdir();
      const sdkAttachments: Array<{ type: 'file'; path: string; displayName?: string }> = [];
      for (const att of attachments) {
        if (att.type === 'image') {
          const ext = att.mimeType === 'image/png' ? '.png' : att.mimeType === 'image/webp' ? '.webp' : '.jpg';
          const fileName = `kraki-img-${Date.now()}${ext}`;
          const filePath = join(sdkFilesDir, fileName);
          mkdirSync(sdkFilesDir, { recursive: true });
          writeFileSync(filePath, Buffer.from(att.data, 'base64'));
          if (!entry) tempFiles.push(filePath);
          sdkAttachments.push({ type: 'file' as const, path: filePath, displayName: fileName });
        }
      }
      if (sdkAttachments.length) opts.attachments = sdkAttachments as MessageOptions['attachments'];
    }

    let entry = this.getSession(sessionId);

    try {
      await entry.session.send(opts);
      return;
    } catch (err) {
      if (!isRecoverableSessionError(err)) {
        this.onError?.(sessionId, { message: getErrorMessage(err) });
        throw err;
      }

      logger.warn({ err, sessionId }, 'Session send failed; attempting resume');

      try {
        entry = await this.resumeTrackedSession(sessionId);
      } catch (resumeErr) {
        this.handleUnavailableSession(sessionId, resumeErr);
        throw resumeErr;
      }

      try {
        await entry.session.send(opts);
      } catch (retryErr) {
        if (isRecoverableSessionError(retryErr)) {
          this.handleUnavailableSession(sessionId, retryErr);
        } else {
          this.onError?.(sessionId, { message: getErrorMessage(retryErr) });
        }
        throw retryErr;
      }
    } finally {
      for (const f of tempFiles) {
        try { unlinkSync(f); } catch { /* best effort */ }
      }
    }
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
      logger.debug({ sessionId, toolKind: pending.toolKind }, 'Always allow enabled for tool kind');

      // Auto-approve any OTHER pending permissions of the same tool kind in this session
      for (const [otherId, otherPending] of entry.pendingPermissions) {
        if (otherId !== permissionId && otherPending.toolKind === pending.toolKind) {
          otherPending.resolve({ kind: 'approved' });
          entry.pendingPermissions.delete(otherId);
          this.onPermissionAutoResolved?.(sessionId, otherId, 'approved');
          logger.debug({ permissionId: otherId, sessionId, toolKind: pending.toolKind }, 'permission auto-approved');
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
    logger.debug({ permissionId, sessionId, decision }, 'permission resolved');
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
  }

  async killSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.broadcastPendingResolutions(sessionId);
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
      this.broadcastPendingResolutions(sessionId);
      await entry.session.abort();
      logger.debug({ sessionId }, 'session aborted');
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

  async listModelDetails(): Promise<import('@kraki/protocol').ModelDetail[]> {
    if (!this.client) return [];
    try {
      const models = await this.client.listModels();
      return models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsReasoningEffort: m.capabilities?.supports?.reasoningEffort ?? false,
        ...(m.supportedReasoningEfforts && { supportedReasoningEfforts: m.supportedReasoningEfforts }),
        ...(m.defaultReasoningEffort && { defaultReasoningEffort: m.defaultReasoningEffort }),
      }));
    } catch {
      return [];
    }
  }

  /** Set permission mode for a session */
  setSessionMode(sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate'): void {
    const prev = this.sessionModes.get(sessionId);
    this.sessionModes.set(sessionId, mode);
    if ((prev ?? 'discuss') !== mode) {
      this.pendingModeSignals.set(sessionId, mode);
    }
    logger.debug({ sessionId, mode }, 'Session permission mode changed');
  }

  /** Change model for a session via SDK */
  async setSessionModel(sessionId: string, model: string, _reasoningEffort?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'setSessionModel: session not found');
      return;
    }
    await entry.session.setModel(model);
    logger.info({ sessionId, model }, 'Session model changed');
  }

  /** Get current cumulative usage for a session */
  getSessionUsage(sessionId: string): import('@kraki/protocol').SessionUsage | null {
    return this.sessionUsage.get(sessionId) ?? null;
  }

  /** Restore persisted usage totals on session resume */
  setSessionUsage(sessionId: string, usage: import('@kraki/protocol').SessionUsage): void {
    this.sessionUsage.set(sessionId, { ...usage });
  }

  /** Clean up session-scoped permission state */
  private cleanupSessionPermissions(sessionId: string): void {
    this.sessionAllowSets.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.pendingModeSignals.delete(sessionId);
    this.sessionUsage.delete(sessionId);
  }

  /** Resolve all pending permissions/questions and fire callbacks so relay-client broadcasts resolutions. */
  private broadcastPendingResolutions(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    for (const [permId, p] of entry.pendingPermissions) {
      p.resolve({ kind: 'denied-interactively-by-user' });
      this.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
    }
    entry.pendingPermissions.clear();
    for (const [qId, q] of entry.pendingQuestions) {
      q.resolve({ answer: '', wasFreeform: true });
      this.onQuestionAutoResolved?.(sessionId, qId);
    }
    entry.pendingQuestions.clear();
  }

  private makeResumeConfig(
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

    return {
      configDir: join(homedir(), '.copilot'),
      streaming: true,
      ...(mcpServers && { mcpServers }),
      systemMessage: { mode: 'append' as const, content: CopilotAdapter.SYSTEM_PROMPT },
      onPermissionRequest: this.makePermissionHandler(pendingPermissions),
      onUserInputRequest: this.makeQuestionHandler(pendingQuestions),
    };
  }

  private async resumeTrackedSession(sessionId: string): Promise<SessionEntry> {
    this.ensureClient();

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const session = await this.client!.resumeSession(
      sessionId,
      this.makeResumeConfig(pendingPermissions, pendingQuestions),
    );
    const entry = { session, pendingPermissions, pendingQuestions };

    this.sessions.set(sessionId, entry);
    this.wireEvents(sessionId, session);
    logger.debug({ sessionId }, 'session resumed');

    return entry;
  }

  private handleUnavailableSession(sessionId: string, err: unknown): void {
    this.broadcastPendingResolutions(sessionId);

    this.sessions.delete(sessionId);
    this.cleanupSessionPermissions(sessionId);
    logger.warn({ err, sessionId }, 'Session became unavailable');
    this.onError?.(sessionId, {
      message: 'Session is no longer active in Copilot. Please start a new session.',
    });
    this.onSessionEnded?.(sessionId, { reason: 'session unavailable' });
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
      if (data.mcpServerName) {
        logger.info({ mcpServer: data.mcpServerName, mcpTool: data.mcpToolName }, `[MCP tool] ${data.mcpServerName}/${data.mcpToolName}`);
      }
      this.onToolStart?.(sessionId, {
        toolName: data.toolName as string,
        args: (data.args ?? data.arguments ?? {}) as Record<string, unknown>,
        toolCallId: data.toolCallId as string | undefined,
      });
    });

    session.on('tool.execution_complete', (event) => {
      const data = event.data as Record<string, unknown>;
      const rawResult = data.result;
      // SDK sends result as { content: string, contents?: [...] } or as a plain string
      const resultObj = typeof rawResult === 'object' && rawResult !== null
        ? rawResult as Record<string, unknown>
        : null;
      const result = resultObj?.content as string ?? (typeof rawResult === 'string' ? rawResult : (data.output as string ?? ''));

      // Extract image attachments from structured content blocks (result.contents)
      const attachments: import('@kraki/protocol').Attachment[] = [];
      const contentBlocks = resultObj?.contents as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(contentBlocks)) {
        for (const block of contentBlocks) {
          if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
            attachments.push({ type: 'image', data: block.data as string, mimeType: block.mimeType as string });
          }
        }
      }

      this.onToolComplete?.(sessionId, {
        toolName: data.toolName as string,
        result,
        toolCallId: data.toolCallId as string | undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
    });

    session.on('session.idle', () => {
      this.onIdle?.(sessionId);
    });

    session.on('session.info', (event) => {
      const data = event.data as Record<string, unknown>;
      const category = data.category as string | undefined;
      if (category === 'mcp') {
        logger.info(`[MCP] ${data.message}`);
      } else {
        logger.debug(`[info:${category}] ${data.message}`);
      }
    });

    session.on('session.warning', (event) => {
      const data = event.data as Record<string, unknown>;
      const category = data.category as string | undefined;
      logger.warn(`[warning:${category}] ${data.message}`);
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

    session.on('session.title_changed', (event) => {
      const data = event.data as Record<string, unknown>;
      const title = data?.title as string | undefined;
      if (title) {
        this.onTitleChanged?.(sessionId, title);
      }
    });

    session.on('assistant.usage', (event) => {
      const data = event.data as Record<string, unknown>;
      const prev = this.sessionUsage.get(sessionId) ?? {
        inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0,
        totalCost: 0, totalDurationMs: 0,
      };
      const updated = {
        inputTokens: prev.inputTokens + ((data.inputTokens as number) ?? 0),
        outputTokens: prev.outputTokens + ((data.outputTokens as number) ?? 0),
        cacheReadTokens: prev.cacheReadTokens + ((data.cacheReadTokens as number) ?? 0),
        cacheWriteTokens: prev.cacheWriteTokens + ((data.cacheWriteTokens as number) ?? 0),
        totalCost: prev.totalCost + ((data.cost as number) ?? 0),
        totalDurationMs: prev.totalDurationMs + ((data.duration as number) ?? 0),
      };
      this.sessionUsage.set(sessionId, updated);
      this.onUsageUpdate?.(sessionId, updated);
    });
  }

  // ── Permission handler factory ────────────────────

  private makePermissionHandler(pending: Map<string, PendingPermission>) {
    return (req: PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> | PermissionRequestResult => {
      const sessionId = invocation.sessionId;
      const toolKind = req.kind; // e.g. 'shell', 'write', 'read', 'url', 'mcp'
      const mode = this.sessionModes.get(sessionId) ?? 'discuss';

      // Mode-based auto-approval
      if (mode === 'execute' || mode === 'delegate') {
        logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
        return { kind: 'approved' };
      }
      if (mode === 'discuss' && toolKind !== 'write') {
        logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
        return { kind: 'approved' };
      }
      if (mode === 'discuss' && toolKind === 'write') {
        const filePath = ((req.fileName ?? req.path ?? '') as string);
        // Allow list: files that can be written in Discuss mode
        const DISCUSS_MODE_WRITE_ALLOW_LIST = ['plan.md'];
        const allowed = DISCUSS_MODE_WRITE_ALLOW_LIST.some(
          (f) => filePath.endsWith('/' + f) || filePath === f,
        );
        if (allowed) {
          logger.debug({ sessionId, toolKind, mode, filePath }, 'write auto-approved (discuss mode allow list)');
          return { kind: 'approved' };
        }
        logger.debug({ sessionId, toolKind, mode, filePath }, 'write denied (discuss mode)');
        return { kind: 'denied-interactively-by-user', feedback: 'No edit allowed in Discuss mode. Switch to Execute mode to make changes.' };
      }
      if (this.sessionAllowSets.get(sessionId)?.has(toolKind)) {
        logger.debug({ sessionId, toolKind }, 'permission auto-approved (session allow set)');
        return { kind: 'approved' };
      }

      // Not auto-approved — send to relay for user decision
      const permId = makeId('perm');
      const parsed = parsePermission(req);

      logger.debug({
        permissionId: permId,
        sessionId,
        toolKind,
        toolName: parsed.toolArgs.toolName,
      }, 'permission requested');

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
    return (req: UserInputRequest, invocation: { sessionId: string }): Promise<UserInputResponse> | UserInputResponse => {
      const sessionId = invocation.sessionId;
      const mode = this.sessionModes.get(sessionId) ?? 'discuss';

      // Delegate mode: auto-answer questions
      if (mode === 'delegate') {
        logger.debug({ sessionId }, 'question auto-answered (delegate mode)');
        return { answer: 'proceed with your best judgment', wasFreeform: true };
      }

      const qId = makeId('q');

      logger.debug({
        questionId: qId,
        sessionId,
        choicesCount: req.choices?.length ?? 0,
        allowFreeform: req.allowFreeform !== false,
      }, 'question requested');

      this.onQuestionRequest?.(sessionId, {
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

  // ── Title generation via throwaway session ────────

  private static readonly TITLE_SYSTEM_PROMPT = [
    'You generate concise titles for coding sessions.',
    'The title should reflect what the user is CURRENTLY working on, not the full history.',
    'If the topic changed, use the most recent topic.',
    '',
    'Rules:',
    '- 4-10 words, under 50 characters',
    '- Describe the current task concisely',
    '- No quotes, no punctuation at the end, no prefixes',
    '- Just the title text, nothing else',
  ].join('\n');

  async generateTitle(context: { firstUserMessage: string; lastUserMessage?: string; recentMessages?: string[]; currentTitle?: string }): Promise<string | null> {
    if (!this.client) return null;

    // Build prompt focused on recent context
    let prompt: string;
    if (context.recentMessages && context.recentMessages.length > 1) {
      const recent = context.recentMessages.map((m, i) => `${i + 1}. ${m.slice(0, 200)}`).join('\n');
      prompt = `Generate a title based on the most recent user messages (most recent first):\n\n${recent}`;
      if (context.currentTitle) {
        prompt += `\n\nCurrent title for reference: "${context.currentTitle}"`;
      }
      prompt += '\n\nTitle should reflect the CURRENT topic.';
    } else {
      prompt = `Generate a title for: "${(context.lastUserMessage ?? context.firstUserMessage).slice(0, 500)}"`;
      if (context.currentTitle) {
        prompt += `\n\nCurrent title for reference: "${context.currentTitle}"`;
      }
    }

    let session: CopilotSession | null = null;
    try {
      logger.debug('Creating throwaway session for title generation');
      session = await this.client.createSession({
        configDir: join(homedir(), '.copilot'),
        systemMessage: { mode: 'replace' as const, content: CopilotAdapter.TITLE_SYSTEM_PROMPT },
        streaming: true,
        onPermissionRequest: () => ({ kind: 'approved' as const }),
        onUserInputRequest: () => ({ answer: '', wasFreeform: true }),
      });
      logger.debug({ throwawayId: session.sessionId }, 'Throwaway session created, sending prompt');

      const response = await session.sendAndWait({ prompt }, 15_000);
      let title = (response?.data?.content ?? '').trim();
      // Clean up: strip quotes, trailing punctuation, "Title:" prefix
      title = title.replace(/^["']|["']$/g, '').replace(/^(Title|Session):\s*/i, '').replace(/[.!]$/, '').trim();
      logger.debug({ throwawayId: session.sessionId, title: title.slice(0, 80) }, 'Throwaway session responded');

      // Take only the first line if multi-line
      title = title.split('\n')[0].trim();

      if (!title || title.length > 80) return null;
      return title;
    } catch (err) {
      logger.warn({ err }, 'Title generation failed');
      return null;
    } finally {
      if (session) {
        const throwawayId = session.sessionId;
        logger.debug({ throwawayId }, 'Cleaning up throwaway session');
        await session.disconnect().catch(() => {});
        await this.client?.deleteSession(throwawayId).catch(() => {});
      }
    }
  }
}
