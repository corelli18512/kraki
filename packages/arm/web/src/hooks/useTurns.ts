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
  'idle',
  'session_mode_set',
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

  const flushTurn = () => {
    if (currentThinking.length === 0) return;

    // Find the last agent_message in the accumulated thinking
    let lastAgentIdx = -1;
    for (let i = currentThinking.length - 1; i >= 0; i--) {
      if (currentThinking[i].type === 'agent_message') {
        lastAgentIdx = i;
        break;
      }
    }

    if (lastAgentIdx === -1) {
      // No agent_message yet — turn in progress
      result.push({ type: 'turn', turn: { thinkingMessages: currentThinking, finalMessage: null } });
    } else if (lastAgentIdx === 0 && currentThinking.length === 1) {
      // Single agent_message, no thinking steps — show directly
      result.push({ type: 'turn', turn: { thinkingMessages: [], finalMessage: currentThinking[0] } });
    } else {
      // Has thinking steps + final message
      const thinking = currentThinking.slice(0, lastAgentIdx);
      const finalMsg = currentThinking[lastAgentIdx];
      // Any messages after the final agent_message go into thinking of next implicit turn
      const trailing = currentThinking.slice(lastAgentIdx + 1);

      result.push({ type: 'turn', turn: { thinkingMessages: thinking, finalMessage: finalMsg } });

      // If there are trailing messages (e.g. tool calls after the last agent_message),
      // they start a new in-progress turn
      if (trailing.length > 0) {
        result.push({ type: 'turn', turn: { thinkingMessages: trailing, finalMessage: null } });
      }
    }

    currentThinking = [];
  };

  for (const msg of messages) {
    if (STANDALONE_TYPES.has(msg.type)) {
      flushTurn();
      result.push({ type: 'standalone', message: msg });
    } else if (THINKING_TYPES.has(msg.type)) {
      currentThinking.push(msg);
    } else {
      // Unknown type — treat as standalone to be safe
      flushTurn();
      result.push({ type: 'standalone', message: msg });
    }
  }

  // Flush any remaining turn
  flushTurn();

  return result;
}

export function useTurns(messages: ChatMessage[]): GroupedMessages[] {
  return useMemo(() => groupMessagesIntoTurns(messages), [messages]);
}

export type { GroupedMessages };
