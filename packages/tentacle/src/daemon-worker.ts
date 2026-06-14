/**
 * Kraki tentacle daemon worker.
 *
 * This file is spawned as a background process by daemon.ts.
 * It loads config, resolves authentication, starts the agent adapter,
 * and connects to the head via RelayClient.
 *
 * RelayClient wires all adapter events to the head automatically.
 * SessionManager handles durable session state and crash recovery.
 * KeyManager handles E2E encryption keys.
 *
 * Agent detection: automatically detects available coding agents
 * (Copilot CLI, Claude Code CLI) and starts all that are found.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { loadConfig, loadChannelKey, getOrCreateDeviceId, getConfigPath, getChannelKeyPath, getVersion, saveDaemonPid } from './config.js';
import { ensureWindowsSystemPath, probeFda } from './checks.js';
import { MultiAgentAdapter } from './adapters/multi.js';

// Self-heal PATH on Windows BEFORE any child process is spawned. The
// daemon may have been started from a context with a minimal PATH
// (Startup-folder shortcut, Task Scheduler, double-clicked SEA binary),
// in which case the Copilot SDK's PowerShell tool — which spawns
// `pwsh.exe` / `powershell.exe` by short name — would fail with
// ENOENT and surface as "PowerShell is not available" inside sessions.
// See checks.ts::ensureWindowsSystemPath() for the rationale.
const _ensuredWindowsPathDirs = ensureWindowsSystemPath();

// On macOS the daemon is NOT detached (no setsid) to preserve the
// Gatekeeper session for code signing. Ignore SIGHUP so we survive
// when the launching terminal closes.
process.on('SIGHUP', () => {});

// Prevent unhandled promise rejections from crashing the daemon.
// Node v15+ exits on unhandled rejections by default; we want the daemon to survive.
process.on('unhandledRejection', () => {
  // Intentionally swallowed — the daemon must stay alive.
  // Specific errors are already logged where they originate.
});
import { RelayClient } from './relay-client.js';
import { SessionManager } from './session-manager.js';
import { KeyManager } from './key-manager.js';
import { AttachmentStore } from './attachment-store.js';
import { KrakiMcpServer } from './mcp/index.js';
import { createLogger } from './logger.js';
import { initStatusFile, updateRelayState, updateRegion, clearStatusFile } from './status-file.js';
import type { AgentAdapter } from './adapters/base.js';

const logger = createLogger('daemon');

// Note: `uncaughtException` is installed inside `startWorker` so it has
// access to the `shutdown` closure and can run a best-effort graceful
// cleanup (kill the Copilot SDK runtime, close the relay) before exiting.
// A hard module-level handler would just `process.exit(1)` and leak the
// runtime child process every time.

// ── Main ────────────────────────────────────────────────

export interface WorkerResult {
  adapter: AgentAdapter;
  relay: RelayClient;
  sessionManager: SessionManager;
  shutdown: () => Promise<void>;
}

export async function startWorker(): Promise<WorkerResult> {
  // Write PID immediately so the launcher (launchctl or CLI) can find us
  saveDaemonPid(process.pid);
  logger.info('Daemon starting…');
  if (_ensuredWindowsPathDirs.length > 0) {
    logger.info(
      { addedPathDirs: _ensuredWindowsPathDirs },
      'Self-healed PATH on Windows (System32 and friends were missing)',
    );
  }

  // macOS: check Full Disk Access status. FDA is required to prevent
  // recurring TCC permission dialogs during agent sessions.
  if (platform() === 'darwin') {
    const fdaStatus = await probeFda();
    if (fdaStatus !== 'granted') {
      logger.warn(
        'Full Disk Access not granted — grant in System Settings → Privacy & Security → Full Disk Access to prevent recurring permission dialogs',
      );
    }
  }

  const configPath = getConfigPath();
  const channelKeyPath = getChannelKeyPath();

  // 1. Load config
  const config = loadConfig();
  if (!config) {
    logger.fatal({ configPath }, `No config found at ${configPath} — run \`kraki\` to set up`);
    process.exit(1);
  }

  // 2. Resolve relay auth token
  let token: string | undefined;

  if (config.authMethod === 'github_token') {
    try {
      token = execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
      if (token) logger.debug('Resolved GitHub token from `gh auth token`');
    } catch {
      // gh CLI not available — try saved device flow token
    }
    if (!token) {
      const { loadGitHubToken } = await import('./config.js');
      token = loadGitHubToken() ?? undefined;
      if (token) logger.debug('Resolved GitHub token from saved device flow token');
      else logger.warn('No GitHub token found (neither gh CLI nor device flow)');
    }
  } else {
    const channelKey = loadChannelKey();
    if (channelKey) {
      token = channelKey;
      logger.debug({ channelKeyPath }, `Loaded channel key from ${channelKeyPath}`);
    }
  }

  // 3. Initialize components
  const sessionManager = new SessionManager();
  const attachmentStore = new AttachmentStore(sessionManager.getSessionsRoot());

  // 3b. Start Kraki MCP server (in-process HTTP, loopback only). If bind
  //     fails, log and continue without it — daemon stays up.
  let mcpInfo: { urlForSession: (sid: string) => string; bearerToken: string } | undefined;
  let mcpServer: KrakiMcpServer | null = null;
  try {
    mcpServer = new KrakiMcpServer({
      version: getVersion(),
      isSessionActive: (id) => sessionManager.isSessionActive(id),
    });
    const started = await mcpServer.start();
    mcpInfo = {
      urlForSession: started.urlForSession,
      bearerToken: started.bearerToken,
    };
    logger.info({ port: started.port }, 'Kraki MCP server started');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Kraki MCP server failed to start — kraki-show_image will be unavailable');
    mcpServer = null;
  }

  // 3c. Create multi-agent adapter (auto-detects available agents)
  const adapter = new MultiAgentAdapter({
    attachmentStore,
    ...(mcpInfo && { krakiMcp: mcpInfo }),
  });
  const keyManager = new KeyManager();
  const deviceId = getOrCreateDeviceId();

  // 4. Start agent adapters (auto-detection + startup)
  if (token) {
    process.env.GITHUB_TOKEN = token;
  }
  let adapterReady = false;
  try {
    await adapter.start();
    adapterReady = true;
    logger.info('Multi-agent adapter started');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Multi-agent adapter failed to start');
    try { await adapter.stop(); } catch { /* already dead */ }
  }

  // 5. Build per-agent capabilities for device greeting
  let agentCapabilities: import('@kraki/protocol').AgentCapabilities[] | undefined;
  if (adapterReady) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        agentCapabilities = await adapter.getAgentCapabilities();
        if (agentCapabilities.length > 0) break;
        if (attempt === 0) {
          logger.debug('Agent capabilities empty, retrying after delay…');
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch {
        logger.warn('Could not fetch agent capabilities');
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    logger.debug({ agents: agentCapabilities?.map(a => a.id) }, 'Built agent capabilities');
  }

  // 6. Connect to relay via RelayClient
  const relay = new RelayClient(
    adapter,
    sessionManager,
    {
      relayUrl: process.env.KRAKI_RELAY_URL ?? config.relay,
      device: {
        name: config.device.name,
        role: 'tentacle',
        kind: 'desktop',
        deviceId,
        capabilities: agentCapabilities?.length ? { agents: agentCapabilities } : undefined,
      },
      authMethod: config.authMethod,
      token,
      reconnectDelay: 3000,
      version: getVersion(),
    },
    keyManager,
    attachmentStore,
  );

  relay.onStateChange = (state) => {
    logger.debug({ state }, 'Relay connection state changed');
    updateRelayState(state);
  };

  relay.onAuthenticated = (info) => {
    logger.info({
      deviceId: info.deviceId,
      user: info.user?.login,
      region: info.user?.region,
      devices: info.devices.length,
    }, 'Connected to relay');
    if (info.user?.region) {
      updateRegion(info.user.region);
    }
  };

  relay.onFatalError = (message) => {
    logger.fatal({ message }, 'Relay fatal error');
  };

  relay.connect();
  logger.info({ relay: config.relay, device: config.device.name }, 'Daemon running');

  // Write initial status file so toolbar can detect the daemon
  initStatusFile(process.env.KRAKI_RELAY_URL ?? config.relay, config.device.name);

  // 6. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down…');
    clearStatusFile();
    relay.disconnect();
    await adapter.stop();
    if (mcpServer) {
      try { await mcpServer.stop(); } catch { /* already stopped */ }
    }
  };

  process.on('SIGTERM', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
  // On an uncaught exception, attempt the same graceful shutdown so the
  // Copilot SDK runtime child is stopped instead of being orphaned. exit(1)
  // to signal the abnormal termination to the launcher / launchctl.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — attempting graceful shutdown');
    shutdown().catch(() => {}).finally(() => process.exit(1));
  });

  return { adapter, relay, sessionManager, shutdown };
}

// Auto-run when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.endsWith('daemon-worker.js') || process.argv[1]?.endsWith('daemon-worker.ts');
if (isDirectRun) {
  startWorker().catch((err) => {
    logger.fatal({ err }, 'Daemon failed to start');
    process.exit(1);
  });
}
