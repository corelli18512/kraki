/**
 * Tests for handshake-time voice capability advertisement.
 *
 * Contract under test (see protocol/voice.ts → VoiceCapability and
 * server.ts → getVoiceCapability):
 *
 *   1. When `voiceBrokerUrl` is configured, head advertises
 *      `auth_ok.voice = { brokerUrl, resource: 'voice/doubao' }`.
 *   2. When `voiceBrokerUrl` is unset, the `voice` field is OMITTED from
 *      `auth_ok` entirely (not present as `undefined` or `null`) — arm
 *      uses key presence as the "should I render mic UI" signal, so the
 *      wire shape matters.
 *   3. `voiceBrokerUrl` is the only switch that controls advertisement —
 *      having `leaseIssuer` configured but no broker URL still results in
 *      no advertisement (cli enforces this combo can't ship to prod, but
 *      the server tolerates it for unit-test ergonomics).
 *
 * The cli-level interlock (refusing mismatched env at startup) is tested
 * separately by exercising cli.ts directly — out of scope for the server
 * integration tests here.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { LeaseIssuer } from '../lease-issuer.js';
import { createTestEnv, connectDevice, type TestEnv, type MockDevice } from './integration-helpers.js';

function mkTmpLeaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'kraki-cap-test-'));
}
function rm(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

describe('voice capability advertisement (auth_ok.voice)', () => {
  let env: TestEnv;
  let device: MockDevice;
  let leaseDir: string | undefined;

  afterEach(async () => {
    try { device?.close(); } catch { /* ignore */ }
    if (env) await env.cleanup();
    if (leaseDir) rm(leaseDir);
    leaseDir = undefined;
  });

  describe('when voiceBrokerUrl is configured', () => {
    beforeEach(async () => {
      leaseDir = mkTmpLeaseDir();
      env = await createTestEnv({
        leaseIssuer: LeaseIssuer.loadOrGenerate(leaseDir),
        voiceBrokerUrl: 'wss://cn.stt.kraki.chat/voice',
      });
      device = await connectDevice(env.port, 'arm-test', 'app', { kind: 'web' });
    });

    it('advertises voice capability in auth_ok', () => {
      expect(device.authOk.voice).toEqual({
        brokerUrl: 'wss://cn.stt.kraki.chat/voice',
        resource: 'voice/doubao',
      });
    });
  });

  describe('when voiceBrokerUrl is NOT configured', () => {
    beforeEach(async () => {
      // No leaseIssuer, no broker URL — represents a region with no voice
      // (e.g. current US main).
      env = await createTestEnv({});
      device = await connectDevice(env.port, 'arm-test', 'app', { kind: 'web' });
    });

    it('omits the voice field from auth_ok entirely', () => {
      // Strict: must be absent, not just falsy. arm distinguishes "voice
      // disabled" from "voice config error" by key presence — a stray
      // `voice: undefined` would be ambiguous on the wire post-JSON.
      expect('voice' in device.authOk).toBe(false);
    });
  });

  describe('when leaseIssuer is configured but voiceBrokerUrl is not', () => {
    // Reflects the no-prod-cli case: at the server layer this is a
    // legal config (issues leases, but doesn't advertise where to use
    // them). cli.ts refuses to start in this state, but the server itself
    // shouldn't crash — we want isolated unit testing without env coupling.
    beforeEach(async () => {
      leaseDir = mkTmpLeaseDir();
      env = await createTestEnv({
        leaseIssuer: LeaseIssuer.loadOrGenerate(leaseDir),
        // no voiceBrokerUrl
      });
      device = await connectDevice(env.port, 'arm-test', 'app', { kind: 'web' });
    });

    it('still omits the voice field (broker URL is the advertise switch, not issuer)', () => {
      expect('voice' in device.authOk).toBe(false);
    });
  });
});
