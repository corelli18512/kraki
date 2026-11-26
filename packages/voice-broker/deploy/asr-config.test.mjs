import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asrProviderOrder } from './asr-config.mjs';

test('ASR_PROVIDERS defaults to doubao and keeps the configured order', () => {
  assert.deepEqual(asrProviderOrder(undefined), ['doubao']);
  assert.deepEqual(asrProviderOrder('  '), ['doubao']);
  assert.deepEqual(asrProviderOrder('AssemblyAI, doubao'), ['assemblyai', 'doubao']);
});

test('ASR_PROVIDERS rejects unknown or duplicate providers', () => {
  assert.throws(() => asrProviderOrder('deepgram'), /unknown provider deepgram/);
  assert.throws(() => asrProviderOrder('doubao,doubao'), /duplicate/);
});
