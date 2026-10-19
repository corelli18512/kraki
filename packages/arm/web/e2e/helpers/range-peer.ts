import { webcrypto } from 'node:crypto';
import { Endpoint, StreamSet, type Effect } from '@kraki/pulse';
import type { WebSocket } from 'ws';

export interface RangeRequest { sessionId: string; fromSeq: number; toSeq: number }
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));

/** Receives the browser's real encrypted range requests. Responses can use
 * MockRelayServer's plaintext test transport, just like live-message fixtures. */
export class RangePeer {
  private readonly streams = new StreamSet([0, 1].map((streamId) => new Endpoint({
    epoch: `range-test:${Date.now()}:${streamId}`, durable: { supported: false }, streamId,
  })));
  readonly requests: RangeRequest[] = [];
  onRequest?: (request: RangeRequest) => void;
  private chain = Promise.resolve();

  private constructor(private ws: WebSocket, private key: CryptoKey, readonly publicKey: string) {
    ws.on('message', (data) => {
      this.chain = this.chain.then(async () => {
        const frame = JSON.parse(data.toString());
        if (typeof frame.pulse === 'string') await this.run(this.streams.onBytes(bytes(frame.pulse), Date.now()));
      });
    });
  }

  static async create(ws: WebSocket): Promise<RangePeer> {
    const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const publicKey = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64');
    return new RangePeer(ws, keys.privateKey, publicKey);
  }

  connect() { void this.run(this.streams.onConnected(Date.now())); }

  private async run(effects: Effect[]): Promise<void> {
    for (const effect of effects) {
      if (effect.t === 'transmit') {
        this.ws.send(JSON.stringify({ type: 'unicast', to: 'test-device', pulse: Buffer.from(effect.bytes).toString('base64'), blob: '', keys: {} }));
      } else if (effect.t === 'deliver') {
        const envelope = JSON.parse(new TextDecoder().decode(effect.payload));
        if (!envelope.blob || !envelope.keys?.['tentacle-1']) continue;
        const raw = bytes(envelope.blob);
        const aesRaw = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, this.key, bytes(envelope.keys['tentacle-1']));
        const aes = await webcrypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
        const plaintext = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), tagLength: 128 }, aes, raw.slice(12));
        const message = JSON.parse(new TextDecoder().decode(plaintext));
        if (message.type === 'request_session_messages_range') {
          this.requests.push(message.payload);
          this.onRequest?.(message.payload);
        }
      }
    }
  }
}
