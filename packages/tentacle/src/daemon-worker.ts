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

import { platform } from 'node:os';
import { getKrakiHome, loadConfig, saveConfig, loadChannelKey, getOrCreateDeviceId, getConfigPath, getChannelKeyPath, getVersion, saveDaemonPid, saveDaemonReady, clearDaemonReady, clearDaemonIdentity } from './config.js';
import { ensureWindowsSystemPath, probeFda, ensureTccBundleRegistered, cleanupStaleBundleEntries } from './checks.js';
import { MultiAgentAdapter } from './adapters/multi.js';
import { hideChildWindowsByDefault } from './windows-hide.js';
import { applyProcessProxy } from './proxy.js';

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
process.on('unhandledRejection', (reason) => {
  // The daemon must stay alive, but a silently swallowed rejection hides real
  // bugs. `logger` is defined below; the handler only runs after module init.
  try { logger.warn({ err: reason }, 'Unhandled promise rejection'); } catch { /* logger not ready */ }
});
import { RelayClient } from './relay-client.js';
import { AccountUsageMonitor, UsageHistory } from './account-usage.js';
import { join } from 'node:path';
import { SessionManager } from './session-manager.js';
import { KeyManager } from './key-manager.js';
import { AttachmentStore } from './attachment-store.js';
import { KrakiMcpServer } from './mcp/index.js';
import { createLogger } from './logger.js';
import { initStatusFile, updateRelayState, updateRegion, clearStatusFile, updateFdaStatus, updateDaemonIdentity } from './status-file.js';
import { isMacAppManagedWorker, loadManagedBy } from './managed.js';
import { hydrateLoginShellEnv } from './shell-env.js';
import type { AgentAdapter } from './adapters/base.js';
import type { AgentId } from '@kraki/protocol';

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
  let pendingFda: 'granted' | 'denied' | 'missing' | null = null;
  // Launch Services injects this private bootstrap variable into Kraki.app.
  // It is not a child-process credential, so remove it before adapters spawn.
  // Correctness does not rely on this scrub: responsible-process attribution
  // can still make live LS lookups unstable, which is why the CLI captured a
  // PID-bound identity proof before importing this module.
  delete process.env.__CFBundleIdentifier;

  // Clear any stale readiness before publishing this process's PID. This order
  // prevents a reused numeric PID from momentarily matching an old ready file.
  clearDaemonReady();
  saveDaemonPid(process.pid);
  logger.info('Daemon starting…');
  if (_ensuredWindowsPathDirs.length > 0) {
    logger.info(
      { addedPathDirs: _ensuredWindowsPathDirs },
      'Self-healed PATH on Windows (System32 and friends were missing)',
    );
  }

  const managedByMacApp = isMacAppManagedWorker();

  // Kraki for Mac owns the daemon for this home, yet the CLI's launchd job
  // started us: that job is a leftover. Retire it and exit instead of running
  // a second daemon under the same device id.
  if (!managedByMacApp && platform() === 'darwin' && loadManagedBy()) {
    logger.warn('Kraki for Mac runs the daemon for this home; retiring the leftover CLI launchd job');
    const { retireCliLaunchdJob } = await import('./daemon.js');
    retireCliLaunchdJob();
    return process.exit(0);
  }

  if (managedByMacApp) {
    // Started by Kraki for Mac's SMAppService job: launchd provides only a
    // minimal environment, so recover the user's login-shell PATH/proxies
    // before any agent, `gh`, or version-manager shim is resolved.
    const shellEnv = hydrateLoginShellEnv();
    logger.info(
      { source: shellEnv.source, shell: shellEnv.shell, added: shellEnv.addedKeys.length, error: shellEnv.error },
      'Resolved login-shell environment for the Mac app daemon',
    );
  } else if (platform() === 'darwin') {
    // Standalone CLI install: ensure its Kraki.app bundle is registered with
    // Launch Services so TCC tracks grants by bundle id (stable across updates)
    // instead of cdhash (invalidated every release). This self-heals machines
    // that installed before the lsregister step existed. Idempotent + cheap.
    //
    // Not done for the Mac app's embedded helper: TCC attributes that daemon to
    // the enclosing Kraki for Mac bundle (responsible process), and sweeping
    // chat.kraki.cli records is the standalone CLI's business alone.
    ensureTccBundleRegistered();
    // Also purge zombie Launch Services entries from past updates / builds —
    // a one-time sweep that fixes every already-installed machine.
    const sweep = cleanupStaleBundleEntries();
    if (sweep.removed.length > 0) {
      logger.info(
        { removedCount: sweep.removed.length },
        'Cleaned stale Launch Services entries for chat.kraki.cli (TCC hygiene)',
      );
    }
  }

  // macOS: check Full Disk Access status. FDA is required to prevent
  // recurring TCC permission dialogs during agent sessions. The daemon's own
  // observation is authoritative (TCC decides per responsible process), so it
  // is published in status.json for the Mac app's onboarding to follow.
  let fdaMonitor: NodeJS.Timeout | null = null;
  if (platform() === 'darwin') {
    const fdaStatus = await probeFda();
    if (fdaStatus !== 'granted') {
      logger.warn(
        'Full Disk Access not granted — grant in System Settings → Privacy & Security → Full Disk Access to prevent recurring permission dialogs',
      );
    }
    let lastFda = fdaStatus;
    let nextCheckAt = 0;
    fdaMonitor = setInterval(() => {
      // Poll quickly while the user may be granting access, slowly afterwards
      // (FDA can also be revoked at any time).
      if (Date.now() < nextCheckAt) return;
      probeFda().then((status) => {
        if (status !== lastFda) {
          logger.info({ from: lastFda, to: status }, 'Full Disk Access status changed');
          lastFda = status;
        }
        updateFdaStatus(status);
        nextCheckAt = Date.now() + (status === 'granted' ? 60_000 : 0);
      }).catch(() => {});
    }, 3000);
    fdaMonitor.unref();
    pendingFda = fdaStatus;
  }

  const configPath = getConfigPath();
  const channelKeyPath = getChannelKeyPath();

  // 1. Load config
  let config = loadConfig();
  if (!config && managedByMacApp) {
    // The Mac app registers its job only after setup, but the user can still
    // reset the config while the job is enabled. Exiting would make launchd
    // respawn us every ThrottleInterval forever; wait for setup instead.
    logger.warn({ configPath }, 'No config yet — waiting for Kraki for Mac to finish setup');
    while (!config) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      config = loadConfig();
    }
  }
  if (!config) {
    logger.fatal({ configPath }, `No config found at ${configPath} — run \`kraki\` to set up`);
    process.exit(1);
  }

  // 2. Resolve relay auth token
  let token: string | undefined;

  if (config.authMethod === 'github_token') {
    // Only Kraki's own read:user token; the GitHub CLI token is never sent to
    // the relay. A registered device authenticates by challenge anyway; the
    // token is only needed to register a brand-new device.
    const { loadGitHubToken } = await import('./config.js');
    token = loadGitHubToken() ?? undefined;
    if (token) logger.debug('Resolved GitHub token from saved device flow token');
    else logger.info('No saved GitHub token; relying on device challenge auth');
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
  // Offloaded tool args/results accumulate a few files per tool call. Keep
  // them for the archive window, then reclaim them (images/reports stay).
  const TOOL_PAYLOAD_TTL_MS = 14 * 24 * 3600_000;
  setTimeout(() => { try { attachmentStore.pruneToolPayloads(TOOL_PAYLOAD_TTL_MS); } catch { /* best effort */ } }, 60_000).unref();
  setInterval(() => { try { attachmentStore.pruneToolPayloads(TOOL_PAYLOAD_TTL_MS); } catch { /* best effort */ } }, 24 * 3600_000).unref();

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

  // Every AgentId the MultiAgentAdapter can start. Pinning `pi` was silently
  // dropped by an older hand-written list.
  const KNOWN_AGENT_IDS = ['copilot', 'claude', 'pi', 'codex'] as const satisfies readonly AgentId[];

  // 3c. Create multi-agent adapter. When config pins an explicit agent
  // allow-list we honour it; otherwise the adapter auto-detects every
  // installed agent at startup (legacy behaviour).
  const pinnedAgents = config.agents?.filter((a): a is AgentId => (KNOWN_AGENT_IDS as readonly string[]).includes(a));
  const adapter = new MultiAgentAdapter({
    attachmentStore,
    ...(pinnedAgents && pinnedAgents.length > 0 && { agentIds: pinnedAgents }),
    ...(mcpInfo && { krakiMcp: mcpInfo }),
  });
  const keyManager = new KeyManager();
  const deviceId = getOrCreateDeviceId();

  // 4. Start agent adapters (auto-detection + startup)
  // Do NOT export the relay token as GITHUB_TOKEN: every agent child and every
  // command it runs would inherit it. Copilot authenticates with its own
  // logged-in user (useLoggedInUser), the others never needed it.
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
  // An agent whose model list was unavailable at startup (pi can be slow right
  // after login) announces recovery later; rebuild and re-greet so apps get
  // its models without a daemon restart. Installed before the relay client
  // exists so a recovery during startup still lands in the first greeting.
  let relayRef: { updateAgentCapabilities(agents: import('@kraki/protocol').AgentCapabilities[]): void } | null = null;
  let capabilitiesRefresh: Promise<void> = Promise.resolve();
  adapter.onCapabilitiesChanged = () => {
    capabilitiesRefresh = capabilitiesRefresh.then(async () => {
      try {
        const next = await adapter.getAgentCapabilities();
        agentCapabilities = next;
        logger.info({ agents: next.map(a => ({ id: a.id, models: a.models?.length ?? 0 })) }, 'Agent capabilities changed; re-greeting apps');
        relayRef?.updateAgentCapabilities(next);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Could not rebuild agent capabilities');
      }
    });
  };
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
      reconnectDelay: 1000,
      version: getVersion(),
      autoArchiveDays: config.autoArchiveDays,
      saveAutoArchiveDays: (days) => {
        const latest = loadConfig();
        if (latest) saveConfig({ ...latest, autoArchiveDays: days });
      },
    },
    keyManager,
    attachmentStore,
  );

  relayRef = relay;

  // Read-only subscription quota of this machine's Claude / Codex accounts.
  // Off with `accountUsage.enabled: false` in config.json or KRAKI_ACCOUNT_USAGE=0.
  let usageMonitor: AccountUsageMonitor | null = null;
  const usageConfig = config.accountUsage ?? {};
  if (process.env.KRAKI_ACCOUNT_USAGE !== '0' && usageConfig.enabled !== false) {
    const history = new UsageHistory(join(getKrakiHome(), 'usage-history.jsonl'));
    const minutes = Math.min(120, Math.max(10, usageConfig.intervalMinutes ?? 15));
    usageMonitor = new AccountUsageMonitor({
      history,
      intervalMs: minutes * 60_000,
      ...(usageConfig.renewPiLogins === false && { renewPi: async () => false }),
    });
    relay.setAccountUsageEnabled(true);
    usageMonitor.onChange = (accounts) => relay.updateAccountUsage(accounts);
    const monitor = usageMonitor;
    relay.setAccountUsageRefresher(async () => {
      await monitor.refresh();
      return monitor.accounts;
    });
    relay.usageHistoryReader = (since) => history.load(since);
    usageMonitor.start();
  }
  // Capabilities may have been rebuilt while the relay client was constructed.
  if (agentCapabilities?.length) relay.updateAgentCapabilities(agentCapabilities);

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
    announceUpdateResult();
  };

  relay.onFatalError = (message) => {
    logger.fatal({ message }, 'Relay fatal error — exiting so the supervisor can restart');
    // A dead relay client inside a live process looks "running" to every
    // supervisor while the device stays offline forever. Exit non-zero:
    // launchd KeepAlive / the Mac app restart us, and `kraki status` tells
    // the truth.
    shutdown().catch(() => {}).finally(() => process.exit(1));
  };

  // "Is a newer Kraki available here?" — shown on this computer in every app —
  // and updating it from an app (remote-update.ts).
  const { watchUpdateStatus, detectInstall } = await import('./update-status.js');
  const remoteUpdate = await import('./remote-update.js');
  const install = detectInstall();
  remoteUpdate.cleanupAfterUpdate(install.target);
  const remoteState = () => {
    const block = remoteUpdate.remoteUpdateBlock(install, loadConfig());
    return block ? { remote: false, remoteBlock: block } : { remote: true };
  };
  const updateWatch = watchUpdateStatus((info) => relay.setUpdateInfo(info), install, remoteState);
  // The switch (`kraki config remote-update`, Kraki for Mac's setting) is
  // read locally; re-announce within a minute when it changes.
  const remoteRecheck = setInterval(() => {
    const cur = relay.currentUpdateInfo;
    if (!cur) return;
    const r = remoteState();
    if (cur.remote === r.remote && cur.remoteBlock === (r as { remoteBlock?: string }).remoteBlock) return;
    const { remoteBlock: _old, ...rest } = cur;
    relay.setUpdateInfo({ ...rest, ...r });
  }, 60_000);
  remoteRecheck.unref();
  const stopUpdateWatch = () => { updateWatch.stop(); clearInterval(remoteRecheck); };
  const updater = new remoteUpdate.RemoteUpdater({
    install,
    currentVersion: getVersion(),
    status: () => {
      const info = relay.currentUpdateInfo;
      return info ? { ...info, ...remoteState() } : null;
    },
    runningSessions: () => relay.runningSessionCount(),
    emit: (p) => relay.sendUpdateStatus(p),
  });
  relay.onUpdateRequest = async (requestId, when) => {
    // A stale "no update" answer must not block a release published since.
    if (!relay.currentUpdateInfo?.latest) await updateWatch.checkNow();
    await updater.request(requestId, when);
  };
  const announceUpdateResult = () => {
    const r = remoteUpdate.takeUnannouncedResult();
    if (r) relay.sendUpdateStatus({ phase: r.phase, requestId: r.requestId, from: r.from, to: r.to, error: r.error });
  };
  relay.connect();
  logger.info({ relay: config.relay, device: config.device.name }, 'Daemon running');
  {
    const { detectProxy } = await import('./proxy.js');
    const p = detectProxy();
    if (p) logger.info({ proxy: p.https ?? p.http, source: p.source }, 'Using proxy');
  }

  // Write initial status file so toolbar can detect the daemon. Readiness is
  // published only after the lifecycle handlers below are installed.
  initStatusFile(process.env.KRAKI_RELAY_URL ?? config.relay, config.device.name);
  updateDaemonIdentity({ managedBy: managedByMacApp ? 'kraki-mac' : 'cli', version: getVersion(), pid: process.pid });
  if (pendingFda) updateFdaStatus(pendingFda);

  // 6. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down…');
    clearDaemonReady();
    clearDaemonIdentity();
    if (fdaMonitor) clearInterval(fdaMonitor);
    usageMonitor?.stop();
    stopUpdateWatch();
    clearStatusFile();
    relay.disconnect();
    await adapter.stop();
    if (mcpServer) {
      try { await mcpServer.stop(); } catch { /* already stopped */ }
    }
  };

  // Supervised (Kraki for Mac): leave if the supervisor is gone, so a killed
  // job never leaves this worker running next to a newly started one.
  const { watchSupervisor } = await import('./daemon-supervisor.js');
  watchSupervisor(() => {
    logger.warn('Supervisor is gone — shutting down');
    shutdown().catch(() => {}).finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
  process.on('SIGINT', () => { shutdown().catch(() => {}).finally(() => process.exit(0)); });
  // On an uncaught exception, attempt the same graceful shutdown so the
  // Copilot SDK runtime child is stopped instead of being orphaned. exit(1)
  // to signal the abnormal termination to the launcher / launchctl.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — attempting graceful shutdown');
    shutdown().catch(() => {}).finally(() => process.exit(1));
  });

  // Publish readiness only after every startup-critical component and graceful
  // lifecycle handler is installed. The launcher must not report success before
  // this point.
  saveDaemonReady(process.pid);

  return { adapter, relay, sessionManager, shutdown };
}

// Auto-run when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.endsWith('daemon-worker.js') || process.argv[1]?.endsWith('daemon-worker.ts');
if (isDirectRun) {
  hideChildWindowsByDefault();
  applyProcessProxy();
  startWorker().catch((err) => {
    logger.fatal({ err }, 'Daemon failed to start');
    process.exit(1);
  });
}
