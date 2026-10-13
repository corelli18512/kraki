/**
 * Codex: show_image completion keeps the turn it started in (the resize is
 * awaited), and ask_user answers carry content_ref images like normal input.
 */
import { describe, expect, it, vi } from 'vitest';

let finishResize!: (v: unknown) => void;
vi.mock('../mcp/tools/show-image.js', () => ({
  showImageHandler: () => new Promise((r) => { finishResize = r; }),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { CodexAdapter } = await import('../adapters/codex.js');
const { handleDynamicTool } = await import('../adapters/codex-requests.js');
const { TurnTracker } = await import('../adapters/turn-tracker.js');

function setup(attachmentStore?: unknown) {
  const adapter = new CodexAdapter({ cliPath: '/unused', sessionsDir: '/unused', attachmentStore: attachmentStore as never });
  const rpc = { alive: true, respond: vi.fn() };
  Object.assign(adapter, { rpc });
  const s = {
    sessionId: 's1', mode: 'auto', turn: new TurnTracker(adapter, 's1'),
    pendingPermissions: new Map(), pendingQuestions: new Map<string, unknown>(),
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set('s1', s);
  return { adapter, rpc, s };
}

describe('Codex show_image', () => {
  it('stamps the completion with the turn it started in', async () => {
    const t = setup();
    t.s.turn.relayTurnId = 'rt-1';
    t.s.turn.beginTurn({ captureNow: true });
    const complete = vi.fn();
    t.adapter.onToolComplete = complete;
    const running = handleDynamicTool(t.adapter, { id: 5, method: 'item/tool/call' } as never, { tool: 'show_image', callId: 'c1', arguments: { path: '/x.png' } }, t.s as never);
    // Stop + a new prompt while the image is being resized.
    t.s.turn.relayTurnId = 'rt-2';
    t.s.turn.beginTurn({ captureNow: true });
    finishResize({ content: [{ type: 'text', text: 'shown' }], isError: false });
    await running;
    expect(complete).toHaveBeenCalledWith('s1', expect.objectContaining({ toolCallId: 'c1', turnId: 'rt-1' }));
  });
});

describe('Codex ask_user answers', () => {
  it('deliver content_ref images (resolved from the attachment store)', async () => {
    const bytes = Buffer.from('png-bytes');
    const store = { read: vi.fn(() => ({ bytes, meta: { mimeType: 'image/png' } })) };
    const t = setup(store);
    t.s.pendingQuestions.set('q1', { rpcId: 9, source: 'ask_user' });
    const result = await t.adapter.respondToQuestion('s1', 'q1', { text: 'see this', attachments: [{ type: 'content_ref', id: 'att-1', mimeType: 'image/png' } as never] }, true);
    expect(result).toBe('accepted');
    expect(store.read).toHaveBeenCalledWith('s1', 'att-1');
    expect(t.rpc.respond).toHaveBeenCalledWith(9, {
      contentItems: [
        { type: 'inputText', text: 'see this' },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${bytes.toString('base64')}` },
      ],
      success: true,
    });
  });
});
