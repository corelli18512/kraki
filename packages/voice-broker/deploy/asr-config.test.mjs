import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asrProvider } from './asr-config.mjs';

test('ASR_PROVIDER selects exactly one provider, default doubao', () => {
  assert.equal(asrProvider({}), 'doubao');
  assert.equal(asrProvider({ ASR_PROVIDER: ' AssemblyAI ' }), 'assemblyai');
});

test('unknown providers, lists and the removed failover variable are rejected', () => {
  assert.throws(() => asrProvider({ ASR_PROVIDER: 'deepgram' }), /unknown provider deepgram/);
  assert.throws(() => asrProvider({ ASR_PROVIDER: 'assemblyai,doubao' }), /unknown provider/);
  assert.throws(() => asrProvider({ ASR_PROVIDERS: 'assemblyai,doubao' }), /was removed/);
});
