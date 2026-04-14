/**
 * Kraki tentacle daemon worker.
 *
 * This file is spawned as a detached background process by daemon.ts.
 * It loads config, resolves authentication, starts the Copilot adapter,
 * and connects to the head via RelayClient.
 *
 * RelayClient wires all adapter events to the head automatically.
 * SessionManager handles durable session state and crash recovery.
 * KeyManager handles E2E encryption keys.
 */

import { execSync } from 'node:child_process';
import { loadConfig, loadChannelKey, getOrCreateDeviceId, getConfigPath, getChannelKeyPath, getVersion } from './config.js';
import { CopilotAdapter } from './adapters/copilot.js';

// Prevent unhandled promise rejections from crashing the daemon.
// Node v15+ exits on unhandled rejections by default; we want the daemon to survive.
process.on('unhandledRejection', () => {
  // Intentionally swallowed — the daemon must stay alive.
  // Specific errors are already logged where they originate.
});
import { RelayClient } from './relay-client.js';
import { SessionManager } from './session-manager.js';
import { KeyManager } from './key-manager.js';
import { createLogger } from './logger.js';
import { initStatusFile, updateRelayState, clearStatusFile } from './status-file.js';
import type { AgentAdapter } from './adapters/base.js';

const logger = createLogger('daemon');

// ── Uncaught exception / rejection handlers ─────────────

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});

// ── Main ────────────────────────────────────────────────

export interface WorkerResult {
  adapter: CopilotAdapter;
  relay: RelayClient;
  sessionManager: SessionManager;
  shutdown: () => Promise<void>;
}

export async function startWorker(): Promise<WorkerResult> {
  logger.info('Daemon starting…');
  const configPath = getConfigPath();
  const channelKeyPath = getChannelKeyPath();

  // 1. Load config
  const config = loadConfig();
  if (!config) {
    logger.fatal({ configPath }, `No config found at ${configPath} — run \`kraki\` to set up`);
    process.exit(1);
  }

  // 2. Resolve auth token
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
  const adapter = new CopilotAdapter();
  const sessionManager = new SessionManager();
  const keyManager = new KeyManager();
  const deviceId = getOrCreateDeviceId();

  // 4. Start Copilot adapter
  if (token) {
    process.env.GITHUB_TOKEN = token;
  }
  let adapterReady = false;
  try {
    await adapter.start();
    adapterReady = true;
    logger.info('Copilot adapter started');
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Copilot adapter failed to start — run "copilot login" to authenticate');
    // Clean up streams/promises from the failed adapter to prevent unhandled rejections
    try { await adapter.stop(); } catch { /* already dead */ }
  }

  // 5. Fetch available models for device capabilities
  let models: string[] = [];
  let modelDetails: import('@kraki/protocol').ModelDetail[] = [];
  if (adapterReady) {
    try {
      modelDetails = await adapter.listModelDetails();
      models = modelDetails.map(m => m.id);
      logger.debug({ count: models.length }, 'Fetched available models');
    } catch {
      logger.warn('Could not fetch available models');
    }
  }

  // 6. Connect to relay via RelayClient
  const relay = new RelayClient(
    adapter as unknown as AgentAdapter,
    sessionManager,
    {
      relayUrl: process.env.KRAKI_RELAY_URL ?? config.relay,
      device: {
        name: config.device.name,
        role: 'tentacle',
        kind: 'desktop',
        deviceId,
        capabilities: models.length > 0 ? { models, modelDetails } : undefined,
      },
      authMethod: config.authMethod,
      token,
      reconnectDelay: 3000,
      version: getVersion(),
    },
    keyManager,
  );

  relay.onStateChange = (state) => {
    logger.debug({ state }, 'Relay connection state changed');
    updateRelayState(state);
  };

  relay.onAuthenticated = (info) => {
    logger.info({
      deviceId: info.deviceId,
      user: info.user?.login,
      devices: info.devices.length,
    }, 'Connected to relay');
  };

  relay.onFatalError = (message) => {
    logger.fatal({ message }, 'Relay fatal error');
  };

  relay.connect();
  logger.info({ relay: config.relay, device: config.device.name }, 'Daemon running');

  // Write initial status file so toolbar can detect the daemon
  initStatusFile(process.env.KRAKI_RELAY_URL ?? config.relay, config.device.name);

  // 6. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down…');
    clearStatusFile();
    relay.disconnect();
    await adapter.stop();
  };

  process.on('SIGTERM', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });

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
