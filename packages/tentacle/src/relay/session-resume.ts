/** Reopening sessions after a restart and handing input to their agent. */

import type { RelayClient } from '../relay-client.js';
import { finishTurnWithStatus, sendTurnIdle } from './turns.js';
import { logger, SessionResumeError } from './shared.js';

/**
 * On startup, sessions remain `disconnected` on disk — they are NOT eagerly
 * loaded into the runtime. Instead, each session is lazily resumed on first
 * user interaction via {@link ensureSessionResumed}. This avoids the O(N)
 * memory cost of loading every historical session into the runtime process.
 *
 * We force-normalise any sessions still in `active`/`idle` state from a
 * previous (possibly un-graceful) daemon exit to `disconnected`, restoring
 * the invariant "active/idle == loaded in the runtime". Without this, a
 * leftover `active` state from a crash would make ensureSessionResumed
 * skip resume (because state ≠ 'disconnected') even though the runtime
 * has no handle for the session.
 */
export async function resumeDisconnectedSessions(client: RelayClient): Promise<void> {
  const resumable = client.sessionManager.getResumableSessions();
  // Normalising is for leftovers of a PREVIOUS daemon process. This runs on
  // every auth_ok, i.e. also after a relay reconnect, when active/idle
  // sessions are genuinely loaded and possibly mid-turn: marking those
  // disconnected made every running session look stopped to the apps after
  // a Head restart (and turned the next message into a fresh prompt instead
  // of a steer). So only the first authentication of this process
  // normalises.
  const normalise = !client.startupSessionsNormalised;
  client.startupSessionsNormalised = true;
  let normalised = 0;
  for (const meta of resumable) {
    // Pre-register agent mapping so message routing works BEFORE the session
    // is lazy-resumed on first interaction. Without this, any message that
    // arrives before ensureSessionResumed runs (approve/deny/answer/kill/
    // abort/set_session_mode, or the very first send_input on an active/idle
    // meta that skips the lazy-resume gate) hits MultiAgentAdapter with no
    // known agent → falls through to the default (first) adapter → fails
    // with "Session not found" for claude/pi sessions. registerSessionAgent
    // is a no-op on single-agent adapters and idempotent on the multi one.
    client.adapter.registerSessionAgent(meta.id, meta.agent);
    if (normalise && (meta.state === 'active' || meta.state === 'idle')) {
      if (meta.state === 'active') closeTurnLostInRestart(client, meta.id);
      client.sessionManager.markDisconnected(meta.id);
      normalised++;
    }
  }
  if (resumable.length > 0) {
    logger.info(
      { count: resumable.length, normalised },
      'Sessions available for lazy resume on first interaction',
    );
  }
}

/**
 * A session left `active` by the previous daemon process (restart or update
 * mid-turn) whose spine ends with the user's prompt never got an outcome:
 * the conversation would just stop after the user's message. Record the
 * turn as failed so every app shows why. A session waiting on an agent
 * question is left alone — its answer can still resume it.
 *
 * The failure must be followed by an `idle`, exactly like a turn settled by
 * the adapter. `idle` is the turn boundary on the spine (`idleSeqs`, client
 * projection): without it the user's next prompt and its reply are joined
 * to this failed turn, and clients fold that reply into the failure row so
 * it disappears from the chat.
 */
export function closeTurnLostInRestart(client: RelayClient, sessionId: string): void {
  const lastSeq = client.sessionManager.getMeta(sessionId)?.lastSeq ?? 0;
  if (lastSeq <= 0) return;
  const [last] = client.sessionManager.getMessagesAfterSeq(sessionId, lastSeq - 1, 1);
  if (last?.type !== 'user_message') return;
  finishTurnWithStatus(client, sessionId, {
    type: 'failed',
    payload: {
      message: 'Kraki restarted on this computer while this turn was running.',
      code: 'process_lost',
      failedAt: new Date().toISOString(),
    },
  });
  // No push: the failure row already marks the session unread, and a daemon
  // restart must not fan out one notification per interrupted session.
  sendTurnIdle(client, sessionId, { reason: 'failed' }, null);
}

