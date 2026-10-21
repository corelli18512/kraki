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

import { platform, uptime as osUptime } from 'node:os';
import { getKrakiHome, loadConfig, saveConfig, loadChannelKey, getOrCreateDeviceId, getConfigPath, getChannelKeyPath, getVersion, saveDaemonPid, saveDaemonReady, clearDaemonReady, clearDaemonIdentity } from './config.js';
import { ensureWindowsSystemPath, probeFdaDetailed, ensureTccBundleRegistered, cleanupStaleBundleEntries } from './checks.js';
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SessionManager } from './session-manager.js';
import { KeyManager } from './key-manager.js';
import { AttachmentStore } from './attachment-store.js';
import { KrakiMcpServer } from './mcp/index.js';
import { createLogger } from './logger.js';
import { initStatusFile, updateRelayState, updateRegion, clearStatusFile, updateFdaStatus, updateDaemonIdentity } from './status-file.js';
import { appManagedWorkerOwner, isMacAppManagedWorker, loadManagedBy } from './managed.js';
import { hydrateLoginShellEnv } from './shell-env.js';
import { beginRun, endRun, noteRunFda, RUN_HEARTBEAT_MS, touchRun } from './run-record.js';
import type { AgentAdapter } from './adapters/base.js';
import type { AgentId } from '@kraki/protocol';

// Lifecycle lines (start, shutdown, fatal) are few and must survive a hard
// exit: written synchronously.
const logger = createLogger('daemon', { sync: true });

// Note: SIGTERM/SIGINT/`uncaughtException` are installed at the top of
// `startWorker` so they can run a best-effort cleanup (kill the Copilot SDK
// runtime, close the relay) before exiting. A hard module-level handler would
// just `process.exit(1)` and leak the runtime child process every time.

/** A stop during startup waits this long for the partial cleanup. */
const STARTUP_STOP_CLEANUP_MS = 5000;

// ── Main ────────────────────────────────────────────────

export interface WorkerResult {
  adapter: AgentAdapter;
  relay: RelayClient;
  sessionManager: SessionManager;
  shutdown: (reason?: string) => Promise<void>;
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
  const startedAt = Date.now();
  logger.info({
    version: getVersion(),
    pid: process.pid,
    ppid: process.ppid,
    supervisorPid: Number(process.env.KRAKI_SUPERVISED) || undefined,
    managedBy: appManagedWorkerOwner() ?? 'cli',
    osUptimeSec: Math.round(osUptime()),
  }, 'Daemon starting…');

