/** Requests from the Codex app-server: approvals, user input, Kraki's dynamic tools. */

import type { ToolArgs } from '@kraki/protocol';
import { type RpcId, type RpcServerRequest } from './codex-rpc.js';
import { isKrakiSelfManagementCommand, SELF_MANAGEMENT_DENIAL_REASON } from '../self-management-guard.js';
import { showImageHandler } from '../mcp/tools/show-image.js';
import { DELEGATE_ANSWER } from './permission-policy.js';
import type { CodexAdapter } from './codex.js';
import { str, unwrapShellCommand } from './codex-items.js';
import { logger, codexShouldAutoApprove, makeId, type PendingPermission, type PendingQuestion, type CodexSession } from './codex-session.js';

export async function handleServerRequest(adapter: CodexAdapter, req: RpcServerRequest): Promise<void> {
  const rpc = adapter.rpc!;
  const params = (req.params ?? {}) as Record<string, unknown>;
  const owner = adapter.sessionForRequest(params);
  const s = owner?.s;
  // Approval cards raised by a subagent say so.
  const who = owner?.child ? `Subagent ${owner.child} — ` : '';

  switch (req.method) {
    case 'item/commandExecution/requestApproval': {
      if (!s) return rpc.respond(req.id, { decision: 'decline' });
      const rawCommand = str(params.command);
      const command = unwrapShellCommand(rawCommand);
      if (isKrakiSelfManagementCommand(command) || isKrakiSelfManagementCommand(rawCommand)) {
        // Codex's decline carries no reason text; the model sees the command
        // was declined. Log the Kraki reason for operators.
        logger.warn({ sessionId: s.sessionId, reason: SELF_MANAGEMENT_DENIAL_REASON }, 'blocked tentacle self-management command');
        return rpc.respond(req.id, { decision: 'decline' });
      }
      const pending: PendingPermission = { rpcId: req.id, kind: 'command', toolKind: 'shell', params };
      const reason = str(params.reason);
      return gate(adapter, s, pending, [], {
        toolArgs: { toolName: 'shell', args: { command } },
        description: who + (command ? `Run: ${command}` : (reason || 'Run a command')),
      });
    }

    case 'item/fileChange/requestApproval': {
      if (!s) return rpc.respond(req.id, { decision: 'decline' });
      const tracked = s.tools.get(str(params.itemId));
      const paths = (tracked?.args.paths as string[] | undefined) ?? [];
      const grantRoot = str(params.grantRoot);
      const pending: PendingPermission = { rpcId: req.id, kind: 'file', toolKind: 'write', params };
      const label = paths.length ? paths.join(', ') : (grantRoot || 'files');
      return gate(adapter, s, pending, grantRoot ? [grantRoot] : paths, {
        toolArgs: { toolName: 'write_file', args: { path: paths[0] ?? grantRoot, content: str(tracked?.args.diff) } },
        description: `${who}${str(params.reason) || 'Edit'}: ${label}`,
      });
    }

    case 'item/permissions/requestApproval': {
      if (!s) return rpc.respond(req.id, { permissions: {}, scope: 'turn' });
      const perms = (params.permissions ?? {}) as Record<string, unknown>;
      const toolKind = perms.fileSystem ? 'write' : 'shell';
      const pending: PendingPermission = { rpcId: req.id, kind: 'permissions', toolKind, params };
      return gate(adapter, s, pending, [], {
        toolArgs: { toolName: 'permissions', args: perms },
        description: who + (str(params.reason) || `Grant extra permissions: ${Object.keys(perms).filter((k) => perms[k]).join(', ') || 'unspecified'}`),
      });
    }

    case 'item/tool/call':
      return handleDynamicTool(adapter, req, params, s);

    case 'item/tool/requestUserInput': {
      if (!s) return rpc.respond(req.id, { answers: {} });
      const qs = Array.isArray(params.questions) ? params.questions as PendingQuestion['questions'] : [];
      if (!qs || qs.length === 0) return rpc.respond(req.id, { answers: {} });
      if (s.mode === 'delegate') {
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of qs) answers[q.id] = { answers: [DELEGATE_ANSWER] };
        return rpc.respond(req.id, { answers });
      }
      emitNativeQuestion(adapter, s, req.id, qs, 0, {});
      return;
    }

    case 'mcpServer/elicitation/request':
      return rpc.respond(req.id, { action: 'decline', content: null, _meta: null });

    // Legacy v1 approvals are never used by v2 threads; refuse defensively.
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return rpc.respond(req.id, { decision: 'denied' });

    default:
      logger.debug({ method: req.method }, 'codex: unsupported server request');
      return rpc.respondError(req.id, `Kraki does not support ${req.method}`, -32601);
  }
}

