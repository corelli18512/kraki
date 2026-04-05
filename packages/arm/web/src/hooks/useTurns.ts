import { useMemo } from 'react';
import type { ChatMessage } from '../types/store';
import { createLogger } from '../lib/logger';

const logger = createLogger('useTurns');

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
  'active',
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
  // Track whether to skip the next tool_complete (from a question tool)
  let skipNextToolComplete = false;

  const flushTurn = (turnComplete: boolean) => {
    if (currentThinking.length === 0) return;

    // Log unmerged tool_starts (tool_start without matching tool_complete)
    const unmatchedStarts = currentThinking.filter(m => m.type === 'tool_start');
    if (unmatchedStarts.length > 0) {
      logger.info('unmerged tool_starts in turn', {
        turnComplete,
        count: unmatchedStarts.length,
        tools: unmatchedStarts.map(m => ({
          seq: 'seq' in m ? (m as { seq?: number }).seq : undefined,
          toolName: (m as { payload?: { toolName?: string } }).payload?.toolName,
          toolCallId: (m as { payload?: { toolCallId?: string } }).payload?.toolCallId,
        })),
      });
    }

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
      // Questions are always shown as standalone chat bubbles,
      // splitting the turn so subsequent messages start a new thinking box.
      // Strip the preceding tool_start that triggered the question, and
      // flag the matching tool_complete (which arrives after answering) to skip.
      if (msg.type === 'question') {
        // Strip the preceding tool event that triggered the question.
        // It may be tool_start (live, before tool completes) or tool_complete
        // (after tool_complete merges back into the tool_start position).
        if (currentThinking.length > 0) {
          const last = currentThinking[currentThinking.length - 1];
          if (last.type === 'tool_start' || last.type === 'tool_complete') {
            currentThinking.pop();
            if (last.type === 'tool_start') skipNextToolComplete = true;
          }
        }
        flushTurn(true);
        result.push({ type: 'standalone', message: msg });
      } else if (msg.type === 'tool_complete' && skipNextToolComplete) {
        skipNextToolComplete = false;
      } else if (msg.type === 'tool_complete') {
        // Replace matching tool_start with this tool_complete (merge args)
        const toolCallId = (msg as { payload?: { toolCallId?: string } }).payload?.toolCallId;
        if (toolCallId) {
          const startIdx = currentThinking.findIndex(m =>
            m.type === 'tool_start' && (m as { payload?: { toolCallId?: string } }).payload?.toolCallId === toolCallId
          );
          if (startIdx >= 0) {
            const startMsg = currentThinking[startIdx];
            const startPayload = (startMsg as { payload?: Record<string, unknown> }).payload ?? {};
            const completePayload = (msg as { payload?: Record<string, unknown> }).payload ?? {};
            const startArgs = (startPayload.args ?? {}) as Record<string, unknown>;
            const completeArgs = (completePayload.args ?? {}) as Record<string, unknown>;
            currentThinking[startIdx] = {
              ...msg,
              seq: (startMsg as { seq?: number }).seq,
              payload: {
                ...completePayload,
                toolName: completePayload.toolName || startPayload.toolName,
                args: { ...startArgs, ...completeArgs },
              },
            } as ChatMessage;
          } else {
            logger.info('tool_complete unmatched', {
              toolCallId,
              seq: ('seq' in msg ? (msg as { seq?: number }).seq : undefined),
              toolName: (msg as { payload?: { toolName?: string } }).payload?.toolName,
              thinkingTypes: currentThinking.map(m => m.type),
            });
            currentThinking.push(msg);
          }
        } else {
          currentThinking.push(msg);
        }
      } else {
        currentThinking.push(msg);
      }
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
