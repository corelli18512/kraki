/**
 * Claude Agent SDK adapter for Kraki.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` and normalises Claude Code events
 * into the abstract `AgentAdapter` callback interface.
 *
 * Key responsibilities:
 *  - Start `query()` sessions with streaming input for multi-turn conversation
 *  - Map SDKMessage stream → adapter `on*` callbacks
 *  - Implement permission control via `canUseTool` callback with Kraki's 4-mode system
 *  - Handle `AskUserQuestion` tool → `onQuestionRequest` with blocking Promise
 *  - Session lifecycle: create, resume, fork, kill, abort
 */

import type { SessionUsage, ModelDetail, Attachment } from '@kraki/protocol';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
} from './base.js';
import type { SessionContext } from '../session-manager.js';
import { createLogger } from '../logger.js';

const logger = createLogger('claude-adapter');

// ── Lazy SDK import types ───────────────────────────────
// We import the SDK dynamically so the module can be loaded even when
// @anthropic-ai/claude-agent-sdk is not installed — the adapter simply
// throws at start() in that case.

type SDKMessage = import('@anthropic-ai/claude-agent-sdk').SDKMessage;
type SDKAssistantMessage = import('@anthropic-ai/claude-agent-sdk').SDKAssistantMessage;
type SDKResultMessage = import('@anthropic-ai/claude-agent-sdk').SDKResultMessage;
type SDKSystemMessage = import('@anthropic-ai/claude-agent-sdk').SDKSystemMessage;
type SDKPartialAssistantMessage = import('@anthropic-ai/claude-agent-sdk').SDKPartialAssistantMessage;
type SDKUserMessage = import('@anthropic-ai/claude-agent-sdk').SDKUserMessage;
type Options = import('@anthropic-ai/claude-agent-sdk').Options;
type PermissionMode = import('@anthropic-ai/claude-agent-sdk').PermissionMode;
type Query = import('@anthropic-ai/claude-agent-sdk').Query;

/** Re-export the SDK's discriminated union for canUseTool return values. */
type PermissionResult = import('@anthropic-ai/claude-agent-sdk').PermissionResult;

// ── Types for internal bookkeeping ──────────────────────

interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  toolKind: string;
}

interface PendingQuestion {
  resolve: (result: PermissionResult) => void;
  questionId: string;
  /** Original questions payload from the SDK, echoed back in the answer. */
  questions?: unknown;
}

/** A message pushed into the streaming input channel. */
interface InputChannel {
  push(msg: SDKUserMessage): void;
  end(): void;
}

/** Everything we track per session. */
interface SessionEntry {
  query: Query | null;
  abortController: AbortController;
  inputChannel: InputChannel;
  pendingPermissions: Map<string, PendingPermission>;
  pendingQuestions: Map<string, PendingQuestion>;
  sessionId: string;
  model?: string;
  consumerLoop: Promise<void>;
  /** Deferred config — used to lazily spawn query() on first sendMessage */
  deferredConfig?: CreateSessionConfig & { resume?: string; fork?: boolean };
}

// ── Helpers ─────────────────────────────────────────────

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Map Claude SDK tool names to Kraki tool kinds (for permission tracking).
 * Returns the general category for "Always Allow" grouping.
 */
function toolNameToKind(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'shell';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return 'write';
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'read';
    case 'WebSearch':
    case 'WebFetch':
      return 'url';
    default:
      if (toolName.startsWith('mcp__')) return 'mcp';
      return toolName.toLowerCase();
  }
}

/**
 * Parse a Claude SDK tool call into Kraki protocol ToolArgs + description.
 */
