import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChaosStack } from './stack.js';
import { connectApp, sendToTentacle, subscribeApp, waitMs } from '../helpers.js';

describe('chaos stack smoke', () => {
  const stack = new ChaosStack();
  beforeAll(async () => { await stack.start(); });
  afterAll(async () => { await stack.stop(); });

  it('delivers an input through the app proxy and streams the reply back', async () => {
    const app = await connectApp(stack.appProxy.port, 'Smoke');
    await subscribeApp(app, stack.sessionId);
    sendToTentacle(app, { type: 'send_input', sessionId: stack.sessionId, deviceId: app.deviceId, seq: 0,
      timestamp: new Date().toISOString(), payload: { text: 'hello-1', clientId: 'c-1' } });
    for (let i = 0; i < 100 && !app.messages.some((m) => m.type === 'agent_message'); i++) await waitMs(50);
    expect(stack.ledger().received).toEqual({ 'hello-1': 1 });
    expect(app.messages.some((m) => m.type === 'user_message' && (m.payload as { clientId?: string }).clientId === 'c-1')).toBe(true);
    expect(app.messages.some((m) => m.type === 'agent_message')).toBe(true);
    app.close();
  });
});

describe('chaos stack restarts', () => {
  it('survives Head and Tentacle restarts and still delivers', async () => {
    const stack = new ChaosStack();
    await stack.start();
    try {
      await stack.restartHead(500);
      await stack.restartTentacle(200);
      for (let i = 0; i < 100 && !stack.relay.getAuthInfo(); i++) await waitMs(50);
      const app = await connectApp(stack.appProxy.port, 'Smoke2');
      await subscribeApp(app, stack.sessionId);
      sendToTentacle(app, { type: 'send_input', sessionId: stack.sessionId, deviceId: app.deviceId, seq: 0,
        timestamp: new Date().toISOString(), payload: { text: 'after-restart', clientId: 'c-2' } });
      for (let i = 0; i < 100 && !(stack.ledger().received as Record<string, number>)['after-restart']; i++) await waitMs(50);
      expect(stack.ledger().received).toEqual({ 'after-restart': 1 });
      app.close();
    } finally {
      await stack.stop();
    }
  });
});