/** Apply Kraki's mode policy: auto-answer, or raise a permission card. */
export function gate(
  adapter: CodexAdapter,
  s: CodexSession,
  pending: PendingPermission,
  paths: string[],
  card: { toolArgs: ToolArgs; description: string },
): void {
  if (codexShouldAutoApprove(s.mode, pending.toolKind)) {
    adapter.answerPermission(pending, true);
    return;
  }
  const id = makeId('perm');
  s.pendingPermissions.set(id, pending);
  adapter.onPermissionRequest?.(s.sessionId, { id, ...card, ...adapter.turnEvent(s) });
}

export function emitNativeQuestion(
  adapter: CodexAdapter,
  s: CodexSession,
  rpcId: RpcId,
  qs: NonNullable<PendingQuestion['questions']>,
  index: number,
  collected: Record<string, { answers: string[] }>,
): void {
  const q = qs[index];
  const id = makeId('q');
  s.pendingQuestions.set(id, { rpcId, source: 'native', questions: qs, index, collected });
  const choices = q.options?.map((o) => o.label).filter(Boolean);
  adapter.onQuestionRequest?.(s.sessionId, {
    id,
    question: q.question || 'The agent has a question',
    ...(choices && choices.length > 0 && { choices }),
    ...adapter.turnEvent(s),
  });
}

export async function handleDynamicTool(adapter: CodexAdapter, req: RpcServerRequest, params: Record<string, unknown>, s: CodexSession | undefined): Promise<void> {
  const rpc = adapter.rpc!;
  const tool = str(params.tool);
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
  const fail = (text: string) => rpc.respond(req.id, { contentItems: [{ type: 'inputText', text }], success: false });
  if (!s) return fail('Unknown Kraki session.');

  switch (tool) {
    case 'kraki_get_mode':
      return rpc.respond(req.id, { contentItems: [{ type: 'inputText', text: s.mode }], success: true });

    case 'ask_user': {
      const question = str(args.question) || 'The agent has a question';
      if (s.mode === 'delegate') {
        return rpc.respond(req.id, { contentItems: [{ type: 'inputText', text: DELEGATE_ANSWER }], success: true });
      }
      adapter.flushNarration(s);
      const choices = Array.isArray(args.choices) ? (args.choices as unknown[]).map(str).filter(Boolean) : [];
      const id = makeId('q');
      s.pendingQuestions.set(id, { rpcId: req.id, source: 'ask_user' });
      adapter.onQuestionRequest?.(s.sessionId, {
        id,
        question,
        ...(choices.length > 0 && { choices }),
        ...adapter.turnEvent(s),
      });
      return;
    }

    case 'show_image': {
      adapter.flushNarration(s);
      const callId = str(params.callId) || makeId('tool');
      adapter.onToolStart?.(s.sessionId, { toolName: 'show_image', args, toolCallId: callId, ...adapter.turnEvent(s) });
      const result = await showImageHandler(args, { sessionId: s.sessionId });
      const text = result.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
      const refs: import('@kraki/protocol').ContentRef[] = [];
      if (!result.isError && adapter.opts.attachmentStore) {
        for (const c of result.content) {
          if (c.type !== 'image') continue;
          const img = c as { data: string; mimeType: string };
          const caption = str(args.caption).trim();
          refs.push(adapter.opts.attachmentStore.put(s.sessionId, Buffer.from(img.data, 'base64'), img.mimeType, caption ? { caption } : {}));
        }
      }
      adapter.onToolComplete?.(s.sessionId, {
        toolName: 'show_image',
        result: text,
        toolCallId: callId,
        success: !result.isError,
        ...(refs.length > 0 && { attachments: refs }),
        ...adapter.turnEvent(s),
      });
      return rpc.respond(req.id, { contentItems: [{ type: 'inputText', text: text || 'Done.' }], success: !result.isError });
    }

    default:
      return fail(`Unknown tool: ${tool}`);
  }
}