function parseClaudeToolCall(toolName: string, input: Record<string, unknown>): {
  toolArgs: import('@kraki/protocol').ToolArgs;
  description: string;
} {
  switch (toolName) {
    case 'Bash': {
      const command = (input.command ?? input.cmd ?? '') as string;
      return {
        toolArgs: { toolName: 'shell', args: { command } },
        description: `Run: ${command}`,
      };
    }
    case 'Write': {
      const path = (input.file_path ?? input.path ?? '') as string;
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: (input.content ?? '') as string } },
        description: `Write: ${path}`,
      };
    }
    case 'Edit':
    case 'MultiEdit': {
      const path = (input.file_path ?? input.path ?? '') as string;
      return {
        toolArgs: { toolName: 'write_file', args: { path, content: '' } },
        description: `Edit: ${path}`,
      };
    }
    case 'Read': {
      const path = (input.file_path ?? input.path ?? '') as string;
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `Read: ${path}`,
      };
    }
    case 'Glob':
    case 'Grep':
    case 'LS': {
      const path = (input.path ?? input.pattern ?? '') as string;
      return {
        toolArgs: { toolName: 'read_file', args: { path } },
        description: `${toolName}: ${path}`,
      };
    }
    case 'WebSearch':
    case 'WebFetch': {
      const url = (input.url ?? input.query ?? '') as string;
      return {
        toolArgs: { toolName: 'fetch_url', args: { url } },
        description: `${toolName}: ${url}`,
      };
    }
    default: {
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.split('__');
        const server = parts[1] ?? 'unknown';
        const tool = parts.slice(2).join('__') || 'unknown';
        return {
          toolArgs: { toolName: 'mcp', args: { server, tool, params: input } },
          description: `MCP tool: ${tool} on ${server}`,
        };
      }
      return {
        toolArgs: { toolName, args: input },
        description: `${toolName}: ${JSON.stringify(input).slice(0, 200)}`,
      };
    }
  }
}

/**
 * Create a streaming input channel (AsyncIterable<SDKUserMessage>).
 * Messages pushed via `push()` are yielded by the async iterator.
 * Call `end()` to close the channel.
 */
function createInputChannel(): { iterable: AsyncIterable<SDKUserMessage>; channel: InputChannel } {
  let resolve: ((value: IteratorResult<SDKUserMessage>) => void) | null = null;
  const queue: SDKUserMessage[] = [];
  let done = false;

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
          }
          return new Promise<IteratorResult<SDKUserMessage>>((r) => { resolve = r; });
        },
      };
    },
  };

  const channel: InputChannel = {
    push(msg: SDKUserMessage) {
      if (done) return;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    end() {
      done = true;
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: undefined as unknown as SDKUserMessage, done: true });
      }
    },
  };

  return { iterable, channel };
}

// ── Adapter ─────────────────────────────────────────────

export class ClaudeAdapter extends AgentAdapter {
  private sessions = new Map<string, SessionEntry>();
  /** Per-session auto-approve sets (populated by "Always Allow" clicks) */
  private sessionAllowSets = new Map<string, Set<string>>();
  /** Session permission mode */
  private sessionModes = new Map<string, 'safe' | 'discuss' | 'execute' | 'delegate'>();
  /** Sessions with a pending mode change to prepend on next user message */
  private pendingModeSignals = new Map<string, string>();
  /** Per-session cumulative token usage */
  private sessionUsage = new Map<string, SessionUsage>();
  /** Cached model list from last session init */
  private cachedModels: ModelDetail[] = [];
  /** Track in-flight tool_use IDs per session for correlating tool_complete */
  private pendingToolCalls = new Map<string, Map<string, { toolName: string; args: Record<string, unknown> }>>();

