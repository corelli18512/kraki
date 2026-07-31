import { test, expect, type Page } from '@playwright/test';
import { webcrypto } from 'node:crypto';
import { MockRelayServer } from './helpers/mock-ws-server';
import { Endpoint, StreamSet, type Effect } from '@coinfra/pulse';
import type { WebSocket } from 'ws';

const SESSION_ID = 'session-active-tail';
const TENTACLE_ID = 'tentacle-tail';
const ARM_ID = 'test-device';

const DEVICE = {
  id: TENTACLE_ID,
  name: 'Tail test tentacle',
  role: 'tentacle',
  kind: 'cli',
  online: true,
};

function b64(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
}

function unb64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
  return webcrypto.subtle.generateKey(
    {
      name: 'RSA-OAEP',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKeyPair>;
}

async function publicKeyBase64(key: CryptoKey): Promise<string> {
  return b64(await webcrypto.subtle.exportKey('spki', key));
}

interface RangeRequest {
  sessionId: string;
  fromSeq: number;
  toSeq: number;
}

/**
 * A small real Pulse peer for the browser test. It decrypts the ARM's actual
 * RSA-OAEP/AES-GCM payload, records the range request, and encrypts the reply
 * back on Pulse bulk stream 1. The first request is held until the test opens
 * the session, which reproduces a warm-up already occupying MessageProvider.
 */
class BrowserPulsePeer {
  private readonly streams = new StreamSet([
    new Endpoint({ epoch: `peer:${Date.now()}:live`, durable: { supported: false }, streamId: 0 }),
    new Endpoint({ epoch: `peer:${Date.now()}:bulk`, durable: { supported: false }, streamId: 1 }),
  ]);
  private chain = Promise.resolve();
  private armPublicKey: CryptoKey | null = null;
  private firstRequest: RangeRequest | null = null;
  private released = false;
  private readonly requestWaiters: Array<() => void> = [];
  readonly requests: RangeRequest[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly tentaclePrivateKey: CryptoKey,
  ) {
    ws.on('message', (data) => {
      this.chain = this.chain.then(() => this.handleWireMessage(data.toString()));
    });
  }

  connect(): void {
    void this.run(this.streams.onConnected(Date.now()));
  }

  setArmPublicKey(publicKeyBase64Value: string): void {
    void webcrypto.subtle.importKey(
      'spki',
      unb64(publicKeyBase64Value),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    ).then((key) => { this.armPublicKey = key; });
  }

  releaseFirstRequest(): void {
    this.released = true;
    if (this.firstRequest) {
      const request = this.firstRequest;
      this.firstRequest = null;
      void this.sendRange(request, Array.from({ length: 48 }, (_, index) => this.message(269 + index)));
    }
  }

  async waitForRequest(count: number): Promise<RangeRequest> {
    while (this.requests.length < count) {
      await new Promise<void>((resolve) => this.requestWaiters.push(resolve));
    }
    return this.requests[count - 1]!;
  }

  async sendMissingTail(): Promise<void> {
    const request = this.requests.at(-1);
    if (!request) throw new Error('no tail request to answer');
    await this.sendRange(request, [this.message(317, 'Recovered assistant reply'), this.idle(318)]);
  }

  private async handleWireMessage(raw: string): Promise<void> {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof envelope.pulse !== 'string') return;

    const bytes = unb64(envelope.pulse);
    const effects = this.streams.onBytes(bytes, Date.now());
    await this.run(effects);
  }

  private async run(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.t === 'transmit') {
        this.ws.send(JSON.stringify({
          type: 'unicast',
          to: ARM_ID,
          pulse: b64(effect.bytes),
          blob: '',
          keys: {},
        }));
      } else if (effect.t === 'deliver') {
        await this.handleDelivered(effect.payload);
      }
    }
  }

  private async handleDelivered(payloadBytes: Uint8Array): Promise<void> {
    const outer = JSON.parse(new TextDecoder().decode(payloadBytes)) as { blob?: string; keys?: Record<string, string> };
    if (!outer.blob || !outer.keys?.[TENTACLE_ID]) return;

    const raw = unb64(outer.blob);
    const wrapped = unb64(outer.keys[TENTACLE_ID]);
    const aesRaw = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, this.tentaclePrivateKey, wrapped);
    const aesKey = await webcrypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12), tagLength: 128 },
      aesKey,
      raw.slice(12),
    );
    const message = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
    if (message.type !== 'request_session_messages_range') return;

    const payload = message.payload as RangeRequest;
    const request = {
      sessionId: payload.sessionId,
      fromSeq: payload.fromSeq,
      toSeq: payload.toSeq,
    };
    this.requests.push(request);
    this.requestWaiters.splice(0).forEach((resolve) => resolve());

    if (this.requests.length === 1 && !this.released) {
      this.firstRequest = request;
      return;
    }
  }

  private async sendRange(request: RangeRequest, messages: Record<string, unknown>[]): Promise<void> {
    if (!this.armPublicKey) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (!this.armPublicKey) throw new Error('ARM encryption key was not available');

    const plaintext = JSON.stringify({
      type: 'session_messages_range_batch',
      deviceId: TENTACLE_ID,
      seq: 900,
      timestamp: new Date().toISOString(),
      payload: {
        sessionId: request.sessionId,
        messages,
        firstSeq: messages[0]?.seq ?? 0,
        lastSeq: messages.at(-1)?.seq ?? 0,
        truncated: false,
      },
    });
    const aesRaw = webcrypto.getRandomValues(new Uint8Array(32));
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const aesKey = await webcrypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, true, ['encrypt']);
    const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      new TextEncoder().encode(plaintext),
    ));
    const wrapped = await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, this.armPublicKey, aesRaw);
    const blob = new Uint8Array(iv.length + ciphertext.length);
    blob.set(iv, 0);
    blob.set(ciphertext, iv.length);
    const payloadJson = JSON.stringify({ blob: b64(blob), keys: { [ARM_ID]: b64(wrapped) } });
    const { seq, effects } = this.streams.send(1, new TextEncoder().encode(payloadJson));
    void seq;
    await this.run(effects);
  }

  private message(seq: number, content = `Cached message ${seq}`): Record<string, unknown> {
    return {
      type: 'user_message',
      sessionId: SESSION_ID,
      deviceId: TENTACLE_ID,
      seq,
      timestamp: new Date().toISOString(),
      payload: { content },
    };
  }

  private idle(seq: number): Record<string, unknown> {
    return {
      type: 'idle',
      sessionId: SESSION_ID,
      deviceId: TENTACLE_ID,
      seq,
      timestamp: new Date().toISOString(),
      payload: { reason: 'completed' },
    };
  }
}

