import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server } from 'http';
import { type AddressInfo } from 'net';

export class MockRelayServer {
  private wss: WebSocketServer;
  private httpServer: Server;
  private _seq = 0;

  readonly port: number;
  readonly url: string;

  private constructor(httpServer: Server, wss: WebSocketServer, port: number) {
    this.httpServer = httpServer;
    this.wss = wss;
    this.port = port;
    this.url = `ws://localhost:${port}`;
  }

  static async create(port = 0): Promise<MockRelayServer> {
    return new Promise((resolve) => {
      const httpServer = createServer();
      const wss = new WebSocketServer({ server: httpServer });

      httpServer.listen(port, () => {
        const actualPort = (httpServer.address() as AddressInfo).port;
        resolve(new MockRelayServer(httpServer, wss, actualPort));
      });
    });
  }

  /** Reset the sequence counter. */
  resetSeq(value = 0): void {
    this._seq = value;
  }

  get seq(): number {
    return this._seq;
  }

  /** Wait for the next client connection. */
  waitForConnection(): Promise<WebSocket> {
    return new Promise((resolve) => {
      this.wss.once('connection', (ws) => resolve(ws));
    });
  }

  /** Wait for the next message from a client. */
  waitForMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      ws.once('message', (data) => {
        resolve(JSON.parse(data.toString()));
      });
    });
  }

  /** Send an auth_ok frame with optional session/device/readState data. */
  sendAuthOk(
    ws: WebSocket,
    options: {
      channel?: string;
      deviceId?: string;
      sessions?: Record<string, unknown>[];
      devices?: Record<string, unknown>[];
      readState?: Record<string, number>;
      e2e?: boolean;
    } = {},
  ): void {
    const {
      channel = 'test-channel',
      deviceId = 'test-device',
      sessions = [],
      devices = [],
      readState = {},
      e2e = false,
    } = options;

    ws.send(
      JSON.stringify({
        type: 'auth_ok',
        channel,
        deviceId,
        sessions,
        devices,
        readState,
        e2e,
      }),
    );
  }

  /**
   * Send a data message. Automatically stamps seq, channel, deviceId, and timestamp
   * unless the caller provides them.
   */
  sendMessage(ws: WebSocket, msg: Record<string, unknown>): void {
    const envelope: Record<string, unknown> = {
      seq: this._seq++,
      channel: 'test-channel',
      deviceId: 'tentacle-1',
      timestamp: new Date().toISOString(),
      ...msg,
    };

    ws.send(JSON.stringify(envelope));
  }

  /** Gracefully close the server. */
  async close(): Promise<void> {
    for (const client of this.wss.clients) {
      client.close();
    }

    return new Promise((resolve, reject) => {
      this.wss.close(() => {
        this.httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }
}
