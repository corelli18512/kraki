import { TurnTracker } from '../../adapters/turn-tracker.js';
import type { AgentAdapter } from '../../adapters/base.js';

/** A TurnTracker for hand-built adapter session fixtures. `open`: a prompt is
 *  running (not yet settled). */
export function turnFixture(
  adapter: AgentAdapter,
  sessionId: string,
  opts: { open?: boolean; relayTurnId?: string; eventTurnId?: string } = {},
): TurnTracker {
  const turn = new TurnTracker(adapter, sessionId);
  turn.relayTurnId = opts.relayTurnId;
  if (opts.open) turn.beginTurn();
  turn.eventTurnId = opts.eventTurnId;
  return turn;
}
