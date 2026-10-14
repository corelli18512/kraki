import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decryptV2, encryptV2, generateE2EKeyPair } from '../v2.js';
import * as web from '../web/index.js';

describe('owned Node / Web Crypto / Swift envelope compatibility', () => {
  it('exchanges fresh multi-recipient envelopes in both directions', async () => {
    const a = generateE2EKeyPair();
    const b = await web.generateEncryptionKeyPair();
    const recipients = [
      { recipientId: 'node', publicKey: a.publicKey },
      { recipientId: 'web', publicKey: b.publicKey },
    ];
    const text = 'same protocol, new repository — 中文 🔐';
    const nodeBlob = encryptV2(text, recipients);
    const webBlob = await web.encryptToBlob(text, recipients);
    for (const blob of [nodeBlob, webBlob]) {
      expect(decryptV2(blob, 'node', a.privateKey)).toBe(text);
      expect(await web.decryptFromBlob(blob, 'web', b.privateKey)).toBe(text);
      expect(Buffer.from(blob, 'base64url').subarray(0, 2)).toEqual(Buffer.from([0xc0, 0x1f]));
    }
  });

  for (const source of ['ts', 'swift']) {
    it(`opens the previously shipped ${source} vectors with the owned Web Crypto implementation`, async () => {
      const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${source}-vectors.json`, import.meta.url), 'utf8')) as {
        recipients: Array<{ recipientId: string; privateKey: string }>;
        blobs: Array<{ blob: string; plaintext: string }>;
      };
      for (const { blob, plaintext } of fixture.blobs) {
        for (const recipient of fixture.recipients) {
          expect(await web.decryptFromBlob(blob, recipient.recipientId, recipient.privateKey)).toBe(plaintext);
        }
      }
    });
  }
});
