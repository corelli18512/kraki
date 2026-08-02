import type { McpToolResult } from '../protocol.js';
import type { RegisteredTool } from './index.js';
import type { WakeScheduler } from '../../wake-scheduler.js';

export const SCHEDULE_WAKE_TOOL_NAME = 'schedule_wake';

function errorResult(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createScheduleWakeTool(scheduler: WakeScheduler): RegisteredTool {
  return {
    definition: {
      name: SCHEDULE_WAKE_TOOL_NAME,
      description:
        'Schedule Kraki to wake this same agent session in the future. Use at for a one-time ISO-8601 timestamp, or cron plus timezone for a recurring wake. The agent process may exit; Tentacle persists the trigger and restores this session when it fires.',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'The task to execute when this session is woken.' },
          label: { type: 'string', description: 'Optional short user-facing name.' },
          at: { type: 'string', description: 'One-time ISO-8601 timestamp with timezone.' },
          cron: { type: 'string', description: 'Recurring 5- or 6-field cron expression.' },
          timezone: { type: 'string', description: 'Required IANA timezone for cron, e.g. Asia/Shanghai.' },
        },
        required: ['instruction'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      try {
        const trigger = scheduler.schedule({
          sessionId: ctx.sessionId,
          instruction: typeof args.instruction === 'string' ? args.instruction : '',
          ...(typeof args.label === 'string' && { label: args.label }),
          ...(typeof args.at === 'string' && { at: args.at }),
          ...(typeof args.cron === 'string' && { cron: args.cron }),
          ...(typeof args.timezone === 'string' && { timezone: args.timezone }),
        });
        return {
          content: [{
            type: 'text',
            text: `Wake scheduled for ${trigger.nextRunAt} (id: ${trigger.id}). It will resume this same Kraki session.`,
          }],
        };
      } catch (err) {
        return errorResult(`Could not schedule wake: ${(err as Error).message}`);
      }
    },
  };
}
