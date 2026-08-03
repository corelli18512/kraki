#!/usr/bin/env node
/**
 * Kraki product adapter for the provider-agnostic @coinfra/voice gateway.
 *
 * The shared voice wheel owns ASR/correction/streaming. This adapter owns only
 * Kraki's signed lease verification and deployment configuration. Legacy
 * static-key authorization remains available only for non-Kraki clients during
 * migration; Kraki lease frames never downgrade to that path.
 */
import { readFileSync } from 'node:fs';
import { createKrakiOrLegacyAuthorizer, createKrakiSettlementClient } from './kraki-lease-authorizer.mjs';
import {
  createDoubaoAsrProvider,
  createLogger,
  createOpenAiCorrector,
  levelFromEnv,
  passthroughCorrector,
  startGateway,
} from './coinfra/index.mjs';

const log = createLogger('serve', levelFromEnv(process.env.LOG_LEVEL));

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

async function main() {
  const publicKey = readFileSync(required('KRAKI_VOICE_LEASE_PUBLIC_KEY_PATH'), 'utf8');
  const settlementUrl = required('KRAKI_VOICE_SETTLEMENT_URL');
  const settlementKey = required('KRAKI_VOICE_SETTLEMENT_KEY');
  const correctionEnabled = process.env.CORRECTION_ENABLED !== '0';
  const asr = createDoubaoAsrProvider({
    endpoint: required('DOUBAO_ENDPOINT'),
    accessKey: required('DOUBAO_ACCESS_KEY'),
    resourceId: process.env.DOUBAO_RESOURCE_ID?.trim() || 'volc.seedasr.sauc.duration',
    model: 'seedasr',
    appKey: process.env.DOUBAO_APP_KEY?.trim() || undefined,
  });
  const corrector = correctionEnabled
    ? createOpenAiCorrector({
        baseUrl: process.env.CORRECTOR_BASE_URL?.trim() || 'https://api.deepseek.com/v1',
        apiKey: required('CORRECTOR_API_KEY'),
        model: process.env.CORRECTOR_MODEL?.trim() || 'deepseek-chat',
        timeoutMs: envInt('CORRECTOR_TIMEOUT_MS', 15_000),
        maxTokens: envInt('CORRECTOR_MAX_TOKENS', 512),
        disableThinking: /^(1|true|yes|on)$/i.test(process.env.CORRECTOR_DISABLE_THINKING?.trim() ?? ''),
        log: (message, fields) => log.debug(`corrector ${message}`, fields),
      })
    : passthroughCorrector;

  const settlement = createKrakiSettlementClient(settlementUrl, settlementKey);
  const gateway = await startGateway({
    host: process.env.VOICE_HOST?.trim() || '127.0.0.1',
    port: envInt('VOICE_PORT', 7800),
    path: process.env.VOICE_PATH?.trim() || '/voice',
    asr,
    corrector,
    correctOn: correctionEnabled ? 'final' : 'never',
    authorize: createKrakiOrLegacyAuthorizer(
      publicKey,
      required('VOICE_API_KEY'),
      { activate: settlement.activate },
    ),
    onUsage: settlement.onUsage,
  });
  log.info('Kraki lease gateway ready', {
    url: gateway.url,
    correction: correctionEnabled,
    authorization: 'kraki-signed-lease+legacy-api-key',
    settlement: 'actual-audio-seconds',
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    try { await gateway.close(); } catch (error) {
      log.warn('shutdown error', { error: error.message });
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.error('fatal', { error: error.message });
    process.exit(1);
  });
}
