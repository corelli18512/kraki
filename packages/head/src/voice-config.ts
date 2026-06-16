/**
 * Pure validation of voice-broker-related environment configuration.
 *
 * This module exists separately from cli.ts so the validation rules can be
 * unit-tested without spawning a child process. cli.ts imports `validate`
 * and exits on the first error.
 *
 * The rules encode the operational invariant:
 *
 *   VOICE_LEASE_ENABLED ⇔ VOICE_BROKER_URL set
 *
 * If only one side is set, head fails to start — it'd be either advertising
 * a broker for which it can't issue leases (clients see UI but every press
 * fails) or issuing leases that no client knows where to use.
 */

export interface VoiceConfigInput {
  /** Raw value of `VOICE_LEASE_ENABLED` env (only `'1'` enables). */
  voiceLeaseEnabled: string | undefined;
  /** Raw value of `VOICE_BROKER_URL` env (whitespace tolerated). */
  voiceBrokerUrl: string | undefined;
}

export interface VoiceConfigResolved {
  /** True when leases should be issued (VOICE_LEASE_ENABLED === '1'). */
  enabled: boolean;
  /** Trimmed broker URL, or undefined when unset. */
  brokerUrl: string | undefined;
}

/**
 * Validate the (enabled, brokerUrl) pair. Returns the resolved config on
 * success, or throws an Error with a human-readable message on the first
 * rule violation. Caller (cli.ts) is responsible for printing the message
 * and exiting with non-zero status.
 */
export function validateVoiceConfig(input: VoiceConfigInput): VoiceConfigResolved {
  const enabled = input.voiceLeaseEnabled === '1';
  const brokerUrl = (input.voiceBrokerUrl ?? '').trim() || undefined;

  if (brokerUrl && !enabled) {
    throw new Error(
      'VOICE_BROKER_URL is set but VOICE_LEASE_ENABLED is not "1". ' +
      'Set VOICE_LEASE_ENABLED=1 to advertise + issue, or unset VOICE_BROKER_URL.',
    );
  }
  if (enabled && !brokerUrl) {
    throw new Error(
      'VOICE_LEASE_ENABLED=1 requires VOICE_BROKER_URL to be set ' +
      '(the public WSS URL clients should connect to, e.g. wss://cn.stt.kraki.chat/voice).',
    );
  }
  if (brokerUrl && !/^wss?:\/\//.test(brokerUrl)) {
    throw new Error(
      `VOICE_BROKER_URL must start with ws:// or wss:// (got: ${brokerUrl})`,
    );
  }

  return { enabled, brokerUrl };
}
