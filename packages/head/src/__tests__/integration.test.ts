/**
 * Integration tests: Head ↔ Mock Tentacle ↔ Mock App
 *
 * These tests use a real head server with mock WebSocket clients
 * simulating tentacles and apps. No real Copilot SDK involved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, connectDevice, type TestEnv, type MockDevice } from './integration-helpers.js';

describe('Integration: Head ↔ Mock Tentacle', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ── 1. Auth flow ──────────────────────────────────────

  describe('auth flow', () => {
    it('should authenticate tentacle and return channel + deviceId', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle', { kind: 'desktop' });
      expect(tentacle.deviceId).toMatch(/^dev_/);
      expect(tentacle.channel).toMatch(/^ch_/);
      tentacle.close();
    });

    it('should authenticate app and include device list', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app', { kind: 'ios' });

      // App's auth_ok should include both devices
      const authOk = app.messages.find(m => m.type === 'auth_ok');
      expect(authOk.devices.length).toBeGreaterThanOrEqual(2);

      tentacle.close();
      app.close();
    });
  });

  // ── 2. Session lifecycle ──────────────────────────────

  describe('session lifecycle', () => {
    it('should route session_created from tentacle to app', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot', model: 'gpt-4' },
      });

      const msg = await app.waitFor('session_created');
      expect(msg.sessionId).toBe('sess_1');
      expect(msg.payload.agent).toBe('copilot');
      expect(msg.seq).toBe(1);

      tentacle.close();
      app.close();
    });

    it('should route session_ended from tentacle to app', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      });
      await app.waitFor('session_created');

      tentacle.send({
        type: 'session_ended',
        sessionId: 'sess_1',
        payload: { reason: 'completed' },
      });

      const msg = await app.waitFor('session_ended');
      expect(msg.payload.reason).toBe('completed');

      tentacle.close();
      app.close();
    });
  });

  // ── 3. Agent message flow ─────────────────────────────

  describe('agent message flow', () => {
    it('should route user_message and agent_message to app', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'user_message',
        sessionId: 'sess_1',
        payload: { content: 'fix the bug' },
      });
      const userMsg = await app.waitFor('user_message');
      expect(userMsg.payload.content).toBe('fix the bug');

      tentacle.send({
        type: 'agent_message',
        sessionId: 'sess_1',
        payload: { content: 'I fixed it in auth.js' },
      });
      const agentMsg = await app.waitFor('agent_message');
      expect(agentMsg.payload.content).toBe('I fixed it in auth.js');

      tentacle.close();
      app.close();
    });

    it('should forward deltas but not store them', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'agent_message_delta',
        sessionId: 'sess_1',
        payload: { content: 'I ' },
      });
      const delta = await app.waitFor('agent_message_delta');
      expect(delta.payload.content).toBe('I ');

      // Verify not stored
      const stored = env.storage.getMessagesAfterSeq(tentacle.channel, 0);
      const deltaStored = stored.find(m => m.type === 'agent_message_delta');
      expect(deltaStored).toBeUndefined();

      tentacle.close();
      app.close();
    });
  });

  // ── 4. Permission round-trip ──────────────────────────

  describe('permission round-trip', () => {
    it('should route permission request to app and approval back to tentacle', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      // Tentacle creates session first (needed for routing back)
      tentacle.send({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      });
      await app.waitFor('session_created');

      // Tentacle sends permission request
      tentacle.send({
        type: 'permission',
        sessionId: 'sess_1',
        payload: {
          id: 'perm_1',
          toolName: 'shell',
          args: { command: 'npm test' },
          description: 'Run npm test',
        },
      });
      const perm = await app.waitFor('permission');
      expect(perm.payload.toolName).toBe('shell');

      // App approves
      app.send({
        type: 'approve',
        sessionId: 'sess_1',
        payload: { permissionId: 'perm_1' },
      });
      const approval = await tentacle.waitFor('approve');
      expect(approval.payload.permissionId).toBe('perm_1');

      tentacle.close();
      app.close();
    });

    it('should route deny back to tentacle', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      });
      await app.waitFor('session_created');

      tentacle.send({
        type: 'permission',
        sessionId: 'sess_1',
        payload: { id: 'perm_2', toolName: 'shell', args: { command: 'rm -rf /' }, description: 'Dangerous!' },
      });
      await app.waitFor('permission');

      app.send({
        type: 'deny',
        sessionId: 'sess_1',
        payload: { permissionId: 'perm_2' },
      });
      const denial = await tentacle.waitFor('deny');
      expect(denial.payload.permissionId).toBe('perm_2');

      tentacle.close();
      app.close();
    });
  });

  // ── 5. Question round-trip ────────────────────────────

  describe('question round-trip', () => {
    it('should route question to app and answer back to tentacle', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'session_created',
        sessionId: 'sess_1',
        payload: { agent: 'copilot' },
      });
      await app.waitFor('session_created');

      tentacle.send({
        type: 'question',
        sessionId: 'sess_1',
        payload: { id: 'q_1', question: 'Which database?', choices: ['Postgres', 'SQLite'] },
      });
      const question = await app.waitFor('question');
      expect(question.payload.choices).toEqual(['Postgres', 'SQLite']);

      app.send({
        type: 'answer',
        sessionId: 'sess_1',
        payload: { questionId: 'q_1', answer: 'SQLite' },
      });
      const answer = await tentacle.waitFor('answer');
      expect(answer.payload.answer).toBe('SQLite');

      tentacle.close();
      app.close();
    });
  });

  // ── 6. Tool events ────────────────────────────────────

  describe('tool events', () => {
    it('should route and store tool_start and tool_complete', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({
        type: 'tool_start',
        sessionId: 'sess_1',
        payload: { toolName: 'read_file', args: { path: 'src/app.js' } },
      });
      const start = await app.waitFor('tool_start');
      expect(start.payload.toolName).toBe('read_file');

      tentacle.send({
        type: 'tool_complete',
        sessionId: 'sess_1',
        payload: { toolName: 'read_file', args: { path: 'src/app.js' }, result: 'const app = ...' },
      });
      const complete = await app.waitFor('tool_complete');
      expect(complete.payload.result).toBe('const app = ...');

      // Both should be stored
      const stored = env.storage.getMessagesAfterSeq(tentacle.channel, 0);
      expect(stored.filter(m => m.type === 'tool_start')).toHaveLength(1);
      expect(stored.filter(m => m.type === 'tool_complete')).toHaveLength(1);

      tentacle.close();
      app.close();
    });
  });

  // ── 7. Multi-tentacle routing ─────────────────────────

  describe('multi-tentacle routing', () => {
    it('should route app action to correct tentacle by sessionId', async () => {
      const laptop = await connectDevice(env.port, 'Laptop', 'tentacle');
      const workpc = await connectDevice(env.port, 'Work PC', 'tentacle');
      const phone = await connectDevice(env.port, 'Phone', 'app');

      laptop.send({ type: 'session_created', sessionId: 'sess_laptop', payload: { agent: 'copilot' } });
      workpc.send({ type: 'session_created', sessionId: 'sess_workpc', payload: { agent: 'claude' } });
      await phone.waitFor('session_created');
      await phone.waitFor('session_created');

      // Phone sends to sess_workpc → should go to workpc only
      phone.send({ type: 'send_input', sessionId: 'sess_workpc', payload: { text: 'hello workpc' } });
      const msg = await workpc.waitFor('send_input');
      expect(msg.payload.text).toBe('hello workpc');

      // Laptop should NOT have received it
      const laptopInputs = laptop.messages.filter(m => m.type === 'send_input');
      expect(laptopInputs).toHaveLength(0);

      laptop.close();
      workpc.close();
      phone.close();
    });
  });

  // ── 8. Replay ─────────────────────────────────────────

  describe('replay', () => {
    it('should replay stored messages to new device', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app1 = await connectDevice(env.port, 'Phone', 'app');

      // Send several messages
      tentacle.send({ type: 'user_message', sessionId: 'sess_1', payload: { content: 'msg 1' } });
      tentacle.send({ type: 'agent_message', sessionId: 'sess_1', payload: { content: 'msg 2' } });
      tentacle.send({ type: 'agent_message', sessionId: 'sess_1', payload: { content: 'msg 3' } });
      await app1.waitFor('agent_message'); // wait for last one to be processed

      // New app connects
      const app2 = await connectDevice(env.port, 'Browser', 'app');

      // Request replay from beginning
      app2.send({ type: 'replay', afterSeq: 0 });
      const replayed = await app2.waitForN('user_message', 1);
      expect(replayed[0].payload.content).toBe('msg 1');

      const agentMsgs = await app2.waitForN('agent_message', 2);
      expect(agentMsgs[0].payload.content).toBe('msg 2');
      expect(agentMsgs[1].payload.content).toBe('msg 3');

      tentacle.close();
      app1.close();
      app2.close();
    });
  });

  // ── 9. Reconnection ──────────────────────────────────

  describe('reconnection', () => {
    it('should replay only missed messages after disconnect', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      // App sees messages 1-2
      tentacle.send({ type: 'user_message', sessionId: 'sess_1', payload: { content: 'first' } });
      tentacle.send({ type: 'agent_message', sessionId: 'sess_1', payload: { content: 'second' } });
      const msg2 = await app.waitFor('agent_message');
      const lastSeq = msg2.seq;

      // App disconnects
      app.close();
      await new Promise(r => setTimeout(r, 100));

      // Tentacle sends more while app is offline
      tentacle.send({ type: 'agent_message', sessionId: 'sess_1', payload: { content: 'third' } });
      tentacle.send({ type: 'agent_message', sessionId: 'sess_1', payload: { content: 'fourth' } });
      await new Promise(r => setTimeout(r, 100));

      // App reconnects and replays from lastSeq
      const app2 = await connectDevice(env.port, 'Phone2', 'app');
      app2.send({ type: 'replay', afterSeq: lastSeq });

      const missed = await app2.waitForN('agent_message', 2);
      // Verify we got the two missed messages (order by seq)
      missed.sort((a: any, b: any) => a.seq - b.seq);
      expect(missed[0].payload.content).toBe('third');
      expect(missed[1].payload.content).toBe('fourth');

      tentacle.close();
      app2.close();
    });
  });

  // ── 10. Device lifecycle ──────────────────────────────

  describe('device lifecycle', () => {
    it('should notify app when tentacle connects and disconnects', async () => {
      const app = await connectDevice(env.port, 'Phone', 'app');

      // Drain any initial head_notices (app's own device_online)
      await new Promise(r => setTimeout(r, 100));
      const initialNotices = app.messages.filter(m => m.type === 'head_notice');

      // Tentacle connects → app gets device_online for Laptop
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');

      // Wait until we see a device_online for Laptop specifically
      const online = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for Laptop device_online')), 5000);
        const check = () => {
          const notice = app.messages.find(
            m => m.type === 'head_notice' && m.event === 'device_online' && m.data?.device?.name === 'Laptop'
          );
          if (notice) { clearTimeout(timeout); resolve(notice); }
          else setTimeout(check, 50);
        };
        check();
      });
      expect(online.data.device.name).toBe('Laptop');

      // Tentacle disconnects → app gets device_offline
      tentacle.close();
      const offline = await new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for device_offline')), 5000);
        const check = () => {
          const notice = app.messages.find(m => m.type === 'head_notice' && m.event === 'device_offline');
          if (notice) { clearTimeout(timeout); resolve(notice); }
          else setTimeout(check, 50);
        };
        check();
      });
      expect(offline.event).toBe('device_offline');

      app.close();
    });
  });

  // ── 11. Stable deviceId ───────────────────────────────

  describe('stable deviceId', () => {
    it('should reuse deviceId on reconnect — no ghost device', async () => {
      const tentacle1 = await connectDevice(env.port, 'Laptop', 'tentacle', { deviceId: 'dev_stable_laptop' });
      expect(tentacle1.deviceId).toBe('dev_stable_laptop');
      tentacle1.close();
      await new Promise(r => setTimeout(r, 100));

      const tentacle2 = await connectDevice(env.port, 'Laptop', 'tentacle', { deviceId: 'dev_stable_laptop' });
      expect(tentacle2.deviceId).toBe('dev_stable_laptop');

      // Only one device in summaries
      const summaries = env.cm.getDeviceSummaries(tentacle2.channel);
      const laptopDevices = summaries.filter(d => d.name === 'Laptop');
      expect(laptopDevices).toHaveLength(1);

      tentacle2.close();
    });
  });

  // ── 12. Kill session ──────────────────────────────────

  describe('kill session', () => {
    it('should route kill_session from app to tentacle', async () => {
      const tentacle = await connectDevice(env.port, 'Laptop', 'tentacle');
      const app = await connectDevice(env.port, 'Phone', 'app');

      tentacle.send({ type: 'session_created', sessionId: 'sess_1', payload: { agent: 'copilot' } });
      await app.waitFor('session_created');

      app.send({ type: 'kill_session', sessionId: 'sess_1', payload: {} });
      const kill = await tentacle.waitFor('kill_session');
      expect(kill.sessionId).toBe('sess_1');

      // kill_session should be stored
      const stored = env.storage.getMessagesAfterSeq(tentacle.channel, 0);
      const killStored = stored.find(m => m.type === 'kill_session');
      expect(killStored).toBeTruthy();

      tentacle.close();
      app.close();
    });
  });
});
