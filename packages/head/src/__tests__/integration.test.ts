/**
 * Integration tests: Thin Relay ↔ Mock Tentacle ↔ Mock App
 *
 * Tests use a real head server with mock WebSocket clients
 * simulating tentacles and apps. Exercises full broadcast / unicast flows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, connectDevice, type TestEnv } from './integration-helpers.js';

describe('Integration: Thin Relay', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ── 1. Auth flow ──────────────────────────────────────

  describe('auth flow', () => {
    it('should authenticate tentacle and return deviceId', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle', { kind: 'desktop' });
      expect(tentacle.deviceId).toMatch(/^dev_/);
      tentacle.close();
    });

    it('should authenticate app and include device list', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app', { kind: 'ios' });

      const authOk = app.messages.find(m => m.type === 'auth_ok');
      expect(authOk.devices.length).toBeGreaterThanOrEqual(2);

      tentacle.close();
      app.close();
    });
  });

  // ── 2. Broadcast delivery ─────────────────────────────

  describe('broadcast delivery', () => {
    it('should deliver broadcast from tentacle to all apps', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app1 = await connectDevice(env.port, 'Phone', 'app');
      const app2 = await connectDevice(env.port, 'Browser', 'app');

      tentacle.send({
        type: 'broadcast',
        blob: 'encrypted_payload',
        keys: { phone_key: 'k1', browser_key: 'k2' },
      });

      const msg1 = await app1.waitFor('broadcast');
      const msg2 = await app2.waitFor('broadcast');
      expect(msg1.blob).toBe('encrypted_payload');
      expect(msg2.blob).toBe('encrypted_payload');

      tentacle.close();
      app1.close();
      app2.close();
    });

    it('should reject broadcast from app device', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      app.send({
        type: 'broadcast',
        blob: 'app_broadcast',
        keys: { tentacle_key: 'k1' },
      });

      const err = await app.waitFor('server_error');
      expect(err.message).toContain('Only tentacle devices can broadcast');

      tentacle.close();
      app.close();
    });
  });

  // ── 3. Unicast delivery ───────────────────────────────

  describe('unicast delivery', () => {
    it('should deliver unicast to specific target', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      app.send({
        type: 'unicast',
        to: tentacle.deviceId,
        blob: 'for_tentacle',
        keys: { [tentacle.deviceId]: 'enc_key' },
      });

      const msg = await tentacle.waitFor('unicast');
      expect(msg.blob).toBe('for_tentacle');

      tentacle.close();
      app.close();
    });

    it('should not deliver unicast to other devices', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app1 = await connectDevice(env.port, 'Phone', 'app');
      const app2 = await connectDevice(env.port, 'Browser', 'app');

      // Unicast to tentacle only
      app1.send({
        type: 'unicast',
        to: tentacle.deviceId,
        blob: 'private',
        keys: { [tentacle.deviceId]: 'k' },
      });

      const msg = await tentacle.waitFor('unicast');
      expect(msg.blob).toBe('private');

      // app2 should NOT receive it
      let app2Got = false;
      app2.ws.on('message', (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'unicast') app2Got = true;
      });
      await new Promise(r => setTimeout(r, 150));
      expect(app2Got).toBe(false);

      tentacle.close();
      app1.close();
      app2.close();
    });
  });

  // ── 4. Disconnect and reconnect ───────────────────────

  describe('disconnect and reconnect', () => {
    it('should stop delivering to disconnected device', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({ type: 'broadcast', blob: 'before', keys: {} });
      const msg = await app.waitFor('broadcast');
      expect(msg.blob).toBe('before');

      app.close();
      await new Promise(r => setTimeout(r, 100));

      const app2 = await connectDevice(env.port, 'Browser', 'app');
      tentacle.send({ type: 'broadcast', blob: 'after', keys: {} });
      const msg2 = await app2.waitFor('broadcast');
      expect(msg2.blob).toBe('after');

      tentacle.close();
      app2.close();
    });
  });

  // ── 5. Stable deviceId ────────────────────────────────

  describe('stable deviceId', () => {
    it('should reuse deviceId on reconnect — no ghost device', async () => {
      const tentacle1 = await connectDevice(env.port, 'Laptop', 'tentacle', { deviceId: 'dev_stable_laptop' });
      expect(tentacle1.deviceId).toBe('dev_stable_laptop');
      tentacle1.close();
      await new Promise(r => setTimeout(r, 100));

      const tentacle2 = await connectDevice(env.port, 'Laptop', 'tentacle', { deviceId: 'dev_stable_laptop' });
      expect(tentacle2.deviceId).toBe('dev_stable_laptop');

      const authOk = tentacle2.messages.find(m => m.type === 'auth_ok');
      const laptops = authOk.devices.filter((d: any) => d.name === 'Laptop');
      expect(laptops).toHaveLength(1);

      tentacle2.close();
    });
  });

  // ── 6. Pairing round-trip ─────────────────────────────

  describe('pairing round-trip', () => {
    it('should allow pairing flow: create token → pair → communicate', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

      // Create pairing token
      tentacle.send({ type: 'create_pairing_token' });
      const tokenMsg = await tentacle.waitFor('pairing_token_created');
      expect(tokenMsg.token).toMatch(/^pt_/);

      // App pairs with the token
      const app = await connectDevice(env.port, 'Phone', 'app', { pairingToken: tokenMsg.token });
      expect(app.deviceId).toMatch(/^dev_/);

      // Verify they can communicate via broadcast
      tentacle.send({ type: 'broadcast', blob: 'hello_paired', keys: {} });
      const msg = await app.waitFor('broadcast');
      expect(msg.blob).toBe('hello_paired');

      tentacle.close();
      app.close();
    });
  });
});