  /** System prompt appended to Claude Code's built-in prompt. */
  private static readonly SYSTEM_PROMPT = [
    'You are running inside Kraki, a remote control platform. A human operator is',
    'monitoring and controlling your session from a separate device through an',
    'encrypted relay. Your tool calls are routed through a permission system that',
    'approves, denies, or prompts the operator depending on the current mode.',
    '',
    'There are four permission modes. **Sessions start in `discuss` mode by default.**',
    '',
    '- **safe**: Every tool call requires explicit operator approval, unless the',
    '  operator has previously clicked "Always Allow" for that tool kind (shell,',
    '  write, etc.) in the current session. Explain what you intend to do before',
    '  each action so the operator can decide.',
    '- **discuss**: Read operations, shell commands, web fetches, and MCP tools',
    '  are auto-approved. Write operations require operator approval — the',
    '  operator sees each write and can approve it, deny it, or switch to',
    '  execute mode. Exception: writes to a file named `plan.md` (in any',
    '  directory) are auto-approved.',
    '- **execute**: All tool calls are auto-approved. Be efficient and execute',
    '  directly without asking for confirmation. If unsure about intent or',
    '  approach, ask the operator for clarification before proceeding.',
    '- **delegate**: All tool calls are auto-approved. Questions you ask via',
    '  `ask_user` are auto-answered with `"proceed with your best judgment"` —',
    '  do not re-ask; just make a reasonable call and continue.',
    '',
    'The operator may switch modes during the session. When this happens, the',
    'next user message you receive will be prefixed with a signal in this format:',
    '',
    '    [kraki: mode changed to <mode>]',
    '',
    'Treat the signal as out-of-band metadata: silently adopt the new mode\'s',
    'behavior from that point onward, do not acknowledge or comment on the mode',
    'change, and do not quote the signal back. The text after the signal is the',
    'real user message.',
  ].join('\n');

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const useBedrock = process.env.CLAUDE_CODE_USE_BEDROCK === '1';
    const useVertex = process.env.CLAUDE_CODE_USE_VERTEX === '1';
    const useFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY === '1';
    const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN;

    if (!apiKey && !useBedrock && !useVertex && !useFoundry && !hasAuthToken) {
      throw new Error(
        'No Anthropic API key found. Set ANTHROPIC_API_KEY environment variable, ' +
        'or configure a third-party provider (CLAUDE_CODE_USE_BEDROCK=1, CLAUDE_CODE_USE_VERTEX=1, or CLAUDE_CODE_USE_FOUNDRY=1).'
      );
    }

    // Verify the SDK can be imported
    try {
      await import('@anthropic-ai/claude-agent-sdk');
    } catch {
      throw new Error(
        'Claude Agent SDK not found. Install it with: npm install @anthropic-ai/claude-agent-sdk'
      );
    }

