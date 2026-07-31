import type { ChatMessage } from '../types/store';

/** Durable per-session conversation-spine types.
 *
 * This mirrors Tentacle's fail-closed PERSISTENT_TYPES allowlist. Any new wire
 * type defaults to live/TRACE/control-plane state until it is deliberately
 * added to both authorities. Keeping this list shared across Web projection,
 * range-cache coverage, and IndexedDB prevents a transient record from being
 * mistaken for a durable chat bubble. */
export const DURABLE_SPINE_TYPES = new Set([
  'session_created',
  'agent_message',
  'user_message',
  'error',
  'system_message',
  'interrupted_turn',
  'turn_status',
  'session_ended',
  'idle',
]);

export function isDurableSpineMessage(message: ChatMessage): boolean {
  return DURABLE_SPINE_TYPES.has(message.type);
}