  // Stop and crash handling from the first line on. Startup takes seconds
  // (login-shell env, FDA probe, MCP server, agent runtimes) and a SIGTERM in
  // that window used to kill the worker with Node's default action: no log,
  // and the agent runtimes adapter.start() had spawned were never stopped
  // (log audit 2026-10-22: Mac app updates restarted the helper mid-startup).
  // Until the full shutdown exists, stop whatever startup has created so far.
  let startupPhase = 'init';
  const startupCleanups: Array<() => unknown> = [];
  let fullShutdown: ((reason: string) => Promise<void>) | null = null;
  let stoppingDuringStartup = false;
  const stopDuringStartup = (reason: string, code: number) => {
    if (stoppingDuringStartup) return;
    stoppingDuringStartup = true;
    logger.warn({ reason, phase: startupPhase, uptimeMs: Date.now() - startedAt }, 'Shutdown requested during startup');
    const cleanup = (async () => {
      for (const step of startupCleanups.reverse()) {
        try { await step(); } catch { /* best effort */ }
      }
    })();
    const timeout = new Promise((resolve) => setTimeout(resolve, STARTUP_STOP_CLEANUP_MS));
    void Promise.race([cleanup, timeout]).finally(() => {
      endRun(`${reason} during startup`);
      process.exit(code);
    });
  };
  const onStopSignal = (signal: NodeJS.Signals) => {
    if (fullShutdown) { fullShutdown(signal).catch(() => {}).finally(() => process.exit(0)); return; }
    stopDuringStartup(signal, 0);
  };
  process.on('SIGTERM', onStopSignal);
  process.on('SIGINT', onStopSignal);
  // On an uncaught exception, attempt the same graceful shutdown so the
  // Copilot SDK runtime child is stopped instead of being orphaned. exit(1)
  // to signal the abnormal termination to the launcher / launchctl.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err, phase: fullShutdown ? 'running' : startupPhase }, 'Uncaught exception — attempting graceful shutdown');
    if (fullShutdown) { fullShutdown('uncaught-exception').catch(() => {}).finally(() => process.exit(1)); return; }
    stopDuringStartup('uncaught-exception', 1);
  });
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

  // Kraki for Windows owns the daemon for this home, yet the CLI started us
  // (its login entry or `kraki start` from an older CLI): do not run a second
  // daemon under the same device id; drop the CLI's login entry.
  if (!appManagedWorkerOwner() && platform() === 'win32' && loadManagedBy()?.by === 'kraki-windows') {
    logger.warn('Kraki for Windows runs the daemon for this home; the CLI worker exits');
    const { disableWindowsAutostart } = await import('./windows-autostart.js');
    disableWindowsAutostart();
    return process.exit(0);
  }

  // This worker is the daemon for this home: open its run record and say why
  // it is starting, including whether the previous run died without a trace.
  const run = beginRun(getVersion(), startedAt);
  const heartbeat = setInterval(() => touchRun(), RUN_HEARTBEAT_MS);
  heartbeat.unref();
  startupCleanups.push(() => clearInterval(heartbeat));
  logger.info({
    startReason: run.startReason,
    bootedSincePrevious: run.bootedSincePrevious,
    previous: run.previous && {
      pid: run.previous.pid,
      version: run.previous.version,
      startedAt: run.previous.startedAt,
      lastSeenAt: run.previous.lastSeenAt,
      exitReason: run.previous.exitReason,
    },
  }, 'Daemon start record');
  if (run.previousUnclean && run.previous) {
    logger.warn({
      previousPid: run.previous.pid,
      previousVersion: run.previous.version,
      lastSeenAt: run.previous.lastSeenAt,
      downMs: startedAt - Date.parse(run.previous.lastSeenAt),
      bootedSincePrevious: run.bootedSincePrevious,
    }, 'Previous daemon run ended uncleanly (killed, crashed or the machine lost power)');
  }

  if (managedByMacApp) {
    startupPhase = 'login-shell-env';
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
    // `lsregister -dump` is large and synchronous: sweep once per installed
    // version, not on every daemon start.
    const sweepMarker = join(getKrakiHome(), '.ls-sweep-version');
    let sweptVersion = '';
    try { sweptVersion = readFileSync(sweepMarker, 'utf8').trim(); } catch { /* never swept */ }
    if (sweptVersion !== getVersion()) {
      const sweep = cleanupStaleBundleEntries();
      if (sweep.removed.length > 0) {
        logger.info(
          { removedCount: sweep.removed.length },
          'Cleaned stale Launch Services entries for chat.kraki.cli (TCC hygiene)',
        );
      }
      try { writeFileSync(sweepMarker, getVersion()); } catch { /* retried next start */ }
    }
  }

  // macOS: check Full Disk Access status. FDA is required to prevent
  // recurring TCC permission dialogs during agent sessions. The daemon's own
  // observation is authoritative (TCC decides per responsible process), so it
  // is published in status.json for the Mac app's onboarding to follow.
  let fdaMonitor: NodeJS.Timeout | null = null;
  if (platform() === 'darwin') {
    startupPhase = 'fda-probe';
    const fdaStatus = (await probeFdaDetailed()).status;
    if (fdaStatus !== 'granted') {
      const message = 'Full Disk Access not granted — grant in System Settings → Privacy & Security → Full Disk Access to prevent recurring permission dialogs';
      // Once per state, not on every start: the same warning 89 times taught
      // nobody anything.
      if (run.previous?.fda === fdaStatus) logger.info({ fda: fdaStatus }, 'Full Disk Access still not granted');
      else logger.warn({ fda: fdaStatus }, message);
    }
    noteRunFda(fdaStatus);
    let lastFda = fdaStatus;
    let nextCheckAt = 0;
    const monitorStartedAt = Date.now();
    fdaMonitor = setInterval(() => {
      // Poll quickly while the user may be granting access (the first minutes
      // after start or a change), slowly afterwards (FDA can also be revoked at
      // any time). Every probe also rewrites status.json.
      if (Date.now() < nextCheckAt) return;
      probeFdaDetailed().then(({ status, blockedPath, code }) => {
        if (status !== lastFda) {
          // A grant lost while running is TCC refusing this process (e.g. its
          // executable was replaced or deleted), not the user revoking it, as
          // often as not: say which path failed and whether the binary exists.
          const lost = lastFda === 'granted';
          (lost ? logger.warn : logger.info).call(logger, {
            from: lastFda, to: status, blockedPath, code,
            ...(lost && { execPathExists: existsSync(process.execPath), uptimeMs: Date.now() - startedAt }),
          }, 'Full Disk Access status changed');
          lastFda = status;
          noteRunFda(status);
        }
        updateFdaStatus(status);
        const eager = status !== 'granted' && Date.now() - monitorStartedAt < 10 * 60_000;
        nextCheckAt = Date.now() + (eager ? 0 : 60_000);
      }).catch(() => {});
    }, 3000);
    fdaMonitor.unref();
    const monitor = fdaMonitor;
    startupCleanups.push(() => clearInterval(monitor));
    pendingFda = fdaStatus;
  }

  const configPath = getConfigPath();
  const channelKeyPath = getChannelKeyPath();

  // 1. Load config
  startupPhase = 'config';
  let config = loadConfig();
  if (!config && appManagedWorkerOwner()) {
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
    // Permanent: a supervisor must not restart us until setup has run.
    const { PERMANENT_EXIT_CODE } = await import('./daemon-supervisor.js');
    endRun('no-config');
    process.exit(PERMANENT_EXIT_CODE);
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
  attachmentStore.setFallback((sid) => sessionManager.attachmentsFallback(sid));
  // Offloaded tool args/results accumulate a few files per tool call. Keep
  // them for the archive window, then reclaim them (images/reports stay).
  const TOOL_PAYLOAD_TTL_MS = 14 * 24 * 3600_000;
  const pruneToolPayloads = () => { attachmentStore.pruneToolPayloads(TOOL_PAYLOAD_TTL_MS).catch(() => { /* best effort */ }); };
  setTimeout(pruneToolPayloads, 60_000).unref();
  setInterval(pruneToolPayloads, 24 * 3600_000).unref();

  // 3b. Start Kraki MCP server (in-process HTTP, loopback only). If bind
  //     fails, log and continue without it — daemon stays up.
  let mcpInfo: { urlForSession: (sid: string) => string; tokenForSession: (sid: string) => string } | undefined;
  let mcpServer: KrakiMcpServer | null = null;
  startupPhase = 'mcp-server';
  try {
    mcpServer = new KrakiMcpServer({
      version: getVersion(),
      isSessionActive: (id) => sessionManager.isSessionActive(id),
    });
    const server = mcpServer;
    startupCleanups.push(() => server.stop());
    const started = await mcpServer.start();
    mcpInfo = {
      urlForSession: started.urlForSession,
      tokenForSession: started.tokenForSession,
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
  startupPhase = 'agent-adapters';
  startupCleanups.push(() => adapter.stop());
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
  startupPhase = 'relay';
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
  startupCleanups.push(() => clearStatusFile(), () => relay.disconnect());

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

  relay.onAccountDeleted = () => {
    logger.warn('The Kraki account was deleted — signing this computer out and stopping');
    void (async () => {
      const { forgetDeletedAccount, retireAutostart } = await import('./account-deleted.js');
      forgetDeletedAccount();
      retireAutostart();
      await shutdown('account-deleted').catch(() => {});
      // Clean exit: supervisors don't restart it, and without a config the
      // next `kraki` runs setup from scratch.
      process.exit(0);
    })();
  };

  relay.onDeviceRemoved = () => {
    logger.fatal('This computer was removed from your Kraki account. Run `kraki` to sign in again.');
    void (async () => {
      await shutdown('device-removed').catch(() => {});
      // Permanent: restarting cannot sign in again without the user.
      const { PERMANENT_EXIT_CODE } = await import('./daemon-supervisor.js');
      process.exit(PERMANENT_EXIT_CODE);
    })();
  };

  relay.onFatalError = (message) => {
    logger.fatal({ message }, 'Relay fatal error — exiting so the supervisor can restart');
    // A dead relay client inside a live process looks "running" to every
    // supervisor while the device stays offline forever. Exit non-zero:
    // launchd KeepAlive / the Mac app restart us, and `kraki status` tells
    // the truth.
    shutdown('relay-fatal').catch(() => {}).finally(() => process.exit(1));
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
    refresh: () => updateWatch.checkNow(),
    runningSessions: () => relay.runningSessionCount(),
    emit: (p) => relay.sendUpdateStatus(p),
  });
  relay.onUpdateRequest = async (requestId, when) => {
    // The updater checks for the newest release itself before acting.
    await updater.request(requestId, when);
  };
  const announceUpdateResult = () => {
    const r = remoteUpdate.takeUnannouncedResult();
    if (r) relay.sendUpdateStatus({ phase: r.phase, requestId: r.requestId, from: r.from, to: r.to, error: r.error });
  };
  // The applier writes the outcome only after this (new) daemon is online,
  // so look for it for a few minutes after start, not just once.
  let resultChecks = 0;
  const resultWatch = setInterval(() => {
    if (++resultChecks > 36) { clearInterval(resultWatch); return; }
    if (relay.getState() === 'connected') announceUpdateResult();
  }, 5000);
  resultWatch.unref();
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
  const supervisorPid = Number(process.env.KRAKI_SUPERVISED) || undefined;
  updateDaemonIdentity({ managedBy: appManagedWorkerOwner() ?? 'cli', version: getVersion(), pid: process.pid, supervisorPid });
  if (pendingFda) updateFdaStatus(pendingFda);

  // 6. Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (reason = 'requested') => {
    if (shuttingDown) return;
    shuttingDown = true;
    const shutdownStartedAt = Date.now();
    logger.info({ reason, uptimeMs: shutdownStartedAt - startedAt, runningSessions: relay.runningSessionCount?.() }, 'Shutting down…');
    clearDaemonReady();
    clearDaemonIdentity();
    if (fdaMonitor) clearInterval(fdaMonitor);
    clearInterval(heartbeat);
    usageMonitor?.stop();
    stopUpdateWatch();
    // Disconnect before removing status.json: the disconnect's state change
    // rewrote the file with this (old) version after it had been removed, and
    // Kraki for Mac, seeing an outdated daemon version next to the successor's
    // PID, restarted the successor mid-startup (remote update 2026-10-15).
    relay.disconnect();
    clearStatusFile();
    await adapter.stop();
    if (mcpServer) {
      try { await mcpServer.stop(); } catch { /* already stopped */ }
    }
    endRun(reason);
    logger.info({ reason, durationMs: Date.now() - shutdownStartedAt }, 'Shutdown complete');
  };

  // Supervised (Kraki for Mac): leave if the supervisor is gone, so a killed
  // job never leaves this worker running next to a newly started one.
  const { watchSupervisor } = await import('./daemon-supervisor.js');
  watchSupervisor(() => {
    logger.warn('Supervisor is gone — shutting down');
    shutdown('supervisor-gone').catch(() => {}).finally(() => process.exit(0));
  });
  // SIGTERM/SIGINT/uncaughtException (installed at the top) now run the full
  // shutdown.
  fullShutdown = shutdown;

  // Publish readiness only after every startup-critical component and graceful
  // lifecycle handler is installed. The launcher must not report success before
  // this point.
  // A stop that arrived during startup is already tearing this worker down.
  if (!stoppingDuringStartup) saveDaemonReady(process.pid);

  return { adapter, relay, sessionManager, shutdown };
}

// Auto-run when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.endsWith('daemon-worker.js') || process.argv[1]?.endsWith('daemon-worker.ts');
if (isDirectRun) {
  hideChildWindowsByDefault();
  applyProcessProxy();
  startWorker().catch((err) => {
    logger.fatal({ err }, 'Daemon failed to start');
    endRun('startup-failed');
    process.exit(1);
  });
}