    logger.info('Claude adapter started');
  }

  async stop(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      try {
        this.broadcastPendingResolutions(sessionId);
        entry.inputChannel.end();
        entry.abortController.abort();
      } catch {
        logger.warn({ sessionId }, 'Error stopping session during adapter shutdown');
      }
    }
    this.sessions.clear();
    logger.info('Claude adapter stopped');
  }

  // ── Session management ──────────────────────────────

  async createSession(config: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config.sessionId ?? `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      pendingPermissions,
      pendingQuestions,
      sessionId,
      model: config.model,
      consumerLoop: Promise.resolve(),
      deferredConfig: config,
    };

    this.sessions.set(sessionId, entry);
    logger.info({ sessionId, model: config.model }, 'session created (deferred — query starts on first message)');

    this.onSessionCreated?.({
      sessionId,
      agent: 'claude',
      model: config.model,
    });

    return { sessionId };
  }

  async resumeSession(sessionId: string): Promise<{ sessionId: string }> {
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      pendingPermissions,
      pendingQuestions,
      sessionId,
      consumerLoop: Promise.resolve(),
      deferredConfig: { resume: sessionId },
    };

    this.sessions.set(sessionId, entry);
    logger.info({ sessionId }, 'session resumed (deferred)');
    return { sessionId };
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<{ sessionId: string }> {
    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const abortController = new AbortController();
    const { iterable, channel } = createInputChannel();

    const entry: SessionEntry = {
      query: null,
      abortController,
      inputChannel: channel,
      pendingPermissions,
      pendingQuestions,
      sessionId: newSessionId,
      consumerLoop: Promise.resolve(),
      deferredConfig: { resume: sourceSessionId, fork: true, sessionId: newSessionId },
    };

    this.sessions.set(newSessionId, entry);

    this.onSessionCreated?.({
      sessionId: newSessionId,
      agent: 'claude',
    });

    logger.info({ sourceSessionId, newSessionId }, 'session forked (deferred)');
    return { sessionId: newSessionId };
  }

  async sendMessage(sessionId: string, text: string, _attachments?: Attachment[]): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'sendMessage: session not found');
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Prepend mode-switch signal if mode changed since last message
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `[kraki: mode changed to ${pendingMode}]\n\n${text}`;
    }

    // Lazily start the query on first message — the SDK binary needs a
    // prompt to work with, so we pass the first user message directly
    // instead of using the streaming input channel.
    if (!entry.query) {
      await this.spawnQuery(sessionId, text);
      return;
    }

    entry.inputChannel.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage);
  }

  /**
   * Spawn the SDK query() for a session. Called on first sendMessage
   * or when explicitly resuming.
   */
  private async spawnQuery(sessionId: string, initialPrompt?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;

    const { query: queryFn } = await import('@anthropic-ai/claude-agent-sdk');
    const config = entry.deferredConfig;
    const mode = this.sessionModes.get(sessionId) ?? 'discuss';

    const options: Options = {
      abortController: entry.abortController,
      ...(config?.model && { model: config.model }),
      ...(config?.cwd && { cwd: config.cwd }),
      ...(config?.resume && { resume: config.resume }),
      ...(config?.fork && { forkSession: true }),
      // Do NOT pass Kraki session IDs to the SDK — it requires UUIDs.
      // Let the SDK generate its own session ID; we track the mapping internally.
      permissionMode: 'default' as PermissionMode,
      tools: { type: 'preset' as const, preset: 'claude_code' as const },
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: ClaudeAdapter.SYSTEM_PROMPT },
      includePartialMessages: true,
      canUseTool: this.makeCanUseToolHandler(entry.pendingPermissions, entry.pendingQuestions),
      ...(config?.reasoningEffort && {
        effort: config.reasoningEffort as Options['effort'],
      }),
    };

    // Use direct prompt for first message, streaming input for subsequent
    const prompt = initialPrompt ?? entry.inputChannel;
    const q = queryFn({ prompt: prompt as string, options });

    entry.query = q;
    entry.deferredConfig = undefined;
    entry.consumerLoop = this.consumeMessages(sessionId, q);
    logger.debug({ sessionId }, 'SDK query spawned');
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    decision: PermissionDecision,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'respondToPermission: session not found');
      return;
    }
    const pending = entry.pendingPermissions.get(permissionId);
    if (!pending) {
      logger.warn({ permissionId }, 'respondToPermission: no pending permission');
      return;
    }

    // For always_allow: add tool kind to session-scope allow set
    if (decision === 'always_allow' && pending.toolKind) {
      if (!this.sessionAllowSets.has(sessionId)) {
        this.sessionAllowSets.set(sessionId, new Set());
      }
      this.sessionAllowSets.get(sessionId)!.add(pending.toolKind);
      logger.debug({ sessionId, toolKind: pending.toolKind }, 'Always allow enabled for tool kind');

      // Auto-approve other pending permissions of the same tool kind
      for (const [otherId, otherPending] of entry.pendingPermissions) {
        if (otherId !== permissionId && otherPending.toolKind === pending.toolKind) {
          otherPending.resolve({ behavior: 'allow', updatedInput: {} });
          entry.pendingPermissions.delete(otherId);
          this.onPermissionAutoResolved?.(sessionId, otherId, 'approved');
        }
      }
    }

    if (decision === 'approve' || decision === 'always_allow') {
      pending.resolve({ behavior: 'allow', updatedInput: {} });
    } else {
      pending.resolve({ behavior: 'deny', message: 'Denied by user' });
    }
    entry.pendingPermissions.delete(permissionId);
    logger.debug({ permissionId, sessionId, decision }, 'permission resolved');
  }

  async respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: string,
    _wasFreeform: boolean,
  ): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'respondToQuestion: session not found');
      return;
    }
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warn({ questionId }, 'respondToQuestion: no pending question');
      return;
    }

    pending.resolve({
      behavior: 'allow',
      updatedInput: {
        answers: { answer },
        ...(pending.questions ? { questions: pending.questions } : {}),
      },
    });
    entry.pendingQuestions.delete(questionId);
    logger.debug({ questionId, sessionId }, 'question answered');
  }

  async killSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.broadcastPendingResolutions(sessionId);
      entry.inputChannel.end();
      entry.abortController.abort();
      this.sessions.delete(sessionId);
    }
    this.cleanupSessionState(sessionId);
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
    logger.info({ sessionId }, 'session killed');
  }

  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      this.broadcastPendingResolutions(sessionId);
      if (entry.query) {
        try {
          await entry.query.interrupt();
        } catch {
          // Interrupt may fail if query already completed
        }
      }
      logger.debug({ sessionId }, 'session aborted');
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    try {
      const { listSessions: listSessionsFn } = await import('@anthropic-ai/claude-agent-sdk');
      const sessions = await listSessionsFn();
      return sessions.map((s) => ({
        id: s.sessionId,
        state: this.sessions.has(s.sessionId) ? 'active' as const : 'ended' as const,
        model: undefined,
        cwd: s.cwd,
        summary: s.summary ?? '',
      }));
    } catch {
      return [];
    }
  }

  async listModels(): Promise<string[]> {
    return this.cachedModels.map(m => m.id);
  }

  async listModelDetails(): Promise<ModelDetail[]> {
    return this.cachedModels;
  }

  setSessionMode(sessionId: string, mode: 'safe' | 'discuss' | 'execute' | 'delegate'): void {
    const prev = this.sessionModes.get(sessionId);
    this.sessionModes.set(sessionId, mode);
    if ((prev ?? 'discuss') !== mode) {
      this.pendingModeSignals.set(sessionId, mode);
    }

    // Also update SDK permission mode on the running query
    const entry = this.sessions.get(sessionId);
    if (entry?.query) {
      entry.query.setPermissionMode('default' as PermissionMode).catch((err) => {
        logger.warn({ err, sessionId }, 'Failed to set SDK permission mode');
      });
    }

    logger.debug({ sessionId, mode }, 'Session permission mode changed');
  }

  async setSessionModel(sessionId: string, model: string, _reasoningEffort?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'setSessionModel: session not found');
      return;
    }
    if (entry.query) {
      await entry.query.setModel(model);
    }
    entry.model = model;
    logger.info({ sessionId, model }, 'Session model changed');
  }

  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.sessionUsage.get(sessionId) ?? null;
  }

  setSessionUsage(sessionId: string, usage: SessionUsage): void {
    this.sessionUsage.set(sessionId, { ...usage });
  }

  // ── Title generation via throwaway query ──────────

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
    try {
      const { query: queryFn } = await import('@anthropic-ai/claude-agent-sdk');

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

      let title = '';
      const q = queryFn({
        prompt,
        options: {
          systemPrompt: ClaudeAdapter.TITLE_SYSTEM_PROMPT,
          maxTurns: 1,
          permissionMode: 'bypassPermissions' as PermissionMode,
          allowDangerouslySkipPermissions: true,
          persistSession: false,
        },
      });

      for await (const msg of q) {
        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage;
          title = (resultMsg as unknown as { result?: string }).result ?? '';
        }
      }

      title = title.replace(/^["']|["']$/g, '').replace(/^(Title|Session):\s*/i, '').replace(/[.!]$/, '').trim();
      title = title.split('\n')[0].trim();

      if (!title || title.length > 80) return null;
      return title;
    } catch (err) {
      logger.warn({ err }, 'Title generation failed');
      return null;
    }
  }

  // ── Message consumer loop ──────────────────────────

  /**
   * Consume the SDKMessage async generator and map messages to adapter callbacks.
   * Runs for the lifetime of the session query.
   */
  private async consumeMessages(sessionId: string, q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        try {
          this.handleSDKMessage(sessionId, msg);
        } catch (err) {
          logger.error({ err, sessionId, type: msg.type }, 'Error handling SDK message');
        }
      }

      // Query completed normally
      this.onIdle?.(sessionId);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.debug({ sessionId }, 'Session query aborted');
        return;
      }
      logger.error({ err, sessionId }, 'Session consumer loop error');
      this.onError?.(sessionId, { message: getErrorMessage(err) });
      this.onSessionEnded?.(sessionId, { reason: 'error' });
    }
  }

  /**
   * Route a single SDKMessage to the appropriate adapter callback.
   */
  private handleSDKMessage(sessionId: string, msg: SDKMessage): void {
    switch (msg.type) {
      case 'system': {
        const sysMsg = msg as SDKSystemMessage & { subtype?: string };
        if (sysMsg.subtype === 'init') {
          const sdkSessionId = sysMsg.session_id;
          if (sdkSessionId && sdkSessionId !== sessionId) {
            const entry = this.sessions.get(sessionId);
            if (entry) entry.sessionId = sdkSessionId;
          }
          this.cacheModelsFromInit(sysMsg);
          logger.debug({ sessionId, sdkSessionId }, 'SDK session initialized');
        }
        break;
      }

      case 'assistant': {
        const assistantMsg = msg as SDKAssistantMessage;
        if (assistantMsg.error) {
          this.onError?.(sessionId, {
            message: `Claude API error: ${typeof assistantMsg.error === 'string' ? assistantMsg.error : JSON.stringify(assistantMsg.error)}`,
          });
          break;
        }

        const betaMessage = assistantMsg.message;
        if (!betaMessage?.content) break;

        for (const block of betaMessage.content) {
          if (block.type === 'text' && (block as { text?: string }).text) {
            this.onMessage?.(sessionId, { content: (block as { text: string }).text });
          } else if (block.type === 'tool_use') {
            const toolBlock = block as { name: string; input?: Record<string, unknown>; id: string };
            const args = (toolBlock.input ?? {}) as Record<string, unknown>;

            // Track tool call for correlating with tool result
            let sessionTools = this.pendingToolCalls.get(sessionId);
            if (!sessionTools) {
              sessionTools = new Map();
              this.pendingToolCalls.set(sessionId, sessionTools);
            }
            sessionTools.set(toolBlock.id, { toolName: toolBlock.name, args });

            this.onToolStart?.(sessionId, {
              toolName: toolBlock.name,
              args,
              toolCallId: toolBlock.id,
            });
          }
        }

        // Track usage
        if (betaMessage.usage) {
          this.updateUsage(sessionId, betaMessage.usage as unknown as Record<string, unknown>);
        }
        break;
      }

      case 'stream_event': {
        const partial = msg as SDKPartialAssistantMessage;
        const event = partial.event as unknown as Record<string, unknown>;

        if (event.type === 'content_block_delta') {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            this.onMessageDelta?.(sessionId, { content: delta.text });
          }
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        const resultAny = result as unknown as Record<string, unknown>;

        if (resultAny.is_error) {
          const errors = resultAny.errors as string[] | undefined;
          const errorMsg = errors?.join('; ') || (resultAny.subtype as string) || 'Unknown error';
          this.onError?.(sessionId, { message: errorMsg });
        }

        // Update final usage
        if (resultAny.usage) {
          const u = resultAny.usage as Record<string, unknown>;
          const prev = this.sessionUsage.get(sessionId) ?? {
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0,
            totalCost: 0, totalDurationMs: 0,
          };
          const updated: SessionUsage = {
            inputTokens: (u.input_tokens as number) ?? prev.inputTokens,
            outputTokens: (u.output_tokens as number) ?? prev.outputTokens,
            cacheReadTokens: (u.cache_read_input_tokens as number) ?? prev.cacheReadTokens,
            cacheWriteTokens: (u.cache_creation_input_tokens as number) ?? prev.cacheWriteTokens,
            totalCost: (resultAny.total_cost_usd as number) ?? prev.totalCost,
            totalDurationMs: ((resultAny.duration_ms as number) ?? 0) + (prev.totalDurationMs ?? 0),
          };
          this.sessionUsage.set(sessionId, updated);
          this.onUsageUpdate?.(sessionId, updated);
        }

        this.onIdle?.(sessionId);
        break;
      }

      case 'user': {
        // User messages include tool_result content blocks when tools complete.
        // Extract tool results and fire tool_complete callbacks.
        const userMsg = msg as SDKUserMessage;
        const userMessage = userMsg.message as { content?: unknown };
        if (Array.isArray(userMessage?.content)) {
          for (const block of userMessage.content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              const toolCallId = b.tool_use_id;
              const tracked = this.pendingToolCalls.get(sessionId)?.get(toolCallId);

              let result = '';
              if (typeof b.content === 'string') {
                result = b.content;
              } else if (Array.isArray(b.content)) {
                result = (b.content as Array<Record<string, unknown>>)
                  .filter(c => c.type === 'text' && typeof c.text === 'string')
                  .map(c => c.text as string)
                  .join('\n');
              }

              this.onToolComplete?.(sessionId, {
                toolName: tracked?.toolName ?? 'tool',
                result,
                toolCallId,
                success: !b.is_error,
              });

              this.pendingToolCalls.get(sessionId)?.delete(toolCallId);
            }
          }
        }
        break;
      }

      default:
        // Ignore other message types (status, auth_status, etc.)
        break;
    }
  }

  // ── Permission handler ────────────────────────────

  /**
   * Create the `canUseTool` callback for the Claude Agent SDK.
   * Implements Kraki's 4-mode permission system.
   */
  private makeCanUseToolHandler(
    pendingPermissions: Map<string, PendingPermission>,
    pendingQuestions: Map<string, PendingQuestion>,
  ) {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        suggestions?: Array<{ type: string; [key: string]: unknown }>;
        title?: string;
        displayName?: string;
        description?: string;
        toolUseID: string;
        agentID?: string;
      },
    ): Promise<PermissionResult> => {
      const sessionId = this.findSessionForToolCall();
      if (!sessionId) {
        logger.warn({ toolName }, 'canUseTool: no active session found');
        return { behavior: 'deny', message: 'No active session' };
      }

      // Handle AskUserQuestion tool → bridge to onQuestionRequest
      if (toolName === 'AskUserQuestion') {
        return this.handleAskUserQuestion(sessionId, input, pendingQuestions);
      }

      const toolKind = toolNameToKind(toolName);
      const mode = this.sessionModes.get(sessionId) ?? 'discuss';

      // Mode-based auto-approval
      if (mode === 'execute' || mode === 'delegate') {
        logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
        return { behavior: 'allow', updatedInput: input };
      }

      // Discuss mode: auto-approve reads, shell, url, mcp. Writes need approval (except plan.md).
      if (mode === 'discuss') {
        if (toolKind !== 'write') {
          logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
          return { behavior: 'allow', updatedInput: input };
        }
        // Write in discuss mode — check allow list
        const filePath = ((input.file_path ?? input.path ?? '') as string);
        const DISCUSS_MODE_WRITE_ALLOW_LIST = ['plan.md'];
        const allowed = DISCUSS_MODE_WRITE_ALLOW_LIST.some(
          (f) => filePath.endsWith('/' + f) || filePath === f,
        );
        if (allowed) {
          return { behavior: 'allow', updatedInput: input };
        }
        // Non-allowed writes fall through to the permission prompt below
      }

      // Check session-scoped always-allow sets
      if (this.sessionAllowSets.get(sessionId)?.has(toolKind)) {
        logger.debug({ sessionId, toolKind }, 'permission auto-approved (session allow set)');
        return { behavior: 'allow', updatedInput: input };
      }

      // Not auto-approved — send to relay for user decision
      const permId = makeId('perm');
      const parsed = parseClaudeToolCall(toolName, input);

      logger.debug({
        permissionId: permId,
        sessionId,
        toolKind,
        toolName,
      }, 'permission requested');

      this.onPermissionRequest?.(sessionId, {
        id: permId,
        ...parsed,
      });

      return new Promise<PermissionResult>((resolve) => {
        pendingPermissions.set(permId, { resolve, toolKind });
      });
    };
  }

  /**
   * Handle the AskUserQuestion tool by bridging to onQuestionRequest.
   */
  private handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    pendingQuestions: Map<string, PendingQuestion>,
  ): Promise<PermissionResult> {
    const mode = this.sessionModes.get(sessionId) ?? 'discuss';

    // Delegate mode: auto-answer questions
    if (mode === 'delegate') {
      logger.debug({ sessionId }, 'question auto-answered (delegate mode)');
      return Promise.resolve({
        behavior: 'allow',
        updatedInput: {
          questions: input.questions,
          answers: { answer: 'proceed with your best judgment' },
        },
      });
    }

    const qId = makeId('q');
    const questions = input.questions as Array<{
      question: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> | undefined;

    const firstQuestion = questions?.[0];
    const questionText = firstQuestion?.question ?? (input.question as string) ?? 'The agent has a question';
    const choices = firstQuestion?.options?.map(o => o.label);

    logger.debug({
      questionId: qId,
      sessionId,
      choicesCount: choices?.length ?? 0,
    }, 'question requested');

    this.onQuestionRequest?.(sessionId, {
      id: qId,
      question: questionText,
      choices,
      allowFreeform: true,
    });

    return new Promise<PermissionResult>((resolve) => {
      pendingQuestions.set(qId, { resolve, questionId: qId, questions: input.questions });
    });
  }

  // ── Helpers ───────────────────────────────────────

  private findSessionForToolCall(): string | undefined {
    for (const [sessionId] of this.sessions) {
      return sessionId;
    }
    return undefined;
  }

  private cleanupSessionState(sessionId: string): void {
    this.sessionAllowSets.delete(sessionId);
    this.sessionModes.delete(sessionId);
    this.pendingModeSignals.delete(sessionId);
    this.sessionUsage.delete(sessionId);
    this.pendingToolCalls.delete(sessionId);
  }

  private broadcastPendingResolutions(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    for (const [permId, p] of entry.pendingPermissions) {
      p.resolve({ behavior: 'deny', message: 'Session ended' });
      this.onPermissionAutoResolved?.(sessionId, permId, 'cancelled');
    }
    entry.pendingPermissions.clear();
    for (const [qId, q] of entry.pendingQuestions) {
      q.resolve({ behavior: 'allow', updatedInput: { answers: { answer: '' } } });
      this.onQuestionAutoResolved?.(sessionId, qId);
    }
    entry.pendingQuestions.clear();
  }

  private updateUsage(sessionId: string, usage: Record<string, unknown>): void {
    const prev = this.sessionUsage.get(sessionId) ?? {
      inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0,
      totalCost: 0, totalDurationMs: 0,
    };
    const updated: SessionUsage = {
      inputTokens: prev.inputTokens + ((usage.input_tokens as number) ?? 0),
      outputTokens: prev.outputTokens + ((usage.output_tokens as number) ?? 0),
      cacheReadTokens: prev.cacheReadTokens + ((usage.cache_read_input_tokens as number) ?? 0),
      cacheWriteTokens: prev.cacheWriteTokens + ((usage.cache_creation_input_tokens as number) ?? 0),
      totalCost: prev.totalCost,
      totalDurationMs: prev.totalDurationMs,
    };
    this.sessionUsage.set(sessionId, updated);
    this.onUsageUpdate?.(sessionId, updated);
  }

  private cacheModelsFromInit(sysMsg: SDKSystemMessage): void {
    try {
      const models = (sysMsg as unknown as { models?: Array<{ id: string; name?: string }> }).models;
      if (Array.isArray(models) && models.length > 0) {
        this.cachedModels = models.map(m => ({
          id: m.id,
          name: m.name ?? m.id,
          supportsReasoningEffort: true,
        }));
      }
    } catch {
      // Models not available in init message — that's fine
    }
  }
}