/**
 * Ensure a session is loaded into the adapter runtime, resuming it from
 * disk if it is still in `disconnected` state. This is the lazy-resume
 * counterpart to the old eager `resumeDisconnectedSessions` flow.
 *
 * Concurrent calls for the same sessionId share a single in-flight resume
 * so we don't double-resume into the SDK and corrupt the session entry.
 *
 * Returns true if the session was freshly resumed, false if it was already
 * active/idle (or the resume failed).
 */
/** Send to the adapter; if the runtime lost the session while meta still
 *  says it is loaded (state drift after an agent crash), reattach once and
 *  retry instead of surfacing "Session not found: <id>". */
export async function sendToAdapter(
  client: RelayClient,
  sessionId: string,
  text: string,
  attachments?: import('@kraki/protocol').Attachment[],
  options?: import('../adapters/base.js').SendMessageOptions,
): Promise<void> {
  const send = () => options
    ? client.adapter.sendMessage(sessionId, text, attachments, options)
    : client.adapter.sendMessage(sessionId, text, attachments);
  try {
    await send();
  } catch (err) {
    if (!/Session not found/i.test((err as Error)?.message ?? '')) throw err;
    logger.warn({ sessionId }, 'Adapter lost a loaded session; reattaching and retrying once');
    client.sessionManager.markDisconnected(sessionId);
    await ensureSessionResumed(client, sessionId);
    await send();
  }
}

export async function ensureSessionResumed(client: RelayClient, sessionId: string, restoreModel = true, active = true): Promise<boolean> {
  const existing = client.resumeInFlight.get(sessionId);
  if (existing) return existing;

  const meta = client.sessionManager.getMeta(sessionId);
  // `ended` is also recoverable: older adapters marked a crashed agent
  // process as ended although its transcript is intact.
  if (!meta || (meta.state !== 'disconnected' && meta.state !== 'ended')) return false;

  const promise = (async () => {
    try {
      const result = client.sessionManager.resumeSession(sessionId, active);
      if (!result) return false;
      // Tell the adapter which agent owns this session (for multi-agent routing)
      client.adapter.registerSessionAgent(sessionId, meta.agent);
      await client.adapter.resumeSession(sessionId, result.context);
      // Restore permission mode from persisted meta
      if (meta.mode) {
        client.adapter.setSessionMode(sessionId, meta.mode);
      }
      // Restore the user-selected model on resume. The SDK's session
      // state remembers the last model used for prior turns, but that
      // model may be retired by the time we resume (e.g. after Copilot
      // rotates its model lineup). Pushing kraki's persisted meta.model
      // back into the SDK ensures the next turn uses the model the user
      // intended, not whatever the SDK happened to write last.
      if (restoreModel && meta.model) {
        try {
          await client.adapter.setSessionModel(sessionId, meta.model);
        } catch (err) {
          logger.warn(
            { err, sessionId, model: meta.model },
            'Failed to restore session model on resume — SDK will use its persisted model',
          );
        }
      }
      // Restore persisted usage totals so accumulation continues
      if (meta.usage) {
        client.adapter.setSessionUsage(sessionId, meta.usage);
      }
      logger.info({ sessionId }, 'Session lazily resumed on first interaction');
      return true;
    } catch (err) {
      logger.warn({ err, sessionId }, 'Lazy session resume failed; leaving as disconnected');
      client.sessionManager.markDisconnected(sessionId);
      // Surface the real cause. Returning false let the caller continue into
      // the adapter, which then reported an opaque "Session not found: <id>".
      throw new SessionResumeError(meta.agent, err);
    } finally {
      client.resumeInFlight.delete(sessionId);
    }
  })();
  client.resumeInFlight.set(sessionId, promise);
  return promise;
}
