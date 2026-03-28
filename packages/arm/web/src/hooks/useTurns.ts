import { useMemo } from 'react';
import type { ChatMessage } from '../types/store';

export interface Turn {
  /** Messages that form the "thinking" process (tool calls, intermediate agent messages, permissions, etc.) */
  thinkingMessages: ChatMessage[];
  /** The final agent_message in this turn (null if turn is still in progress) */
  finalMessage: ChatMessage | null;
}

interface StandaloneGroup {
  type: 'standalone';
  message: ChatMessage;
}

interface TurnGroup {
  type: 'turn';
  turn: Turn;
}

type GroupedMessages = StandaloneGroup | TurnGroup;

/** Message types that always display as standalone (never collapsed into thinking) */
const STANDALONE_TYPES = new Set([
  'user_message',
  'send_input',
  'pending_input',
  'answer',
  'session_created',
  'session_ended',
  'kill_session',
  'session_deleted',
]);

/** Message types that belong in the thinking box */
const THINKING_TYPES = new Set([
  'tool_start',
  'tool_complete',
  'agent_message',
  'permission',
  'question',
  'error',
  'approve',
  'deny',
  'always_allow',
  'session_mode_set',
]);

/** Message types that signal the end of an agent turn */
const TURN_COMPLETE_TYPES = new Set([
  'idle',
]);

/**
 * Groups a flat message list into turn-based structure.
 *
 * Rules:
 * - Standalone messages (user_message, send_input, session_created, etc.) are emitted directly.
 * - Between user messages, all agent-side messages are grouped into a Turn.
 * - Within a Turn, all messages except the last agent_message go into `thinkingMessages`.
 * - The last agent_message becomes `finalMessage`.
 * - If a turn has no agent_message, finalMessage is null (turn in progress).
 * - If a turn has only one agent_message and zero thinking messages, finalMessage is set and thinkingMessages is empty (no ThinkingBox needed).
 */
export function groupMessagesIntoTurns(messages: ChatMessage[]): GroupedMessages[] {
  const result: GroupedMessages[] = [];
  let currentThinking: ChatMessage[] = [];

  const flushTurn = (turnComplete: boolean) => {
    if (currentThinking.length === 0) return;

    if (!turnComplete) {
      // Turn still in progress — everything stays in thinking
      result.push({ type: 'turn', turn: { thinkingMessages: currentThinking, finalMessage: null } });
    } else {
      // Turn is complete — find the last agent_message as the final output
      let lastAgentIdx = -1;
      for (let i = currentThinking.length - 1; i >= 0; i--) {
        if (currentThinking[i].type === 'agent_message') {
          lastAgentIdx = i;
          break;
        }
      }

      if (lastAgentIdx === -1) {
        // No agent_message — just thinking steps
        result.push({ type: 'turn', turn: { thinkingMessages: currentThinking, finalMessage: null } });
      } else {
        const thinking = currentThinking.filter((_, i) => i !== lastAgentIdx);
        const finalMsg = currentThinking[lastAgentIdx];
        result.push({ type: 'turn', turn: { thinkingMessages: thinking, finalMessage: finalMsg } });
      }
    }

    currentThinking = [];
  };

  for (const msg of messages) {
    if (STANDALONE_TYPES.has(msg.type)) {
      flushTurn(true);
      result.push({ type: 'standalone', message: msg });
    } else if (TURN_COMPLETE_TYPES.has(msg.type)) {
      flushTurn(true);
    } else if (THINKING_TYPES.has(msg.type)) {
      currentThinking.push(msg);
    } else {
      // Unknown type — treat as standalone to be safe
      flushTurn(true);
      result.push({ type: 'standalone', message: msg });
    }
  }

  // Flush any remaining turn — still in progress (no standalone followed)
  flushTurn(false);

  return result;
}

export function useTurns(messages: ChatMessage[]): GroupedMessages[] {
  return useMemo(() => groupMessagesIntoTurns(messages), [messages]);
}

export type { GroupedMessages };
