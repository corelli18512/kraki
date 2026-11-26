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
import {
  createKrakiConnectionAuthorizer,
  createKrakiSettlementClient,
  createLegacyApiKeyAuthorizer,
} from './kraki-lease-authorizer.mjs';
import { asrProvider } from './asr-config.mjs';
import {
  createAssemblyAiAsrProvider,
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

function createAsrProvider(name) {
  if (name === 'assemblyai') {
    const languageCodes = process.env.ASSEMBLYAI_LANGUAGE_CODES?.trim();
    const mode = process.env.ASSEMBLYAI_MODE?.trim() ?? 'manual';
    return createAssemblyAiAsrProvider({
      apiKey: required('ASSEMBLYAI_API_KEY'),
      // US data zone by default: audio and transcripts are processed in the US.
      endpoint: process.env.ASSEMBLYAI_ENDPOINT?.trim() || 'wss://streaming.us.assemblyai.com/v3/ws',
      // Agent model + manual turns: push-to-talk ends the only turn; first
      // partial ~0.5 s (the notetaker model waits ~1.3 s).
      speechModel: process.env.ASSEMBLYAI_MODEL?.trim() || 'assemblyai-stt-3-7-realtime-agent',
      ...(mode ? { extraParams: { mode } } : {}),
      // Unset = native multilingual (English first-class, Mandarin usable).
      ...(languageCodes ? { languageCodes: languageCodes.split(',').map((code) => code.trim()) } : {}),
      logger: log.child('assemblyai'),
    });
  }
  return createDoubaoAsrProvider({
    endpoint: required('DOUBAO_ENDPOINT'),
    accessKey: required('DOUBAO_ACCESS_KEY'),
    resourceId: process.env.DOUBAO_RESOURCE_ID?.trim() || 'volc.seedasr.sauc.duration',
    model: 'seedasr',
    appKey: process.env.DOUBAO_APP_KEY?.trim() || undefined,
    // Custom Words as recognition hot words (bidirectional API: ~100 tokens).
    hotwordTokenBudget: envInt('DOUBAO_HOTWORD_TOKENS', 100),
  });
}

async function main() {
  const publicKey = readFileSync(required('KRAKI_VOICE_LEASE_PUBLIC_KEY_PATH'), 'utf8');
  const settlementUrl = required('KRAKI_VOICE_SETTLEMENT_URL');
  const settlementKey = required('KRAKI_VOICE_SETTLEMENT_KEY');
  const correctionEnabled = process.env.CORRECTION_ENABLED !== '0';
  const providerName = asrProvider(process.env);
  const asr = createAsrProvider(providerName);
  const corrector = correctionEnabled
    ? createOpenAiCorrector({
        baseUrl: process.env.CORRECTOR_BASE_URL?.trim() || 'https://api.deepseek.com/v1',
        apiKey: required('CORRECTOR_API_KEY'),
        model: process.env.CORRECTOR_MODEL?.trim() || 'deepseek-chat',
        timeoutMs: envInt('CORRECTOR_TIMEOUT_MS', 15_000),
        maxTokens: envInt('CORRECTOR_MAX_TOKENS', 512),
        disableThinking: /^(1|true|yes|on)$/i.test(process.env.CORRECTOR_DISABLE_THINKING?.trim() ?? ''),
        // Per-call latency/token usage and the hourly daily-usage summary at
        // info (cost tracking); failures at warn with their class
        // (billing = a provider usage/spend limit: correction is off).
        log: (message, fields) => {
          if (message === 'failed') log.warn(`corrector ${message}`, fields);
          else log.info(`corrector ${message}`, fields);
        },
      })
    : passthroughCorrector;

  const settlement = createKrakiSettlementClient(settlementUrl, settlementKey, {
    timeoutMs: envInt('KRAKI_VOICE_SETTLEMENT_TIMEOUT_MS', 2_000),
  });
  const gateway = await startGateway({
    host: process.env.VOICE_HOST?.trim() || '127.0.0.1',
    port: envInt('VOICE_PORT', 7800),
    path: process.env.VOICE_PATH?.trim() || '/voice',
    asr,
    corrector,
    correctOn: correctionEnabled ? 'final' : 'never',
    authorizeConnection: createKrakiConnectionAuthorizer(publicKey, {
      activate: settlement.activate,
    }),
    // Legacy static key: optional, and logged on every use so it can be
    // removed once nothing relies on it.
    authorize: createLegacyApiKeyAuthorizer(process.env.VOICE_API_KEY?.trim() || '', {
      onUse: () => log.warn('legacy VOICE_API_KEY authorization used (bypasses lease, settlement and quota)'),
    }),
    onUsage: settlement.onUsage,
  });
  log.info('Kraki lease gateway ready', {
    asr: providerName,
    url: gateway.url,
    correction: correctionEnabled,
    authorization: process.env.VOICE_API_KEY?.trim() ? 'warm-kraki-lease+legacy-api-key' : 'warm-kraki-lease',
    settlement: 'cumulative-audio-checkpoints',
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
