/**
 * Unit tests for the cli-side env interlock.
 *
 * These pin the rules that say a head can only run with both lease
 * issuance + broker advertisement, or neither. The cli surfaces violations
 * as a fatal startup error; here we verify the underlying rules in
 * isolation, without spawning the cli.
 */

import { describe, it, expect } from 'vitest';
import { validateVoiceConfig } from '../voice-config.js';

describe('validateVoiceConfig', () => {
  it('returns disabled when both env vars are unset', () => {
    expect(validateVoiceConfig({
      voiceLeaseEnabled: undefined,
      voiceBrokerUrl: undefined,
    })).toEqual({ enabled: false, brokerUrl: undefined });
  });

  it('returns disabled when VOICE_LEASE_ENABLED is set to a non-"1" value', () => {
    // Truthy-looking strings other than "1" must NOT enable. This matches
    // the existing convention in cli.ts ("0", "true", "yes" all → off).
    for (const v of ['0', 'true', 'yes', 'on', '']) {
      expect(validateVoiceConfig({
        voiceLeaseEnabled: v,
        voiceBrokerUrl: undefined,
      })).toEqual({ enabled: false, brokerUrl: undefined });
    }
  });

  it('returns enabled with broker URL when both env vars are set correctly', () => {
    expect(validateVoiceConfig({
      voiceLeaseEnabled: '1',
      voiceBrokerUrl: 'wss://cn.stt.kraki.chat/voice',
    })).toEqual({
      enabled: true,
      brokerUrl: 'wss://cn.stt.kraki.chat/voice',
    });
  });

  it('trims whitespace around the broker URL', () => {
    // Operators paste URLs with trailing newlines/spaces all the time.
    expect(validateVoiceConfig({
      voiceLeaseEnabled: '1',
      voiceBrokerUrl: '  wss://cn.stt.kraki.chat/voice\n',
    }).brokerUrl).toBe('wss://cn.stt.kraki.chat/voice');
  });

  it('treats a whitespace-only broker URL as unset (falls into the unset branch)', () => {
    // " " trimmed is "" → undefined → not_set. With enabled=undefined too,
    // both are unset → no error.
    expect(validateVoiceConfig({
      voiceLeaseEnabled: undefined,
      voiceBrokerUrl: '   ',
    })).toEqual({ enabled: false, brokerUrl: undefined });
  });

  describe('interlock', () => {
    it('throws when broker URL is set but lease issuance is disabled', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: undefined,
        voiceBrokerUrl: 'wss://cn.stt.kraki.chat/voice',
      })).toThrow(/VOICE_BROKER_URL is set but VOICE_LEASE_ENABLED is not "1"/);
    });

    it('throws when broker URL is set but lease issuance is "0"', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '0',
        voiceBrokerUrl: 'wss://cn.stt.kraki.chat/voice',
      })).toThrow(/VOICE_BROKER_URL is set but VOICE_LEASE_ENABLED is not "1"/);
    });

    it('throws when lease issuance is "1" but broker URL is unset', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: undefined,
      })).toThrow(/VOICE_LEASE_ENABLED=1 requires VOICE_BROKER_URL to be set/);
    });

    it('throws when lease issuance is "1" but broker URL is whitespace-only', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: '   ',
      })).toThrow(/VOICE_LEASE_ENABLED=1 requires VOICE_BROKER_URL to be set/);
    });
  });

  describe('URL schema validation', () => {
    it('accepts wss:// URLs', () => {
      expect(validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: 'wss://cn.stt.kraki.chat/voice',
      }).brokerUrl).toBe('wss://cn.stt.kraki.chat/voice');
    });

    it('accepts ws:// URLs (e.g. local dev)', () => {
      expect(validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: 'ws://127.0.0.1:7800/voice',
      }).brokerUrl).toBe('ws://127.0.0.1:7800/voice');
    });

    it('rejects http:// URLs (paste-typo from the http console)', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: 'http://cn.stt.kraki.chat/voice',
      })).toThrow(/must start with ws:\/\/ or wss:\/\//);
    });

    it('rejects https:// URLs', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: 'https://cn.stt.kraki.chat/voice',
      })).toThrow(/must start with ws:\/\/ or wss:\/\//);
    });

    it('rejects bare hostnames (missing scheme)', () => {
      expect(() => validateVoiceConfig({
        voiceLeaseEnabled: '1',
        voiceBrokerUrl: 'cn.stt.kraki.chat/voice',
      })).toThrow(/must start with ws:\/\/ or wss:\/\//);
    });
  });
});
