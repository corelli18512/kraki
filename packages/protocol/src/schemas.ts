/**
 * Runtime checks for messages an app sends to a tentacle (ConsumerMessage).
 *
 * The TypeScript interfaces in messages.ts only exist at compile time; a
 * message arriving over the wire is whatever the sender put in it. A tentacle
 * runs `parseConsumerMessage` on every decrypted app message before handling
 * it, so handlers can trust the field types the interfaces promise — and a
 * malformed field (e.g. an attachment without `data`) is never written into a
 * session's history, where every app would read it back.
 *
 * Rules (keep them when adding a message):
 *  - Check the TYPES and SHAPES of fields, not their values. Value rules
 *    (is this agent installed? is this mode name known?) stay in the handler,
 *    which can answer with a proper error instead of silently dropping.
 *  - Require a field only when the handler can't do anything sensible without
 *    it. A field the handler tolerates missing (a requestId it only echoes, a
 *    model it defaults) stays optional, so no message that used to work is
 *    dropped.
 *  - A field that is stored or re-broadcast as-is (an attachment, `pinned`)
 *    must have the exact type apps decode.
 *  - Objects are loose: unknown extra fields pass through untouched, so a
 *    newer app can add fields without an older tentacle dropping its messages.
 *  - Envelope fields a tentacle doesn't use (seq, timestamp) are not required.
 *  - Every ConsumerMessage must be accepted (compile-time check at the bottom).
 *
 * Import from `@kraki/protocol/schemas` (a separate entry, so apps that don't
 * validate don't bundle zod).
 */

import { z } from 'zod';
import type { ConsumerMessage } from './messages.js';

const str = z.string();
const optStr = z.string().optional();
const num = z.number();
const optNum = z.number().optional();
const empty = z.looseObject({}).optional();
/** A seq bound in a history request. The handler sanitizes it and always
 *  replies (an empty batch if it is unusable), so a `null` — what a NaN
 *  becomes in JSON — still gets an answer instead of leaving the app waiting. */
const seqBound = z.number().nullable();

/** An attachment as sent by an app (see ImageAttachment / ContentRef). */
export const attachmentSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('image'), mimeType: str, data: str, caption: optStr, name: optStr }),
  z.looseObject({
    type: z.literal('content_ref'), id: str, mimeType: str, size: num,
    caption: optStr, name: optStr, width: optNum, height: optNum,
  }),
]);

/** One app → tentacle message type with its payload shape. */
function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.looseObject({
    type: z.literal(type),
    deviceId: optStr,
    sessionId: optStr,
    seq: optNum,
    timestamp: optStr,
    payload,
  });
}

export const consumerMessageSchema = z.discriminatedUnion('type', [
  message('send_input', z.looseObject({
    text: str,
    attachments: z.array(attachmentSchema).optional(),
    clientId: optStr,
    delivery: optStr,
    answerTo: optStr,
  })),
  message('approve', z.looseObject({ permissionId: str })),
  message('deny', z.looseObject({ permissionId: str, reason: optStr })),
  message('always_allow', z.looseObject({ permissionId: str, toolKind: optStr })),
  message('kill_session', empty),
  message('abort_session', empty),
  message('create_session', z.looseObject({
    requestId: optStr,
    targetDeviceId: optStr,
    agentId: optStr,
    model: optStr,
    reasoningEffort: optStr,
    contextTier: optStr,
    prompt: optStr,
    cwd: optStr,
  })),
  message('fork_session', z.looseObject({ requestId: optStr, sourceSessionId: str })),
  message('set_session_mode', z.looseObject({ mode: str })),
  message('set_session_model', z.looseObject({ model: str, reasoningEffort: optStr, contextTier: optStr })),
  message('delete_session', empty),
  message('mark_read', z.looseObject({ seq: num })),
  message('mark_unread', empty),
  message('request_session_replay', z.looseObject({ sessionId: str, afterSeq: seqBound, limit: optNum })),
  message('request_session_messages', z.looseObject({ sessionId: str, beforeSeq: seqBound.optional(), afterSeq: seqBound.optional() })),
  message('request_session_messages_range', z.looseObject({ sessionId: str, fromSeq: seqBound, toSeq: seqBound })),
  message('request_turn_trace', z.looseObject({ sessionId: str, bubbleSeq: seqBound })),
  message('request_card', z.looseObject({ sessionId: str })),
  message('rename_session', z.looseObject({ title: str })),
  message('pin_session', z.looseObject({ pinned: z.boolean() })),
  message('archive_session', z.looseObject({ archived: z.boolean() })),
  message('request_archived_sessions', z.looseObject({ requestId: optStr }).optional()),
  message('set_auto_archive_days', z.looseObject({ days: num })),
  message('delete_archived_sessions', empty),
  message('request_local_sessions', z.looseObject({
    requestId: optStr,
    filter: z.looseObject({ search: optStr, liveOnly: z.boolean().optional(), includeLinked: z.boolean().optional() }).optional(),
  }).optional()),
  message('import_session', z.looseObject({
    requestId: optStr,
    localSessionId: str,
    meta: z.looseObject({
      cwd: optStr, summary: optStr, source: optStr, model: optStr, branch: optStr, startTime: optStr,
    }).optional(),
  })),
  message('request_attachment', z.looseObject({ id: str, sessionId: str, mode: optStr, index: optNum })),
  message('set_session_subscription', z.looseObject({ sessionId: z.string().nullish(), requestId: optStr })),
  // Unknown feature names are ignored by the handler, so any array passes.
  message('client_features', z.looseObject({ features: z.array(z.unknown()).optional() }).optional()),
  message('request_usage_history', z.looseObject({ since: optNum }).optional()),
  message('refresh_account_usage', z.looseObject({ requestId: optStr }).optional()),
  message('update_device', z.looseObject({ requestId: optStr, when: optStr }).optional()),
]);

/** Every app → tentacle message type this protocol version knows. */
export const CONSUMER_MESSAGE_TYPES: ReadonlySet<string> = new Set(
  consumerMessageSchema.options.map((option) => option.shape.type.value),
);

export type ConsumerMessageCheck =
  | { ok: true; message: ConsumerMessage }
  /** `unknownType`: a type this version doesn't know (e.g. from a newer app). */
  | { ok: false; type: string | undefined; unknownType: boolean; problem: string };

/** Check a decrypted app message. `problem` names the offending fields and
 *  what was expected, never their values (they can be user content). */
export function parseConsumerMessage(value: unknown): ConsumerMessageCheck {
  const result = consumerMessageSchema.safeParse(value);
  if (result.success) return { ok: true, message: result.data as unknown as ConsumerMessage };
  const type = value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type
    : undefined;
  const unknownType = type === undefined || !CONSUMER_MESSAGE_TYPES.has(type);
  const problem = unknownType
    ? 'unknown message type'
    : result.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || '(message)'}: ${issue.message}`).join('; ');
  return { ok: false, type, unknownType, problem };
}

// Compile-time: every message the interfaces allow must pass the schema.
// (If this errors, a schema above is stricter than its interface.) Loose
// objects add an index signature the interfaces don't have; compare without it.
type KnownFields<T> = T extends readonly (infer U)[]
  ? KnownFields<U>[]
  : T extends object
    ? { [K in keyof T as string extends K ? never : K]: KnownFields<T[K]> }
    : T;
const _everyConsumerMessagePasses = (m: ConsumerMessage): KnownFields<z.input<typeof consumerMessageSchema>> => m;
void _everyConsumerMessagePasses;
