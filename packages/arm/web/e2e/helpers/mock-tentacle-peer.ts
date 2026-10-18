import { webcrypto } from 'node:crypto';
import { Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import type { WebSocket } from 'ws';

type Message = Record<string, unknown>;

/** Receives real encrypted ARM commands instead of treating a cleared input as delivery. */
export class MockTentaclePeer {
  private readonly streams = new StreamSet([
    new Endpoint({ epoch: `mock:${Date.now()}:live`, durable: { supported: false }, streamId: 0 }),
    new Endpoint({ epoch: `mock:${Date.now()}:bulk`, durable: { supported: false }, streamId: 1 }),
  ]);
  private chain = Promise.resolve();
  private readonly messages: Message[] = [];
  private readonly waiters: Array<{ type: string; resolve: (message: Message) => void; reject: (error: Error) => void }> = [];
  private failure: Error | undefined;

  private constructor(
    private readonly ws: WebSocket,
    private readonly deviceId: string,
    private readonly privateKey: webcrypto.CryptoKey,
    readonly encryptionKey: string,
  ) {
    ws.on('message', (data) => {
      this.chain = this.chain.then(async () => {
        const envelope = JSON.parse(data.toString()) as { pulse?: string };
        if (!envelope.pulse) return;
        await this.run(this.streams.onBytes(new Uint8Array(Buffer.from(envelope.pulse, 'base64')), Date.now()));
      }).catch((error: Error) => {
        this.failure = error;
        this.waiters.splice(0).forEach((waiter) => waiter.reject(error));
      });
    });
  }

  static async create(ws: WebSocket, deviceId: string): Promise<MockTentaclePeer> {
    const keys = await webcrypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['encrypt', 'decrypt'],
    );
    const publicKey = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    return new MockTentaclePeer(ws, deviceId, keys.privateKey, publicKey);
  }

  connect(): void {
    this.chain = this.chain.then(() => this.run(this.streams.onConnected(Date.now())));
  }

  waitForMessage(type: string): Promise<Message> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => this.waiters.push({ type, resolve, reject }));
  }

  private async run(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.t === 'transmit') {
        this.ws.send(JSON.stringify({
          type: 'unicast',
          pulse: Buffer.from(effect.bytes).toString('base64'),
          blob: '',
          keys: {},
        }));
      } else if (effect.t === 'deliver') {
        const outer = JSON.parse(new TextDecoder().decode(effect.payload)) as { blob: string; keys: Record<string, string> };
        const raw = new Uint8Array(Buffer.from(outer.blob, 'base64'));
        const wrapped = new Uint8Array(Buffer.from(outer.keys[this.deviceId]!, 'base64'));
        const aesRaw = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, this.privateKey, wrapped);
        const aesKey = await webcrypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
        const plaintext = await webcrypto.subtle.decrypt(
          { name: 'AES-GCM', iv: raw.slice(0, 12), tagLength: 128 }, aesKey, raw.slice(12),
        );
        const message = JSON.parse(new TextDecoder().decode(plaintext)) as Message;
        const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
        if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(message);
        else this.messages.push(message);
      }
    }
  }
}
