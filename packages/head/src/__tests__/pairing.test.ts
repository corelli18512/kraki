/**
 * Pairing token tests.
 * Pairing tokens are now in-memory on the HeadServer — tested through the WebSocket API.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createTestEnv, connectDevice, type TestEnv } from './integration-helpers.js';

describe('Pairing (in-memory tokens)', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('should create and use a pairing token', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

    tentacle.send({ type: 'create_pairing_token' });
    const tokenMsg = await tentacle.waitFor('pairing_token_created');
    expect(tokenMsg.token).toMatch(/^pt_/);
    expect(tokenMsg.expiresIn).toBeGreaterThan(0);

    const app = await connectDevice(env.port, 'Phone', 'app', { pairingToken: tokenMsg.token });
    expect(app.deviceId).toMatch(/^dev_/);

    // Both devices should appear in the paired app's device list
    const authOk = app.messages.find(m => m.type === 'auth_ok');
    expect(authOk.devices.length).toBeGreaterThanOrEqual(2);

    tentacle.close();
    app.close();
  });

  it('should reject already-used pairing token (single-use)', async () => {
    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

    tentacle.send({ type: 'create_pairing_token' });
    const tokenMsg = await tentacle.waitFor('pairing_token_created');

    // First use succeeds
    const app1 = await connectDevice(env.port, 'Phone', 'app', { pairingToken: tokenMsg.token });
    expect(app1.deviceId).toBeTruthy();

    // Second use fails
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({
      type: 'auth',
      auth: { method: 'pairing', token: tokenMsg.token },
      device: { name: 'Browser', role: 'app' },
    }));
    const res = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(res.type).toBe('auth_error');
    expect(res.code).toBe('invalid_pairing_token');

    ws.close();
    app1.close();
    tentacle.close();
  });

  it('should reject invalid pairing token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({
      type: 'auth',
      auth: { method: 'pairing', token: 'pt_nonexistent' },
      device: { name: 'Phone', role: 'app' },
    }));
    const res = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(res.type).toBe('auth_error');
    expect(res.code).toBe('invalid_pairing_token');
    expect(res.message).toContain('Invalid or expired');
    ws.close();
  });

  it('should reject create_pairing_token when pairing is disabled', async () => {
    await env.cleanup();
    env = await createTestEnv({ pairingEnabled: false });

    const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
    tentacle.send({ type: 'create_pairing_token' });
    const res = await tentacle.waitFor('server_error');
    expect(res.message).toContain('disabled');

    tentacle.close();
  });

  it('should support one-shot pairing via request_pairing_token', async () => {
    // request_pairing_token is a pre-auth message that authenticates
    // and immediately returns a pairing token (used for QR code flow)
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    // In open mode, any token is accepted
    ws.send(JSON.stringify({
      type: 'request_pairing_token',
      token: 'anything',
    }));

    const tokenMsg = await new Promise<any>((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
    });
    expect(tokenMsg.type).toBe('pairing_token_created');
    expect(tokenMsg.token).toMatch(/^pt_/);
    ws.close();

    // Now use that token to pair a new device
    const app = await connectDevice(env.port, 'Phone', 'app', { pairingToken: tokenMsg.token });
    expect(app.deviceId).toBeTruthy();
    app.close();
  });
});
