import { test, expect, type Page } from '@playwright/test';
import { MockRelayServer } from './helpers/mock-ws-server';
import type { WebSocket } from 'ws';

const SESSION_ID = 'session-abort-refresh';
const DEVICE_ID = 'tentacle-abort-refresh';
const DEVICE = {
  id: DEVICE_ID,
  name: 'Pi verification tentacle',
  role: 'tentacle',
  kind: 'cli',
  online: true,
};
const SESSION = {
  id: SESSION_ID,
  deviceId: DEVICE_ID,
  deviceName: 'Pi verification tentacle',
  agent: 'pi',
  model: 'claude-sonnet-4',
  state: 'idle',
  messageCount: 0,
  lastSeq: 0,
};

async function connect(page: Page, server: MockRelayServer, session = SESSION): Promise<WebSocket> {
  const connection = server.waitForConnection();
  await page.goto(`/?relay=${encodeURIComponent(server.url)}`);
  const ws = await connection;
  await server.waitForMessage(ws); // auth
  server.sendAuthOk(ws, { sessions: [session], devices: [DEVICE] });
  await server.waitForMessage(ws); // pulse/control bootstrap
  const sessionCard = page.getByRole('button', { name: /Pi Pi verification tentacle/ }).first();
  await expect(sessionCard).toBeVisible({ timeout: 5_000 });
  await sessionCard.click();
  await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 5_000 });
  return ws;
}

function interrupted(seq = 40) {
  return {
    type: 'interrupted_turn',
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    seq,
    timestamp: '2026-07-12T11:46:00.000Z',
    payload: {
      reason: 'user_aborted',
      draft: 'I started the second deployment check and was inspecting the rollout status.',
      action: {
        type: 'tool_start',
        payload: { toolCallId: 'tool-aborted', toolName: 'bash', headline: 'kubectl rollout status deployment/api' },
      },
      interruptedAt: '2026-07-12T11:46:00.000Z',
      cancelled: true,
      steps: 2,
    },
  };
}

test.describe('Pi question → continue → abort → refresh recovery', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => { server = await MockRelayServer.create(); });
  test.afterEach(async () => { await server.close(); });

  test('continues after answering, freezes Abort history across reload, then accepts a new turn', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    const ws = await connect(page, server);
    expect(ws.readyState).toBe(ws.OPEN);

    server.sendMessage(ws, { type: 'active', sessionId: SESSION_ID, payload: {} });
    server.sendMessage(ws, {
      type: 'agent_message_delta', sessionId: SESSION_ID,
      payload: { content: 'I found two deployment paths.', reset: true },
    });
    server.sendMessage(ws, {
      type: 'card_action', sessionId: SESSION_ID,
      payload: { action: { type: 'question', payload: {
        id: 'q-deploy', question: 'Which deployment strategy should I use?',
        choices: ['Rolling deployment', 'Blue-green deployment'], allowFreeform: false,
      } } },
    });

    await expect(page.getByText('Which deployment strategy should I use?')).toBeVisible();
    await page.getByRole('button', { name: 'Rolling deployment' }).click();
    server.sendMessage(ws, {
      type: 'card_action', sessionId: SESSION_ID,
      payload: { action: { type: 'question', payload: {
        id: 'q-deploy', question: 'Which deployment strategy should I use?',
        choices: ['Rolling deployment', 'Blue-green deployment'], allowFreeform: false,
        answer: 'Rolling deployment',
      } } },
    });
    await expect(page.getByText('✓ Answered')).toBeVisible();

    server.sendMessage(ws, { type: 'card_action', sessionId: SESSION_ID, payload: { action: null } });
    server.sendMessage(ws, {
      type: 'agent_message', sessionId: SESSION_ID,
      payload: { content: 'Rolling deployment selected. The first rollout completed successfully.' },
    });
    server.sendMessage(ws, { type: 'idle', sessionId: SESSION_ID, payload: { reason: 'completed' } });
    await expect(page.getByText('The first rollout completed successfully.', { exact: false })).toBeVisible();

    const composer = page.getByPlaceholder('Send a message…');
    await composer.fill('Check the second deployment too');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('main').getByText('Check the second deployment too')).toBeVisible();

    server.sendMessage(ws, { type: 'active', sessionId: SESSION_ID, payload: {} });
    server.sendMessage(ws, {
      type: 'agent_message_delta', sessionId: SESSION_ID,
      payload: { content: 'I started the second deployment check and was inspecting the rollout status.', reset: true },
    });
    server.sendMessage(ws, {
      type: 'card_action', sessionId: SESSION_ID,
      payload: { action: { type: 'tool_start', payload: {
        toolCallId: 'tool-aborted', toolName: 'bash', headline: 'kubectl rollout status deployment/api',
      } } },
    });
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop' }).click();

    server.sendMessage(ws, interrupted());
    server.sendMessage(ws, { type: 'card_action', sessionId: SESSION_ID, payload: { action: null } });
    server.sendMessage(ws, { type: 'agent_message_delta', sessionId: SESSION_ID, payload: { content: '', reset: true } });
    server.sendMessage(ws, { type: 'idle', sessionId: SESSION_ID, payload: { reason: 'aborted' } });

    await expect(page.getByText('Turn aborted')).toBeVisible();
    await expect(page.getByText('kubectl rollout status deployment/api')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rolling deployment' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Type your answer…')).toHaveCount(0);
    const abortedCard = page.getByText('Turn aborted').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    await abortedCard.screenshot({ path: '/tmp/kraki-pi-question-abort-screens/09-after-real-ui-abort.png' });

    const reconnect = server.waitForConnection();
    await page.reload();
    const ws2 = await reconnect;
    await server.waitForMessage(ws2);
    server.sendAuthOk(ws2, {
      sessions: [{ ...SESSION, state: 'idle', messageCount: 1, lastSeq: 40 }],
      devices: [DEVICE],
    });
    await server.waitForMessage(ws2);

    server.sendMessage(ws2, {
      type: 'session_messages_range_batch',
      payload: { sessionId: SESSION_ID, messages: [interrupted()], firstSeq: 40, lastSeq: 40, truncated: false },
    });

    await expect(page.getByText('Turn aborted')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('kubectl rollout status deployment/api')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rolling deployment' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Type your answer…')).toHaveCount(0);
    const replayedCard = page.getByText('Turn aborted').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")]').first();
    await replayedCard.screenshot({ path: '/tmp/kraki-pi-question-abort-screens/10-after-refresh-replay.png' });

    const refreshedComposer = page.getByPlaceholder('Send a message…');
    await refreshedComposer.fill('Continue with a safer rollout plan');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('main').getByText('Continue with a safer rollout plan')).toBeVisible();
  });
});
