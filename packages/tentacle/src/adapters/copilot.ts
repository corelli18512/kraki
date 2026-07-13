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
  ContextTier,
} from '@github/copilot-sdk';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, cpSync, mkdtempSync, mkdirSync, unlinkSync, readdirSync, symlinkSync, lstatSync, statSync, renameSync } from 'node:fs';
import * as moduleApi from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { getKrakiHome } from '../config.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isSea } from 'node:sea';
import {
  AgentAdapter,
  type CreateSessionConfig,
  type SessionInfo,
  type PermissionDecision,
  type QuestionAnswer,
  type QuestionResponseResult,
  type SendMessageOptions,
} from './base.js';
import { parsePermission } from '../parse-permission.js';
import { createLogger } from '../logger.js';
import { isKrakiSelfManagementCommand, SELF_MANAGEMENT_DENIAL_REASON, shellCommandFromInput } from '../self-management-guard.js';

const logger = createLogger('copilot-adapter');
type CopilotSdkModule = typeof import('@github/copilot-sdk');
let copilotSdkPromise: Promise<CopilotSdkModule> | null = null;

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
function basenameSafe(p: string): string {
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

const PERMISSIONS_CONFIG_FILE = 'permissions-config.json';
const EMPTY_PERMISSIONS = JSON.stringify({ locations: {} });
let cachedCopilotConfigDir: string | null = null;

function getCopilotConfigDir(): string {
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
        const src = join(realCopilotDir, entry);
        const dest = join(shadowDir, entry);
        try {
          // Remove stale symlink / file (lstatSync doesn't follow symlinks)
          lstatSync(dest);
          unlinkSync(dest);
        } catch { /* dest doesn't exist */ }
        try {
          symlinkSync(src, dest);
        } catch { /* best effort */ }
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

async function loadCopilotSdk(): Promise<CopilotSdkModule> {
  if (!copilotSdkPromise) {
    copilotSdkPromise = (async () => {
      const compatibility = installCopilotSdkImportCompatibility();
      if (compatibility === 'hook') {
        logger.debug('Installed @github/copilot-sdk ESM import compatibility hook');
      } else if (compatibility === 'patch') {
        logger.debug('Patched @github/copilot-sdk ESM import compatibility');
      }

      try {
        return await import('@github/copilot-sdk');
      } catch (err) {
        copilotSdkPromise = null;
        throw err;
      }
    })();
  }

  return copilotSdkPromise;
}

// ── Adapter ─────────────────────────────────────────────

export class CopilotAdapter extends AgentAdapter {
  private client: CopilotClientType | null = null;
  /** Serialises rebuildClient() so concurrent callers don't spawn multiple runtimes. */
  private rebuildingClient: Promise<void> | null = null;
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
  /** Fallback idle timers — fire onIdle if SDK doesn't emit session.idle after turn_end */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Track tool start args by toolCallId for correlating with tool_complete */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  /**
   * Tool identity captured at tool.execution_start, keyed by toolCallId.
   * The Copilot SDK omits these fields from tool.execution_complete events —
   * only toolCallId is present there. We stash the names on start and look
   * them up on complete (especially for `mcpServerName`/`mcpToolName`, which
   * we use to recognise our own MCP presenter tools).
   */
  private pendingToolIdentity = new Map<string, {
    toolName?: string;
    mcpServerName?: string;
    mcpToolName?: string;
  }>();
  /**
   * Tool calls in flight per session — reverse index so we can clean up
   * pendingToolArgs/pendingToolIdentity when a session ends without each
   * tool call completing (kill, abort, error mid-flight). Without this the
   * two maps grow unbounded over a long-lived daemon.
   */
  private sessionToolCallIds = new Map<string, Set<string>>();
  /** Expected model per session — detects involuntary model fallbacks by the CLI */
  private expectedModels = new Map<string, string>();
  /** User's originally requested model — never updated on involuntary fallbacks */
  private userRequestedModels = new Map<string, string>();
  /** Whether the current turn has produced any output (message or tool call) */
  private turnHasOutput = new Map<string, boolean>();
  /** Whether the current user-message-to-idle cycle had any output */
  private cycleHasOutput = new Map<string, boolean>();
  /** Whether an error was already reported for the current turn */
  private turnErrorReported = new Map<string, boolean>();
  /** Whether the current cycle was interrupted by an explicit user-initiated
   *  abort. Suppresses empty-cycle detection — the user asked for the turn
   *  to stop, so producing no output is the expected outcome, not a failure. */
  private cycleUserAborted = new Map<string, boolean>();
  /**
   * Buffered assistant prose for the current turn (draft-bubble model).
   * Accumulates assistant.message content; flushed as narration when a tool
   * follows, or as the single conclusion bubble (onMessage) when the turn ends.
   */
  private pendingNarration = new Map<string, string>();
  /**
   * Grace period (ms) after assistant.turn_end before firing a fallback idle.
   * The Copilot CLI has a known bug where session.idle is sometimes not emitted
   * after abort-during-tool-execution (github/copilot-sdk#794, #558, #1057).
   * Measured P99 turn_end→turn_start gap is <5ms; 500ms is a safe margin.
   */
  private static readonly IDLE_FALLBACK_MS = 500;

  /** Max time to wait for a single session.abort() during adapter.stop().
   *  If exceeded we fall through and let client.stop() kill the SDK process.
   *  At worst we get the legacy orphaned tool_use behavior for that session;
   *  any cleanly-aborted sessions still benefit. */
  private static readonly STOP_ABORT_TIMEOUT_MS = 2_000;

  /** Max time to wait for getAuthStatus during probeRuntime before assuming the
   *  runtime is wedged/dead. Picked so a transient slow RPC is still tolerated
   *  but a hung runtime doesn't stall every recovery attempt. */
  private static readonly PROBE_RUNTIME_TIMEOUT_MS = 5_000;

  // ── Idle-session eviction ────────────────────────────
  // Long-lived daemon → working set grows over time as more sessions get
  // lazy-resumed and then sit idle. To bound runtime memory we periodically
  // sweep the loaded set:
  //   - skip if total runtime RSS is below the threshold (do nothing when
  //     memory is fine — eviction is adaptive, not eager)
  //   - skip any session that's mid-turn or has a pending permission/question
  //     (would be rude to drop while the user is waiting)
  //   - evict sessions that have been quiet longer than IDLE_TTL_MS
  // The evicted session's on-disk state is intact; next user interaction
  // triggers the existing lazy-resume path (relay-client ensureSessionResumed).
  private static readonly EVICTION_SCAN_INTERVAL_MS = 5 * 60_000;
  private static readonly EVICTION_RSS_THRESHOLD_MB = 2048;
  private static readonly EVICTION_IDLE_TTL_MS = 30 * 60_000;
  /** Per-session "last time anything happened" timestamp (ms epoch). Used
   *  by the eviction sweep to identify candidates. Updated by sendMessage,
   *  every SDK event handler, and permission/question responses. */
  private lastActivityAt = new Map<string, number>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  /** Models known to support long_context tier (updated from Copilot docs).
   *  Used to populate supportedContextTiers in model details. */
  private static readonly LONG_CONTEXT_MODELS = new Set([
    'claude-sonnet-4.6',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.5',
    'gemini-3.1-pro-preview',
  ]);

  /** Set of attachment ids already broadcast for this session — prevents
   *  re-broadcasting bytes when the same image is shown twice. */
  private broadcastedAttachmentIds = new Map<string, Set<string>>();

  constructor(options: {
    cliPath?: string;
    /** Tentacle's attachment store. When set, the adapter externalises
     *  image bytes from `kraki-show_image` to it instead of carrying them
     *  inline in the broadcast envelope. */
    attachmentStore?: import('../attachment-store.js').AttachmentStore;
    /** When set, the adapter wires the Kraki MCP server into every Copilot
     *  session it creates/resumes, with the URL scoped per Kraki sessionId. */
    krakiMcp?: {
      urlForSession: (sessionId: string) => string;
      bearerToken: string;
    };
  } = {}) {
    super();
    this.cliPath = options.cliPath;
    this.attachmentStore = options.attachmentStore;
    this.krakiMcp = options.krakiMcp;
  }

  private readonly attachmentStore?: import('../attachment-store.js').AttachmentStore;
  private readonly krakiMcp?: {
    urlForSession: (sessionId: string) => string;
    bearerToken: string;
  };

  /** System prompt appended to the SDK's built-in prompt. See system-prompt.md for docs. */
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

  /**
   * Appended to the system prompt when the Kraki MCP server is wired in.
   * Tools are exposed to the model with display names of the form
   * `<server>-<tool>` (dash), confirmed via a live SDK spike.
   */
  private static readonly KRAKI_MCP_PROMPT = [
    'You have access to a Kraki MCP server. Its tools are visible with names',
    'beginning with "kraki-".',
    '',
    '**Default to `view` for any image you need to inspect.** `view` feeds the',
    'bytes to your vision; the user does NOT see it in their chat UI. This is',
    'the right choice for:',
    '- Screenshots of the user\'s own device (via ADB, iOS simulator, their',
    '  phone) — they are already looking at the device.',
    '- An image the user just attached or sent you — they already have it.',
    '- Any image file you read to inform your own reasoning.',
    '',
    '**Only call `kraki-show_image` when the user cannot already see the image',
    'and would gain new information from seeing it.** Typical cases:',
    '- A diagram or chart you just generated (mermaid, graphviz, plot).',
    '- A mockup or UI you designed for the user to review.',
    '- A file from your own machine the user has no other way to look at.',
    '',
    'When in doubt, use `view`. Echoing back an image the user can already see',
    'clutters the chat and re-encodes bytes for no benefit.',
    '',
    'Self-knowledge limit: `kraki-show_image` returns only a short text',
    'confirmation to you, not the image bytes. After a long session your older',
    'turns may be summarized, so you may not be able to introspect which tool',
    'you used on which file. If a user asks about your past behavior and you',
    'cannot directly verify it in your current context, say so explicitly',
    'rather than confidently assert from incomplete memory.',
  ].join('\n');

  // ── Lifecycle ───────────────────────────────────────

  async start(): Promise<void> {
    // Note: orphaned runtime processes from un-gracefully killed daemons
    // (SIGKILL / OS OOM-kill) are not auto-reaped here. The pgrep+ppid
    // heuristics we previously tried either matched nothing or risked
    // killing the user's independent `copilot` CLI. Graceful shutdown
    // (daemon-worker.ts) prevents the common case; if the daemon dies
    // un-gracefully, the user can `kill` the stray runtime by hand.
    //
    // Always prefer useLoggedInUser: true — the copilot CLI server manages
    // its own credential store (keychain) and silently refreshes the ~8h
    // access token for the lifetime of the daemon. Injecting a static gh
    // token bypasses this and causes silent auth death when it expires.

    let cliPath = this.cliPath ?? resolveCopilotCliPath();
    if (!cliPath && isSea()) {
      // At boot, PATH tools (nvm, copilot) may not be ready yet.
      // Retry for up to 30s before giving up.
      const deadline = Date.now() + 30_000;
      while (!cliPath && Date.now() < deadline) {
        logger.debug('Copilot CLI not found yet, retrying...');
        await new Promise(r => setTimeout(r, 2_000));
        cliPath = resolveCopilotCliPath();
      }
      if (!cliPath) {
        throw new Error('Copilot CLI not found on PATH. Install GitHub Copilot CLI so `copilot` is available.');
      }
    }

    // On Windows, resolve the actual .js entry point from the .cmd wrapper.
    // Node spawn() can't execute .cmd files, and the SDK handles .js files natively.
    if (cliPath && process.platform === 'win32' && !cliPath.endsWith('.js') && !cliPath.endsWith('.exe')) {
      const cmdPath = cliPath.endsWith('.cmd') ? cliPath : cliPath + '.cmd';
      if (existsSync(cmdPath)) {
        try {
          const cmdContent = readFileSync(cmdPath, 'utf8');
          const match = cmdContent.match(/"%dp0%\\(.+\.js)"/);
          if (match) {
            const jsPath = join(dirname(cmdPath), match[1]);
            if (existsSync(jsPath)) {
              cliPath = jsPath;
              logger.debug({ cliPath }, 'Resolved Windows .cmd to .js entry point');
            }
          }
        } catch { /* fall through to original path */ }
      }
    }

    // In SEA mode, process.execPath is the SEA binary, not node.exe.
    // The SDK uses process.execPath to spawn .js files — override it temporarily.
    let restoreExecPath: (() => void) | null = null;
    if (isSea() && cliPath?.endsWith('.js')) {
      try {
        const nodePath = execSync(
          process.platform === 'win32' ? 'where node' : 'command -v node',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
        ).trim().split(/\r?\n/)[0];
        if (nodePath && existsSync(nodePath)) {
          const origExecPath = process.execPath;
          Object.defineProperty(process, 'execPath', { value: nodePath, writable: true, configurable: true });
          restoreExecPath = () => { Object.defineProperty(process, 'execPath', { value: origExecPath, writable: true, configurable: true }); };
          logger.debug({ nodePath }, 'Overriding process.execPath for Copilot SDK');
        }
      } catch { /* can't find node — SDK will use process.execPath */ }
    }

    // copilot-sdk 1.0.x takes the CLI path via a RuntimeConnection — the old
    // top-level `cliPath` option is silently ignored. Pass the resolved path
    // explicitly so the SDK never falls back to its `getBundledCliPath()`,
    // which uses `createRequire(bundlePath).resolve.paths('@github/copilot')`
    // and finds nothing inside a SEA binary (no node_modules tree beside the
    // bundle). When the path is unresolved we omit the connection so the SDK
    // can apply its own COPILOT_CLI_PATH / bundled fallback.
    const { CopilotClient, RuntimeConnection } = await loadCopilotSdk();
    const opts = {
      useLoggedInUser: true,
      ...(cliPath && { connection: RuntimeConnection.forStdio({ path: cliPath }) }),
    };
    logger.debug({ isSea: isSea(), cliPath: cliPath ?? null }, 'starting CopilotClient');

    this.client = new CopilotClient(opts);
    await this.client.start();
    if (restoreExecPath) restoreExecPath();
    this.startEvictionSweep();
    logger.debug('started');
  }

  async stop(): Promise<void> {
    this.stopEvictionSweep();
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();

    // Abort all active sessions first so the SDK writes a clean `abort` event
    // to events.jsonl for any in-flight tool_use. Without this, killing the
    // client mid-turn leaves the conversation history with an orphaned
    // tool_use block, and Claude rejects the next resume with
    // `messages.N: tool_use ids were found without tool_result blocks`.
    // Each abort is guarded by a short timeout so a hung session doesn't
    // hang shutdown — at worst we still get the legacy bad behavior for that
    // one session, no worse than today.
    const sessionIds = Array.from(this.sessions.keys());
    if (sessionIds.length > 0) {
      logger.debug({ count: sessionIds.length }, 'aborting active sessions before stop');
      await Promise.all(sessionIds.map(async (sessionId) => {
        try {
          await Promise.race([
            this.abortSession(sessionId),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('abort timeout')), CopilotAdapter.STOP_ABORT_TIMEOUT_MS),
            ),
          ]);
        } catch (err) {
          logger.warn({ err, sessionId }, 'pre-stop abort failed');
        }
      }));
    }

    if (this.client) {
      await this.client.stop();
      this.client = null;
    }
    this.sessions.clear();
    this.lastActivityAt.clear();
    logger.debug('stopped');
  }

  /**
   * Tear down the dead runtime and spawn a fresh one.
   *
   * All existing SDK sessions are invalidated (they referenced the old
   * runtime process). The caller must re-resume individual sessions after
   * this returns. Concurrent callers share a single rebuild.
   *
   * Any pending permission/question requests across all sessions are
   * cancelled first so the arm UI doesn't get stuck waiting for an answer
   * the dead runtime will never deliver.
   */
  async rebuildClient(): Promise<void> {
    if (this.rebuildingClient) return this.rebuildingClient;
    this.rebuildingClient = (async () => {
      logger.warn('Rebuilding CopilotClient after runtime death');
      try {
        // Resolve all pending permissions/questions across every session
        // BEFORE clearing the entries — otherwise the arm UI stays stuck on
        // a request that will never be answered (the old runtime is dead).
        for (const sessionId of this.sessions.keys()) {
          this.broadcastPendingResolutions(sessionId);
        }
        if (this.client) {
          try { await this.client.stop(); } catch { /* old client may already be dead */ }
          this.client = null;
        }
        // All SDK session handles are now invalid
        this.sessions.clear();
        this.lastActivityAt.clear();
        await this.start();
        logger.info('CopilotClient rebuilt successfully');
      } finally {
        this.rebuildingClient = null;
      }
    })();
    return this.rebuildingClient;
  }

  // ── Idle-session eviction ────────────────────────────

  /**
   * Sum RSS (MB) of this process plus every descendant. The real memory
   * consumer is the native `copilot-darwin-arm64` grandchild, not the
   * daemon's Node heap — so we walk the whole tree and report the total.
   *
   * Returns null on Windows (no pgrep) or when the descendant walk fails;
   * callers treat null as "skip eviction this cycle" (fail-safe).
   */
  private getRuntimeRssMB(): number | null {
    if (process.platform === 'win32') return null;
    const descendants: number[] = [];
    const queue: number[] = [process.pid];
    while (queue.length) {
      const pid = queue.shift()!;
      try {
        const out = execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        if (!out) continue;
        for (const line of out.split('\n')) {
          const child = parseInt(line, 10);
          if (!isNaN(child)) {
            descendants.push(child);
            queue.push(child);
          }
        }
      } catch { /* pgrep exits non-zero when no children — normal */ }
    }
    if (descendants.length === 0) return 0;
    try {
      const out = execSync(`ps -o rss= -p ${descendants.join(',')}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const kb = out.split('\n')
        .map((s) => parseInt(s.trim(), 10))
        .reduce((acc, v) => acc + (isNaN(v) ? 0 : v), 0);
      return Math.round(kb / 1024);
    } catch {
      return null;
    }
  }

  private startEvictionSweep(): void {
    if (this.evictionTimer) return;
    this.evictionTimer = setInterval(() => {
      this.evictIdleSessions().catch((err) => {
        logger.warn({ err }, 'eviction sweep threw');
      });
    }, CopilotAdapter.EVICTION_SCAN_INTERVAL_MS);
    // Don't block process exit on the timer
    this.evictionTimer.unref?.();
  }

  private stopEvictionSweep(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }

  /**
   * Periodic sweep: if total runtime RSS is over threshold, evict any
   * loaded session that has been quiet > IDLE_TTL_MS and is safe to drop
   * (not mid-turn, no pending permission/question).
   *
   * Eviction is purely a memory hygiene operation; the user-visible session
   * is unaffected because the next interaction triggers lazy resume.
   */
  private async evictIdleSessions(): Promise<void> {
    if (this.sessions.size === 0) return;
    const rssMB = this.getRuntimeRssMB();
    if (rssMB === null || rssMB < CopilotAdapter.EVICTION_RSS_THRESHOLD_MB) {
      // Under the threshold (or measurement unavailable) — do nothing.
      // This is deliberately adaptive: when memory is fine, never evict.
      return;
    }

    const now = Date.now();
    const ttl = CopilotAdapter.EVICTION_IDLE_TTL_MS;
    const candidates: string[] = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.pendingPermissions.size > 0 || entry.pendingQuestions.size > 0) continue;
      // turnHasOutput.get(sessionId) === true => a turn is currently in flight
      if (this.turnHasOutput.get(sessionId)) continue;
      const lastAt = this.lastActivityAt.get(sessionId) ?? 0;
      if (now - lastAt < ttl) continue;
      candidates.push(sessionId);
    }
    if (candidates.length === 0) {
      logger.info({ rssMB, loaded: this.sessions.size }, 'eviction: over threshold but no eligible candidates');
      return;
    }
    logger.info(
      { rssMB, threshold: CopilotAdapter.EVICTION_RSS_THRESHOLD_MB, candidates: candidates.length, loaded: this.sessions.size },
      'eviction: sweeping idle sessions',
    );
    for (const sessionId of candidates) {
      await this.evictSession(sessionId);
    }
  }

  /**
   * Release an idle SDK session handle so the runtime can reclaim its
   * memory. The on-disk session is intact; lazy resume picks it up on
   * next interaction. Fires {@link onSessionEvicted} so the relay-client
   * can mark the meta state `disconnected` for invariant consistency.
   */
  private async evictSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    try {
      await entry.session.disconnect();
    } catch (err) {
      logger.warn({ err, sessionId }, 'evictSession: disconnect failed, removing entry anyway');
    }
    this.sessions.delete(sessionId);
    this.lastActivityAt.delete(sessionId);
    this.clearIdleTimer(sessionId);
    // Note: we intentionally do NOT clear sessionModes / sessionUsage /
    // expectedModels — those represent persistent per-session preferences
    // that should survive the unload/reload cycle.
    logger.info({ sessionId }, 'session evicted from runtime (idle, over RSS threshold)');
    this.onSessionEvicted?.(sessionId);
  }

  private touchSession(sessionId: string): void {
    this.lastActivityAt.set(sessionId, Date.now());
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

    const contextTier = config.contextTier === 'long_context'
      ? 'long_context' as ContextTier
      : undefined;

    // Two-phase MCP wiring: create session WITHOUT kraki MCP server first
    // (we need the SDK-assigned sessionId to scope the MCP URL), then the
    // adapter re-wires through resumeSession with the kraki entry below.
    // For simplicity in v1 we use a deterministic Kraki MCP wire-up:
    // we let the SDK pick the session id, then on every Copilot session
    // we add the kraki MCP at resume time. For initial creation we pre-pick
    // a session id when the caller supplied one; otherwise the kraki MCP
    // is added on the next message via resumeSession during normal flow.
    //
    // Simpler approach: register a Kraki MCP server using the *Copilot*
    // sessionId only after createSession returns it. To do that without
    // a second SDK call, we use a placeholder sessionId for the initial
    // mcpServers entry and rewrite via resume on first use. But that's
    // brittle — instead, see the comment block at the constructor: the
    // kraki MCP HTTP server validates sessionId by checking SessionManager,
    // not by Copilot SDK state, so we can ALWAYS include the kraki entry
    // here by using a stable session-scoped URL that the adapter knows
    // up-front via config.sessionId (the Kraki session id we assigned).
    if (this.krakiMcp && config.sessionId) {
      const krakiEntry: MCPServerConfig = {
        type: 'http' as const,
        url: this.krakiMcp.urlForSession(config.sessionId),
        headers: { Authorization: `Bearer ${this.krakiMcp.bearerToken}` },
        tools: ['*'],
      } as MCPServerConfig;
      mcpServers = { ...(mcpServers ?? {}), kraki: krakiEntry };
      logger.info({ sessionId: config.sessionId }, 'wired kraki MCP into session config');
    }

    const systemPromptContent = this.krakiMcp
      ? `${CopilotAdapter.SYSTEM_PROMPT}\n\n${CopilotAdapter.KRAKI_MCP_PROMPT}`
      : CopilotAdapter.SYSTEM_PROMPT;

    const sessionConfig: SessionConfig = {
      ...(config.sessionId && { sessionId: config.sessionId }),
      ...(config.model && { model: config.model }),
      ...(effort && { reasoningEffort: effort }),
      ...(contextTier && { contextTier }),
      ...(config.cwd && { workingDirectory: config.cwd }),
      configDirectory: getCopilotConfigDir(),
      ...(mcpServers && { mcpServers }),
      systemMessage: { mode: 'append' as const, content: systemPromptContent },
      streaming: true,
      onPermissionRequest: this.makePermissionHandler(pendingPermissions),
      onUserInputRequest: this.makeQuestionHandler(pendingQuestions),
    };

    const session = await this.client!.createSession(sessionConfig);
    const sid = session.sessionId;

    this.sessions.set(sid, { session, pendingPermissions, pendingQuestions });
    this.touchSession(sid);
    this.wireEvents(sid, session);
    this.linkCopilotStore(sid);
    logger.info(`session created: ${sid} (model: ${config.model ?? 'default'})`);
    if (config.model) {
      this.expectedModels.set(sid, config.model);
      this.userRequestedModels.set(sid, config.model);
    }
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

  async sendMessage(
    sessionId: string,
    text: string,
    attachments?: import('@kraki/protocol').Attachment[],
    options?: SendMessageOptions,
  ): Promise<void> {
    if (options?.delivery !== 'steer') {
      // A normal prompt starts a fresh cycle. An immediate interjection remains
      // part of the active cycle and must not reset its output/error tracking.
      this.cycleHasOutput.set(sessionId, false);
      this.turnErrorReported.set(sessionId, false);
      this.cycleUserAborted.delete(sessionId);
      this.pendingNarration.delete(sessionId);
    }
    this.touchSession(sessionId);

    // Prepend mode-switch signal if mode changed since last message
    const pendingMode = this.pendingModeSignals.get(sessionId);
    if (pendingMode) {
      this.pendingModeSignals.delete(sessionId);
      text = `[kraki: mode changed to ${pendingMode}]\n\n${text}`;
    }

    const opts: MessageOptions = {
      prompt: text,
      ...(options?.delivery === 'steer' && { mode: 'immediate' as const }),
    };
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

    try {
      await this.sendMessageInner(sessionId, opts);
    } finally {
      for (const f of tempFiles) {
        try { unlinkSync(f); } catch { /* best effort */ }
      }
    }
  }

  private async sendMessageInner(sessionId: string, opts: MessageOptions): Promise<void> {
    // getSession() is inside the try so that a "Session not found" throw —
    // which happens when meta says active/idle but the SDK runtime never
    // loaded the session (state-drift after a crash, or a missed
    // ensureSessionResumed gate) — flows into the recovery path that calls
    // resumeTrackedSession instead of escaping all the way to the arm.
    let entry: SessionEntry;
    try {
      entry = this.getSession(sessionId);
      await entry.session.send(opts);
      return;
    } catch (err) {
      // Probe runtime to structurally determine error category
      const health = await this.probeRuntime();

      if (health === 'auth_error') {
        this.fireAuthError(sessionId, err);
        throw err;
      }

      if (health === 'dead') {
        // Runtime process died — rebuild the client and retry once
        logger.warn({ err, sessionId }, 'Runtime died mid-send; rebuilding client');
        try {
          await this.rebuildClient();
          entry = await this.resumeTrackedSession(sessionId);
          await entry.session.send(opts);
          return;
        } catch (rebuildErr) {
          this.handleUnavailableSession(sessionId, rebuildErr);
          throw rebuildErr;
        }
      }

      // Runtime alive — session-level error; try resume + retry
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
        // On retry failure, re-probe to give a meaningful diagnosis
        const retryHealth = await this.probeRuntime();
        if (retryHealth === 'auth_error') {
          this.fireAuthError(sessionId, retryErr);
        } else {
          this.handleUnavailableSession(sessionId, retryErr);
        }
        throw retryErr;
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
          otherPending.resolve({ kind: 'approve-once' });
          entry.pendingPermissions.delete(otherId);
          this.onPermissionAutoResolved?.(sessionId, otherId, 'approved');
          logger.debug({ permissionId: otherId, sessionId, toolKind: pending.toolKind }, 'permission auto-approved');
        }
      }
    }

    const kindMap: Record<PermissionDecision, PermissionRequestResult> = {
      approve: { kind: 'approve-once' },
      deny: { kind: 'reject' },
      always_allow: { kind: 'approve-once' },
    };

    pending.resolve(kindMap[decision] ?? { kind: 'reject' });
    entry.pendingPermissions.delete(permissionId);
    this.touchSession(sessionId);
    logger.debug({ permissionId, sessionId, decision }, 'permission resolved');
  }

  async respondToQuestion(
    sessionId: string,
    questionId: string,
    answer: QuestionAnswer | string,
    wasFreeform: boolean,
  ): Promise<QuestionResponseResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn(`respondToQuestion: session not found: ${sessionId}`);
      return 'session_gone';
    }
    const pending = entry.pendingQuestions.get(questionId);
    if (!pending) {
      logger.warn(`respondToQuestion: no pending question: ${questionId}`);
      return 'not_found';
    }

    const answerValue = typeof answer === 'string' ? { text: answer } : answer;
    const answerText = answerValue.text || (answerValue.attachments?.length ? 'The user answered with image attachment(s).' : '');
    pending.resolve({ answer: answerText, wasFreeform });
    entry.pendingQuestions.delete(questionId);
    this.touchSession(sessionId);
    return 'accepted';
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
    try { unlinkSync(join(getKrakiHome(), 'sessions', sessionId, 'copilot.jsonl')); } catch { /* no link */ }
    this.onSessionEnded?.(sessionId, { reason: 'killed' });
    logger.info(`session killed: ${sessionId}`);
  }

  async abortSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) {
      // Mark BEFORE the abort lands so the subsequent session.idle handler
      // sees the flag and suppresses empty-cycle detection. If we marked
      // after session.abort() resolved, the idle event could fire first
      // (depending on SDK timing) and a false empty-cycle error would
      // beat us.
      this.cycleUserAborted.set(sessionId, true);
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
      cwd: s.context?.workingDirectory,
      summary: s.summary ?? '',
    }));
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      logger.debug('listModels: client not initialized');
      return [];
    }
    try {
      const models = await this.client.listModels();
      return models.map((m: { id: string }) => m.id);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'listModels failed');
      return [];
    }
  }

  async listModelDetails(): Promise<import('@kraki/protocol').ModelDetail[]> {
    if (!this.client) {
      logger.debug('listModelDetails: client not initialized');
      return [];
    }
    try {
      const models = await this.client.listModels();
      return models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        supportsReasoningEffort: m.capabilities?.supports?.reasoningEffort ?? false,
        ...(m.supportedReasoningEfforts && { supportedReasoningEfforts: m.supportedReasoningEfforts }),
        ...(m.defaultReasoningEffort && { defaultReasoningEffort: m.defaultReasoningEffort }),
        ...(m.capabilities?.limits?.max_context_window_tokens && { contextWindow: m.capabilities.limits.max_context_window_tokens }),
        ...(CopilotAdapter.LONG_CONTEXT_MODELS.has(m.id) && { supportedContextTiers: ['default', 'long_context'] as import('@kraki/protocol').ContextTier[] }),
      }));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'listModelDetails failed');
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
  async setSessionModel(sessionId: string, model: string, reasoningEffort?: string, contextTier?: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      logger.warn({ sessionId }, 'setSessionModel: session not found');
      return;
    }
    this.expectedModels.set(sessionId, model);
    this.userRequestedModels.set(sessionId, model);
    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
    const options: { reasoningEffort?: SessionConfig['reasoningEffort']; contextTier?: ContextTier } = {};
    if (reasoningEffort && validEfforts.has(reasoningEffort)) {
      options.reasoningEffort = reasoningEffort as SessionConfig['reasoningEffort'];
    }
    if (contextTier === 'long_context') {
      options.contextTier = 'long_context';
    }
    await entry.session.setModel(model, Object.keys(options).length > 0 ? options : undefined);
    logger.info({ sessionId, model, ...options }, 'Session model changed');
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
    this.expectedModels.delete(sessionId);
    this.userRequestedModels.delete(sessionId);
    this.turnHasOutput.delete(sessionId);
    this.cycleHasOutput.delete(sessionId);
    this.turnErrorReported.delete(sessionId);
    this.cycleUserAborted.delete(sessionId);
    this.pendingNarration.delete(sessionId);
    const inflight = this.sessionToolCallIds.get(sessionId);
    if (inflight) {
      for (const id of inflight) {
        this.pendingToolArgs.delete(id);
        this.pendingToolIdentity.delete(id);
      }
      this.sessionToolCallIds.delete(sessionId);
    }
    this.clearIdleTimer(sessionId);
  }

  private clearIdleTimer(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
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
  private copilotEventsPath(sessionId: string): string {
    return join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
  }

  private linkCopilotStore(sessionId: string): void {
    try {
      const dir = join(getKrakiHome(), 'sessions', sessionId);
      mkdirSync(dir, { recursive: true });
      const link = join(dir, 'copilot.jsonl');
      try { lstatSync(link); unlinkSync(link); } catch { /* no stale link */ }
      // Target may not exist yet (SDK writes lazily) — a dangling symlink is
      // fine and resolves once the first events are written.
      symlinkSync(this.copilotEventsPath(sessionId), link);
    } catch (err) {
      logger.debug({ err: (err as Error).message, sessionId }, 'linkCopilotStore failed');
    }
  }

  private signalFlushComplete(sessionId: string): void {
    const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    const MAX_CHECKS = 3;
    const CHECK_INTERVAL_MS = 200;
    let lastSize = -1;
    let checks = 0;

    const check = () => {
      let size: number;
      try { size = statSync(eventsPath).size; } catch { size = 0; }

      if (size === lastSize || checks >= MAX_CHECKS) {
        if (checks >= MAX_CHECKS && size !== lastSize) {
          logger.warn({ sessionId }, 'events.jsonl still growing after max wait — signalling flush anyway');
        }
        this.onFlushComplete?.(sessionId);
        return;
      }

      lastSize = size;
      checks++;
      setTimeout(check, CHECK_INTERVAL_MS);
    };

    // Start first check after a short delay to let the SDK write its final events
    setTimeout(check, CHECK_INTERVAL_MS);
  }

  /** Resolve all pending permissions/questions and fire callbacks so relay-client broadcasts resolutions. */
  private broadcastPendingResolutions(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    for (const [permId, p] of entry.pendingPermissions) {
      p.resolve({ kind: 'reject' });
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
    if (this.krakiMcp) {
      const krakiEntry: MCPServerConfig = {
        type: 'http' as const,
        url: this.krakiMcp.urlForSession(sessionId),
        headers: { Authorization: `Bearer ${this.krakiMcp.bearerToken}` },
        tools: ['*'],
      } as MCPServerConfig;
      mcpServers = { ...(mcpServers ?? {}), kraki: krakiEntry };
    }

    const systemPromptContent = this.krakiMcp
      ? `${CopilotAdapter.SYSTEM_PROMPT}\n\n${CopilotAdapter.KRAKI_MCP_PROMPT}`
      : CopilotAdapter.SYSTEM_PROMPT;

    return {
      configDirectory: getCopilotConfigDir(),
      streaming: true,
      ...(mcpServers && { mcpServers }),
      systemMessage: { mode: 'append' as const, content: systemPromptContent },
      onPermissionRequest: this.makePermissionHandler(pendingPermissions),
      onUserInputRequest: this.makeQuestionHandler(pendingQuestions),
    };
  }

  private async resumeTrackedSession(sessionId: string): Promise<SessionEntry> {
    this.ensureClient();

    this.sanitizeEventsBeforeResume(sessionId);

    const pendingPermissions = new Map<string, PendingPermission>();
    const pendingQuestions = new Map<string, PendingQuestion>();
    const session = await this.client!.resumeSession(
      sessionId,
      this.makeResumeConfig(sessionId, pendingPermissions, pendingQuestions),
    );
    const entry = { session, pendingPermissions, pendingQuestions };

    this.sessions.set(sessionId, entry);
    this.touchSession(sessionId);
    this.wireEvents(sessionId, session);
    this.linkCopilotStore(sessionId);
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
  private sanitizeEventsBeforeResume(sessionId: string): void {
    const eventsPath = join(homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    const fixed = sanitizeCopilotEventsFile(eventsPath);
    if (fixed > 0) {
      logger.info({ sessionId, fixed }, 'sanitized Copilot events.jsonl before resume');
    }
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

  /**
   * Probe the runtime to determine its health after an error.
   *
   * Uses `getAuthStatus()` as a lightweight RPC to structurally detect
   * whether the runtime process is alive, eliminating hardcoded error
   * string matching. Bounded by {@link PROBE_RUNTIME_TIMEOUT_MS} so a
   * wedged runtime is treated as dead instead of hanging the caller.
   *
   * Returns:
   *  - `'alive'`      — runtime is up, auth is good → session-level error
   *  - `'auth_error'`  — runtime is up but auth failed
   *  - `'dead'`        — runtime process is gone, wedged, or timed out
   */
  private async probeRuntime(): Promise<'alive' | 'auth_error' | 'dead'> {
    if (!this.client) return 'dead';
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const status = await Promise.race([
        this.client.getAuthStatus(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('probeRuntime timeout')),
            CopilotAdapter.PROBE_RUNTIME_TIMEOUT_MS,
          );
        }),
      ]);
      return status.isAuthenticated ? 'alive' : 'auth_error';
    } catch {
      return 'dead';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Fire onError with a clear, actionable auth-error message. */
  private fireAuthError(sessionId: string, err: unknown): void {
    const raw = getErrorMessage(err);
    logger.error({ sessionId, err }, 'Authentication error detected');
    this.onError?.(sessionId, {
      message: `GitHub credential expired or invalid: ${raw}\n\nRun one of the following on the host machine to re-authenticate:\n• \`copilot /login\`\n• \`gh auth login\``,
    });
  }

  // ── SDK → callback wiring ─────────────────────────

  /**
   * Flush buffered assistant prose as intermediate narration (draft/status,
   * NOT a permanent spine bubble). Called when a tool follows the prose.
   */
  private flushNarration(sessionId: string): void {
    const text = (this.pendingNarration.get(sessionId) ?? '').trim();
    this.pendingNarration.delete(sessionId);
    if (text) {
      this.onNarration?.(sessionId, { content: text });
      this.onNarrationTrace?.(sessionId, { content: text });
    }
  }

  /**
   * Flush buffered assistant prose as the turn's single conclusion bubble
   * (onMessage → permanent spine bubble). Called at turn end / idle.
   */
  private flushConclusion(sessionId: string): void {
    const text = (this.pendingNarration.get(sessionId) ?? '').trim();
    this.pendingNarration.delete(sessionId);
    if (text) this.onMessage?.(sessionId, { content: text });
  }

  private wireEvents(sessionId: string, session: CopilotSession): void {
    // Initialize per-cycle state for this session. Without this, resumed/forked
    // sessions (where sendMessage hasn't been called yet) would have undefined
    // cycleHasOutput and skip empty-cycle detection.
    if (!this.cycleHasOutput.has(sessionId)) {
      this.cycleHasOutput.set(sessionId, false);
    }
    if (!this.turnErrorReported.has(sessionId)) {
      this.turnErrorReported.set(sessionId, false);
    }

    session.on('assistant.message_delta', (event) => {
      this.onMessageDelta?.(sessionId, { content: event.data.deltaContent });
    });

    session.on('assistant.message', (event) => {
      // Skip empty messages (SDK sends these before tool calls)
      if (event.data.content) {
        this.turnHasOutput.set(sessionId, true);
        this.cycleHasOutput.set(sessionId, true);
        this.touchSession(sessionId);
        // Draft-bubble model: buffer prose instead of graduating each message
        // to its own permanent bubble. Accumulate consecutive messages so a
        // multi-part answer isn't lost. Flushed as narration (if a tool
        // follows) or as the single conclusion bubble (at turn end/idle).
        const prev = this.pendingNarration.get(sessionId);
        this.pendingNarration.set(sessionId, prev ? `${prev}\n${event.data.content}` : event.data.content);
      }
    });

    session.on('tool.execution_start', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      // report_intent is a UI hint only — drop it from the message stream.
      if (data.toolName === 'report_intent') return;
      // A tool follows any buffered prose → that prose was narration.
      this.flushNarration(sessionId);
      this.turnHasOutput.set(sessionId, true);
      this.cycleHasOutput.set(sessionId, true);
      this.touchSession(sessionId);
      if (data.mcpServerName) {
        logger.info({ mcpServer: data.mcpServerName, mcpTool: data.mcpToolName }, `[MCP tool] ${data.mcpServerName}/${data.mcpToolName}`);
      }
      const args = (data.args ?? data.arguments ?? {}) as Record<string, unknown>;
      const toolCallId = data.toolCallId as string | undefined;
      if (toolCallId) {
        this.pendingToolArgs.set(toolCallId, args);
        // Stash tool identity for tool.execution_complete, which only carries
        // toolCallId (verified via live SDK spike).
        this.pendingToolIdentity.set(toolCallId, {
          toolName: data.toolName as string | undefined,
          mcpServerName: data.mcpServerName as string | undefined,
          mcpToolName: data.mcpToolName as string | undefined,
        });
        let inflight = this.sessionToolCallIds.get(sessionId);
        if (!inflight) {
          inflight = new Set();
          this.sessionToolCallIds.set(sessionId, inflight);
        }
        inflight.add(toolCallId);
      }
      this.onToolStart?.(sessionId, {
        toolName: data.toolName as string,
        args,
        toolCallId,
      });
    });

    session.on('tool.execution_complete', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const toolCallId = data.toolCallId as string | undefined;
      const identity = toolCallId ? this.pendingToolIdentity.get(toolCallId) : undefined;
      const toolName = identity?.toolName ?? (data.toolName as string | undefined) ?? 'tool';
      const clearInflight = () => {
        if (!toolCallId) return;
        this.pendingToolIdentity.delete(toolCallId);
        this.pendingToolArgs.delete(toolCallId);
        const inflight = this.sessionToolCallIds.get(sessionId);
        if (inflight) {
          inflight.delete(toolCallId);
          if (inflight.size === 0) this.sessionToolCallIds.delete(sessionId);
        }
      };
      if (toolName === 'report_intent') {
        clearInflight();
        return;
      }
      const rawResult = data.result;
      const resultObj = typeof rawResult === 'object' && rawResult !== null
        ? rawResult as Record<string, unknown>
        : null;
      let result = resultObj?.content as string ?? (typeof rawResult === 'string' ? rawResult : (data.output as string ?? ''));
      if (!result && data.error) {
        const errObj = typeof data.error === 'object' && data.error !== null
          ? data.error as Record<string, unknown>
          : null;
        result = (errObj?.message as string) ?? (typeof data.error === 'string' ? data.error : '');
      }

      // Extract image content blocks — ONLY for the kraki-show_image MCP tool.
      // All other tools' image bytes (notably `view` on a .png) are deliberately
      // dropped here per the v1 design: only `kraki-show_image` surfaces images
      // to the client. The file-path fallback (re-read image from disk when SDK
      // strips bytes) has been removed.
      const isKrakiShowImage =
        identity?.mcpServerName === 'kraki' && identity?.mcpToolName === 'show_image';

      let attachments: import('@kraki/protocol').Attachment[] | undefined;
      if (isKrakiShowImage && this.attachmentStore) {
        const contentBlocks = resultObj?.contents as Array<Record<string, unknown>> | undefined;
        const args = toolCallId ? this.pendingToolArgs.get(toolCallId) ?? {} : {};
        const caption = typeof args.caption === 'string' && args.caption.trim()
          ? args.caption.trim()
          : undefined;
        const path = typeof args.path === 'string' ? args.path : undefined;
        const refs: import('@kraki/protocol').ContentRef[] = [];
        if (Array.isArray(contentBlocks)) {
          for (const block of contentBlocks) {
            if (
              block.type === 'image' &&
              typeof block.data === 'string' &&
              typeof block.mimeType === 'string'
            ) {
              try {
                const bytes = Buffer.from(block.data, 'base64');
                const ref = this.attachmentStore.put(sessionId, bytes, block.mimeType, {
                  ...(path && { name: basenameSafe(path) }),
                  ...(caption && { caption }),
                });
                refs.push(ref);
              } catch (err) {
                logger.warn({ err, sessionId }, 'failed to store show_image attachment');
              }
            }
          }
        }
        if (refs.length > 0) {
          attachments = refs;
        }
      }

      // Clean up tracked state for this tool call
      clearInflight();

      this.onToolComplete?.(sessionId, {
        toolName,
        result,
        toolCallId,
        success: data.success as boolean | undefined,
        attachments,
      });

      // After tool_complete, fire the bytes broadcast event so RelayClient
      // can stream attachment_data chunks to all connected devices.
      if (attachments && attachments.length > 0) {
        const refs = attachments.filter(
          (a): a is import('@kraki/protocol').ContentRef => a.type === 'content_ref',
        );
        if (refs.length > 0) {
          this.onAttachmentBytes?.(sessionId, { refs });
        }
      }
    });

    session.on('session.idle', () => {
      this.clearIdleTimer(sessionId);

      // Detect empty cycles — the entire user-message-to-idle cycle had no
      // output and no error was reported. This catches silent SDK failures
      // (e.g. CLI bug github/copilot-sdk#794) without false-firing when:
      //   - the agent intentionally stays silent ("don't say anything")
      //   - the user explicitly aborted the turn before output (cycleUserAborted)
      const hasOutput = this.cycleHasOutput.get(sessionId);
      const hadError = this.turnErrorReported.get(sessionId);
      const wasAborted = this.cycleUserAborted.get(sessionId);
      if (hasOutput === false && !hadError && !wasAborted) {
        logger.warn({ sessionId }, 'Empty cycle detected — agent produced no output for entire user message');
        this.onError?.(sessionId, {
          message: 'Agent produced no output. The session may need to be restarted or the model may be unavailable.',
        });
      }
      // Clear the abort flag — next sendMessage starts a fresh cycle anyway,
      // but clearing here keeps state tidy if no new sendMessage follows.
      this.cycleUserAborted.delete(sessionId);

      // Flush any buffered prose as the turn's single conclusion bubble
      // before going idle (draft-bubble model).
      this.flushConclusion(sessionId);
      this.onIdle?.(sessionId);
      this.signalFlushComplete(sessionId);
    });

    session.on('assistant.turn_start', () => {
      this.clearIdleTimer(sessionId);
      this.turnHasOutput.set(sessionId, false);
      // Only reset if no error was reported before this turn started
      // (session.error can fire before turn_start in error recovery paths)
      if (!this.turnErrorReported.get(sessionId)) {
        this.turnErrorReported.set(sessionId, false);
      }
    });

    session.on('session.error', async (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const message = (data.message as string) ?? 'Unknown session error';
      const errorType = data.errorType as string | undefined;
      logger.error({ sessionId, errorType, statusCode: data.statusCode }, `session.error: ${message}`);
      if (!this.turnErrorReported.get(sessionId)) {
        this.turnErrorReported.set(sessionId, true);
        if (await this.probeRuntime() === 'auth_error') {
          this.fireAuthError(sessionId, message);
        } else {
          this.onError?.(sessionId, { message });
        }
      }
    });

    // session.tools_updated is ephemeral and not in the typed event union,
    // so we use the generic catch-all handler form.
    session.on((event) => {
      if (event.type !== 'session.tools_updated') return;
      const data = event.data as unknown as Record<string, unknown>;
      const actualModel = data?.model as string | undefined;
      if (!actualModel) return;

      const expected = this.expectedModels.get(sessionId);
      if (!expected || actualModel === expected) return;

      const requested = this.userRequestedModels.get(sessionId) ?? expected;
      logger.warn({ sessionId, requested, actualModel }, 'Model mismatch detected — aborting to prevent history pollution');

      // Abort the in-flight turn and disconnect before any polluted events are produced
      const entry = this.sessions.get(sessionId);
      if (entry) {
        entry.session.abort().catch(() => {});
        entry.session.disconnect().catch(() => {});
        this.sessions.delete(sessionId);
      }

      this.onError?.(sessionId, {
        message: `${requested} is currently unavailable. Session paused — send a message to retry.`,
      });
      // Discard any buffered prose — the turn is being torn down, not concluded.
      this.pendingNarration.delete(sessionId);
      this.onIdle?.(sessionId);
      this.signalFlushComplete(sessionId);
      this.cleanupSessionPermissions(sessionId);
    });

    session.on('session.info', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const category = data.category as string | undefined;
      if (category === 'mcp') {
        logger.info(`[MCP] ${data.message}`);
      } else {
        logger.debug(`[info:${category}] ${data.message}`);
      }
    });

    session.on('session.warning', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const category = data.category as string | undefined;
      logger.warn(`[warning:${category}] ${data.message}`);
    });

    session.on('assistant.turn_end', async (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const reason = data?.reason;
      if (reason === 'error') {
        const errorMsg = (data?.error as string) ?? 'Unknown agent error';
        this.turnErrorReported.set(sessionId, true);
        if (await this.probeRuntime() === 'auth_error') {
          this.fireAuthError(sessionId, errorMsg);
        } else {
          this.onError?.(sessionId, { message: errorMsg });
        }
      }

      // Empty-cycle detection moved to session.idle — see handler above.
      // Per-turn detection over-fires when agent intentionally stays silent
      // (e.g. user said "don't say anything" after a tool ran in a prior turn).

      // Fallback: schedule idle in case the SDK doesn't emit session.idle
      // (known CLI bug — github/copilot-sdk#794). Cancelled if turn_start
      // or session.idle arrives first.
      this.clearIdleTimer(sessionId);
      this.idleTimers.set(sessionId, setTimeout(() => {
        this.idleTimers.delete(sessionId);
        logger.info({ sessionId }, 'Idle fallback fired (session.idle not received after turn_end)');
        this.flushConclusion(sessionId);
        this.onIdle?.(sessionId);
        this.signalFlushComplete(sessionId);
      }, CopilotAdapter.IDLE_FALLBACK_MS));
    });

    session.on('session.title_changed', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
      const title = data?.title as string | undefined;
      if (title) {
        this.onTitleChanged?.(sessionId, title);
      }
    });

    session.on('assistant.usage', (event) => {
      const data = event.data as unknown as Record<string, unknown>;
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
        contextTokens: (data.inputTokens as number) ?? prev.contextTokens,
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

      const rawRequest = req as PermissionRequest & Record<string, unknown>;
      if (toolKind === 'shell' && isKrakiSelfManagementCommand(shellCommandFromInput(rawRequest))) {
        logger.warn({ sessionId }, 'blocked tentacle self-management command');
        return { kind: 'reject', feedback: SELF_MANAGEMENT_DENIAL_REASON };
      }

      // Mode-based auto-approval
      if (mode === 'execute' || mode === 'delegate') {
        logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
        return { kind: 'approve-once' };
      }
      if (mode === 'discuss' && toolKind !== 'write') {
        logger.debug({ sessionId, toolKind, mode }, 'permission auto-approved');
        return { kind: 'approve-once' };
      }
      if (mode === 'discuss' && toolKind === 'write') {
        const r = req as PermissionRequest & Record<string, unknown>;
        const filePath = ((r.fileName ?? r.path ?? '') as string);
        // Allow list: files that can be written in Discuss mode
        const DISCUSS_MODE_WRITE_ALLOW_LIST = ['plan.md'];
        const allowed = DISCUSS_MODE_WRITE_ALLOW_LIST.some(
          (f) => filePath.endsWith('/' + f) || filePath === f,
        );
        if (allowed) {
          logger.debug({ sessionId, toolKind, mode, filePath }, 'write auto-approved (discuss mode allow list)');
          return { kind: 'approve-once' };
        }
        // Non-allowed writes fall through to the permission prompt below
        // so the operator can approve, deny, or switch to execute mode.
      }
      if (this.sessionAllowSets.get(sessionId)?.has(toolKind)) {
        logger.debug({ sessionId, toolKind }, 'permission auto-approved (session allow set)');
        return { kind: 'approve-once' };
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
        configDirectory: getCopilotConfigDir(),
        systemMessage: { mode: 'replace' as const, content: CopilotAdapter.TITLE_SYSTEM_PROMPT },
        streaming: true,
        onPermissionRequest: () => ({ kind: 'approve-once' as const }),
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
