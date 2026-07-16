import { performance } from 'node:perf_hooks';
import {
  encryptToBlob,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
} from '../packages/crypto/dist/index.js';

const keyPair = generateKeyPair();
const compactKey = exportPublicKey(keyPair.publicKey);
const plaintext = JSON.stringify({
  type: 'agent_message_delta',
  sessionId: 'session-1',
  payload: { content: 'x'.repeat(256) },
});

for (const recipientCount of [1, 2, 4, 8, 16, 32, 64]) {
  const samples: number[] = [];
  let wireBytes = 0;
  for (let run = 0; run < 100; run++) {
    const started = performance.now();
    const recipients = Array.from({ length: recipientCount }, (_, index) => ({
      deviceId: `app-${index}`,
      publicKey: importPublicKey(compactKey),
    }));
    const encrypted = encryptToBlob(plaintext, recipients);
    wireBytes = JSON.stringify(encrypted).length;
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  console.log(JSON.stringify({
    recipients: recipientCount,
    meanMs: Number(mean.toFixed(3)),
    p50Ms: Number(samples[49].toFixed(3)),
    p95Ms: Number(samples[94].toFixed(3)),
    wireBytes,
  }));
}