test.describe('active session tail reconciliation', () => {
  let server: MockRelayServer;

  test.beforeEach(async () => {
    server = await MockRelayServer.create();
  });

  test.afterEach(async () => {
    await server.close();
  });

  test('sends a real range request after a warm-up already owns the session load', async ({ page }) => {
    const tentacleKeys = await generateRsaKeyPair();
    const tentaclePublicKey = await publicKeyBase64(tentacleKeys.publicKey);
    const connection = server.waitForConnection();
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto(`/?relay=${encodeURIComponent(server.url)}&token=tail-reconcile-test`);

    const ws = await connection;
    const auth = await server.waitForMessage(ws);
    const armPublicKey = (auth.device as { encryptionKey?: string } | undefined)?.encryptionKey;
    expect(armPublicKey).toBeTruthy();

    const peer = new BrowserPulsePeer(ws, tentacleKeys.privateKey);
    peer.setArmPublicKey(armPublicKey!);
    server.sendAuthOk(ws, {
      devices: [{ ...DEVICE, encryptionKey: tentaclePublicKey }],
      sessions: [{
        id: SESSION_ID,
        deviceId: TENTACLE_ID,
        deviceName: DEVICE.name,
        agent: 'copilot',
        model: 'gpt-4',
        state: 'idle',
        messageCount: 318,
        lastSeq: 318,
        readSeq: 318,
        // No preview deliberately makes this session part of the background
        // warm-up pass, before the detail page is opened.
      }],
    });
    peer.connect();

    const firstRequest = await peer.waitForRequest(1);
    expect(firstRequest).toMatchObject({ sessionId: SESSION_ID, fromSeq: 269, toSeq: 318 });

    await expect(page.getByText('Copilot').first()).toBeVisible({ timeout: 5_000 });
    await page.getByText('Copilot').first().click();
    await expect(page.locator('[data-chat-scroll]')).toBeVisible({ timeout: 5_000 });

    // The detail page now asks for the same authoritative tail while the
    // background warm-up is still waiting. Releasing the warm-up must lead to
    // a second, real encrypted range request instead of losing the foreground
    // reconciliation behind loadingSessions.
    peer.releaseFirstRequest();
    const secondRequest = await peer.waitForRequest(2);
    expect(secondRequest).toMatchObject({ sessionId: SESSION_ID, fromSeq: 317, toSeq: 318 });

    await expect(page.getByText('Recovered assistant reply')).toHaveCount(0);

    // Refresh while the foreground tail request is still unresolved. The new
    // WebSocket receives the same authoritative session_list, and must issue a
    // fresh range request even though the route and an older cache were already
    // present before refresh.
    const reconnect = server.waitForConnection();
    await page.reload();
    const ws2 = await reconnect;
    const auth2 = await server.waitForMessage(ws2);
    const armPublicKey2 = (auth2.device as { encryptionKey?: string } | undefined)?.encryptionKey;
    expect(armPublicKey2).toBeTruthy();
    const peer2 = new BrowserPulsePeer(ws2, tentacleKeys.privateKey);
    peer2.setArmPublicKey(armPublicKey2!);
    server.sendAuthOk(ws2, {
      devices: [{ ...DEVICE, encryptionKey: tentaclePublicKey }],
      sessions: [{
        id: SESSION_ID,
        deviceId: TENTACLE_ID,
        deviceName: DEVICE.name,
        agent: 'copilot',
        model: 'gpt-4',
        state: 'idle',
        messageCount: 318,
        lastSeq: 318,
        readSeq: 318,
      }],
    });
    peer2.connect();

    const refreshRequest = await peer2.waitForRequest(1);
    expect(refreshRequest).toMatchObject({ sessionId: SESSION_ID, fromSeq: 317, toSeq: 318 });
    await peer2.sendMissingTail();
    await expect(page.getByText('Recovered assistant reply')).toBeVisible({ timeout: 10_000 });

    const stored = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('kraki-messages');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return await new Promise<Array<{ sessionId: string; seq: number; data: { payload?: { content?: string } } }>>((resolve, reject) => {
        const request = db.transaction('messages', 'readonly').objectStore('messages').getAll();
        request.onsuccess = () => resolve(request.result as Array<{ sessionId: string; seq: number; data: { payload?: { content?: string } } }>);
        request.onerror = () => reject(request.error);
      });
    });
    expect(stored).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: SESSION_ID, seq: 317, data: expect.objectContaining({ payload: { content: 'Recovered assistant reply' } }) }),
      expect.objectContaining({ sessionId: SESSION_ID, seq: 318 }),
    ]));
  });
});
