/** The Pi adapter's model list: fetching, retrying, the default model, efforts per model. */

import { execSync } from 'node:child_process';
import { readPiModelScope, scopePiModels } from './pi-model-scope.js';
import type { ReasoningEffort } from '@kraki/protocol';
import type { PiAdapter } from './pi.js';
import { type PiModelRow, parsePiListModels, type PiListModelsError, runPiListModels, resolveDefaultModel, piThinkingLevelsFor, queryPiCatalog } from './pi-catalog.js';
import { logger } from './pi-session.js';

export function fetchModels(adapter: PiAdapter): PiModelRow[] {
  // Cache only the raw catalog: reread preferences for every capabilities
  // request so an already-running adapter can pick up scope changes.
  try {
    adapter.modelScope = readPiModelScope();
    adapter.scopeLoaded = true;
  } catch {
    logger.warn('Could not read Pi enabledModels; retaining last valid scope');
    if (!adapter.scopeLoaded) return [];
  }
  return scopePiModels(adapter.cachedModels ?? [], adapter.modelScope);
}

/** Load the raw catalog without blocking the daemon's event loop. Concurrent
 *  callers share one pi process. On failure the list stays unloaded, a
 *  backoff retry is scheduled, and the eventual success is announced via
 *  `onCapabilitiesChanged` so apps receive the models without a restart. */
export function ensureRawModels(adapter: PiAdapter): Promise<PiModelRow[] | null> {
  if (adapter.cachedModels) return Promise.resolve(adapter.cachedModels);
  if (adapter.modelsLoad) return adapter.modelsLoad;
  const load = (async () => {
    const started = Date.now();
    try {
      const rows = parsePiListModels(await runPiListModels(adapter.cliPath, adapter.modelListTimeoutMs));
      if (adapter.stopped) return null;
      adapter.cachedModels = rows;
      const recovered = adapter.modelListFailed;
      adapter.modelListFailed = false;
      adapter.modelRetryAttempt = 0;
      clearModelRetry(adapter);
      logger.info({ count: rows.length, elapsedMs: Date.now() - started, recovered }, 'Fetched pi model list');
      if (recovered) adapter.onCapabilitiesChanged?.();
      return rows;
    } catch (err) {
      const e = err as PiListModelsError;
      adapter.modelListFailed = true;
      adapter.lastModelListError = e.message;
      logger.warn({
        err: e.message,
        elapsedMs: Date.now() - started,
        timeoutMs: adapter.modelListTimeoutMs,
        timedOut: e.timedOut ?? false,
        exitCode: e.exitCode,
        signal: e.signal,
        stdoutTail: e.stdoutTail,
        stderrTail: e.stderrTail,
        attempt: adapter.modelRetryAttempt + 1,
      }, 'Could not fetch pi model list; will retry');
      scheduleModelRetry(adapter);
      return null;
    } finally {
      adapter.modelsLoad = null;
    }
  })();
  adapter.modelsLoad = load;
  return load;
}

export function scheduleModelRetry(adapter: PiAdapter): void {
  if (adapter.stopped || adapter.modelRetryTimer) return;
  const delays = adapter.modelListRetryDelaysMs;
  const delay = delays[Math.min(adapter.modelRetryAttempt, delays.length - 1)];
  adapter.modelRetryAttempt += 1;
  adapter.modelRetryTimer = setTimeout(() => {
    adapter.modelRetryTimer = null;
    void ensureRawModels(adapter);
  }, delay);
  adapter.modelRetryTimer.unref?.();
}

export function clearModelRetry(adapter: PiAdapter): void {
  if (adapter.modelRetryTimer) clearTimeout(adapter.modelRetryTimer);
  adapter.modelRetryTimer = null;
}

/** Synchronous last resort for session spawn paths that need a default model
 *  before any async capabilities request completed. Same behavior as before
 *  (blocking read), except that a failure is not cached. */
export function ensureRawModelsSync(adapter: PiAdapter): void {
  // This blocks the daemon's event loop (up to the list timeout); after a
  // failure, leave recovery to the scheduled async retry instead of
  // blocking again on every session spawn.
  if (adapter.cachedModels || adapter.modelListFailed) return;
  try {
    const stdout = execSync(`"${adapter.cliPath}" --list-models`, {
      encoding: 'utf-8',
      timeout: adapter.modelListTimeoutMs,
      env: process.env,
    });
    adapter.cachedModels = parsePiListModels(stdout);
    logger.info({ count: adapter.cachedModels.length }, 'Fetched pi model list (sync)');
    if (adapter.modelListFailed) {
      adapter.modelListFailed = false;
      clearModelRetry(adapter);
      adapter.onCapabilitiesChanged?.();
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Could not fetch pi model list (sync)');
    adapter.modelListFailed = true;
    adapter.lastModelListError = (err as Error).message;
    scheduleModelRetry(adapter);
  }
}

export function getDefaultModel(adapter: PiAdapter): string {
  ensureRawModelsSync(adapter);
  const models = fetchModels(adapter);
  if (adapter.modelScope?.length || !adapter.scopeLoaded) {
    if (!models.length) throw new Error('No Pi models match enabledModels; check Pi settings');
    return `${models[0].provider}/${models[0].model}`;
  }
  return resolveDefaultModel(models);
}

/** Ask pi for its catalog over a throwaway rpc process. This is the only
 *  interface that exposes each model's thinkingLevelMap, and thus the only way
 *  to tell a model that genuinely has `max` (Opus 5, Fable 5, GLM 5.2) from one
 *  whose top rung is `low` (GPT-5.6 Luna). Best-effort: on any failure the
 *  caller keeps the old fixed ladder rather than losing the model list. Failed
 *  lookups are deliberately NOT cached, so a transient pi startup/RPC failure
 *  heals on the next capabilities refresh instead of lasting until daemon
 *  restart. */
export async function fetchEfforts(adapter: PiAdapter): Promise<Map<string, ReasoningEffort[]>> {
  if (adapter.cachedEfforts) return adapter.cachedEfforts;
  const started = Date.now();
  try {
    const efforts = new Map<string, ReasoningEffort[]>();
    const models = await queryPiCatalog(adapter.cliPath);
    for (const m of models) {
      if (!m?.id || !m?.provider) continue;
      efforts.set(`${m.provider}/${m.id}`, piThinkingLevelsFor(m));
    }
    logger.info({ count: efforts.size, elapsedMs: Date.now() - started }, 'Fetched pi thinking levels');
    adapter.cachedEfforts = efforts;
    return efforts;
  } catch (err) {
    logger.warn({ err: (err as Error).message, elapsedMs: Date.now() - started }, 'Could not fetch pi thinking levels, using default ladder');
    return new Map();
  }
}
