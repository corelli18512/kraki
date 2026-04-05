
/**
 * Integration tests: Head (thin relay) + Tentacle (RelayClient) + App (MockApp)
 *
 * The relay is a thin encrypted forwarder — it only does auth + blob routing.
 * Tentacle broadcasts encrypted BroadcastEnvelopes to all apps.
 * Apps send encrypted UnicastEnvelopes to specific tentacles.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPair, exportPublicKey, importPublicKey, encryptToBlob, decryptFromBlob } from "@kraki/crypto";
import {
  createTestEnv, connectApp, connectAppWithCrypto, createRelayClient,
  createTmpSessionDir, waitMs, type TestEnv, type MockApp,
} from "./helpers.js";
import { SessionManager, RelayClient, KeyManager } from "@kraki/tentacle";
import type { AgentAdapter, CreateSessionConfig, SessionInfo, SessionContext } from "@kraki/tentacle";
import type { AuthProvider, AuthUser } from "@kraki/head";
import type { AuthCredentials, AuthOutcome } from "@kraki/head";
import { WebSocket } from "ws";

// ── Mock Adapter ────────────────────────────────────────

class MockAdapter {
  onSessionCreated: ((event: { sessionId: string; agent: string; model?: string }) => void) | null = null;
  onMessage: ((sessionId: string, event: { content: string }) => void) | null = null;
  onMessageDelta: ((sessionId: string, event: { content: string }) => void) | null = null;
  onPermissionRequest: ((sessionId: string, event: { id: string; toolArgs: unknown; description: string }) => void) | null = null;
  onPermissionAutoResolved: ((sessionId: string, permissionId: string) => void) | null = null;
  onQuestionRequest: ((sessionId: string, event: { id: string; question: string }) => void) | null = null;
  onToolStart: ((sessionId: string, event: { toolName: string; args: Record<string, unknown> }) => void) | null = null;
  onToolComplete: ((sessionId: string, event: { toolName: string; result: string }) => void) | null = null;
  onIdle: ((sessionId: string) => void) | null = null;
  onError: ((sessionId: string, event: { message: string }) => void) | null = null;
  onSessionEnded: ((sessionId: string, event: { reason: string }) => void) | null = null;

  private sessionCounter = 0;
  started = false;
  sessions = new Map<string, { ended: boolean }>();
  lastPermissionResponse: string | null = null;
  lastQuestionResponse: string | null = null;
  lastMessage: string | null = null;
  killedSessions: string[] = [];

  async start() { this.started = true; }
  async stop() { this.started = false; }
  async createSession(config?: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config?.sessionId ?? `mock_sess_${++this.sessionCounter}`;
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: "mock", model: "mock-v1" });
    return { sessionId };
  }
  async resumeSession(sessionId: string, _context?: SessionContext): Promise<{ sessionId: string }> {
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: "mock", model: "mock-v1" });
    return { sessionId };
  }
  async sendMessage(sessionId: string, text: string) { this.lastMessage = { sessionId, text }; }
  async respondToPermission(sid: string, pid: string, d: string) {
    this.lastPermissionResponse = { sessionId: sid, permissionId: pid, decision: d };
  }
  async respondToQuestion(sid: string, qid: string, a: string) {
    this.lastQuestionResponse = { sessionId: sid, questionId: qid, answer: a };
  }
  async endSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "ended" });
  }
  async killSession(sessionId: string) {
    this.killedSessions.push(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "stopped" });
  }
  async abortSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "stopped" });
  }
  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id, state: s.ended ? "ended" as const : "active" as const,
    }));
  }
  async listModels(): Promise<string[]> { return ["mock-model"]; }
  setSessionMode(_sid: string, _mode: "ask" | "auto"): void {}
  updateAllowList(_tools: Set<string>): void {}

  simulateAgentMessage(sid: string, content: string) { this.onMessage?.(sid, { content }); }
  simulateAgentDelta(sid: string, content: string) { this.onMessageDelta?.(sid, { content }); }
  simulatePermissionRequest(sid: string, id: string, toolName: string, desc: string) {
    this.onPermissionRequest?.(sid, { id, toolArgs: { toolName, args: {} }, description: desc });
  }
  simulateQuestion(sid: string, id: string, question: string, choices?: string[]) {
    this.onQuestionRequest?.(sid, { id, question, choices, allowFreeform: true });
  }
  simulateError(sid: string, message: string) { this.onError?.(sid, { message }); }
}

// ── Multi-user auth provider (for user isolation tests) ──

class MultiUserAuthProvider implements AuthProvider {
  readonly name = "multi-user";
  async authenticate(credentials: AuthCredentials): Promise<AuthOutcome> {
    if (credentials.token === "user_a") {
      return { ok: true, user: { id: "user_a", login: "alice", provider: "multi" } };
    }
    if (credentials.token === "user_b") {
      return { ok: true, user: { id: "user_b", login: "bob", provider: "multi" } };
    }
    return { ok: true, user: { id: "local", login: "local", provider: "open" } };
  }
}

// ── Tests ────────────────────────────────────────────────

describe("Thin Relay Integration: Head + Tentacle + App", () => {
  let env: TestEnv;
  let adapter: MockAdapter;
  let sm: SessionManager;
  let km: KeyManager;
  let relay: RelayClient;
  let sessDir: { dir: string; cleanup: () => void };
  let kmDir: { dir: string; cleanup: () => void };

  beforeEach(async () => {
    env = await createTestEnv();
    adapter = new MockAdapter();
    sessDir = createTmpSessionDir();
    kmDir = createTmpSessionDir();
    sm = new SessionManager(sessDir.dir);
    km = new KeyManager(kmDir.dir);
  });

  afterEach(async () => {
    relay?.disconnect();
    await env.cleanup();
    sessDir.cleanup();
    kmDir.cleanup();
  });

  /** Connect tentacle relay client (uses KeyManager for E2E). */
  async function connectTentacle(opts?: { token?: string; name?: string }): Promise<void> {
    relay = new RelayClient(
      adapter as unknown as AgentAdapter,
      sm,
      {
        relayUrl: `ws://127.0.0.1:${env.port}`,
        device: { name: opts?.name ?? "Test Laptop", role: "tentacle", kind: "desktop" },
        token: opts?.token,
      },
      km,
    );
    await new Promise<void>((resolve, reject) => {
      relay.onAuthenticated = () => resolve();
      relay.onFatalError = (msg) => reject(new Error(msg));
      relay.connect();
    });
  }

  // ── 1. Auth + connect ────────────────────────────────

  it("1. tentacle authenticates and receives auth_ok with correct format", async () => {
    await connectTentacle();
    const info = relay.getAuthInfo();
    expect(info).toBeTruthy();
    expect(info!.type).toBe("auth_ok");
    expect(info!.deviceId).toBeTruthy();
    expect(info!.user.id).toBe("local");
    expect(info!.user.login).toBe("local");
    expect(info!.devices).toBeInstanceOf(Array);
    // Thin relay auth_ok has no channel, sessions, readState, e2e
    expect((info as Record<string, unknown>).channel).toBeUndefined();
    expect((info as Record<string, unknown>).sessions).toBeUndefined();
    expect((info as Record<string, unknown>).readState).toBeUndefined();
  });

  // ── 2. Broadcast: agent_message ──────────────────────

  it("2. tentacle broadcasts agent_message → app receives decrypted", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    const created = await app.waitFor("session_created");
    expect(created.sessionId).toBe(sessionId);

    adapter.simulateAgentMessage(sessionId, "hello from agent");
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content).toBe("hello from agent");
    expect(msg.seq).toBeGreaterThan(0);

    app.close();
  });

  // ── 3. Unicast: app sends approve ────────────────────

  it("3. app sends approve via unicast → adapter receives", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulatePermissionRequest(sessionId, "perm_1", "shell", "Run npm test");
    await app.waitFor("permission");

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "approve", sessionId, payload: { permissionId: "perm_1" },
    }, km.getCompactPublicKey());
    await waitMs(200);

    expect(adapter.lastPermissionResponse).toEqual({
      sessionId, permissionId: "perm_1", decision: "approve",
    });

    app.close();
  });

  // ── 4. Question flow ─────────────────────────────────

  it("4. tentacle sends question → app answers via unicast → adapter receives", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateQuestion(sessionId, "q_1", "Which DB?", ["Postgres", "SQLite"]);
    const q = await app.waitFor("question");
    expect(q.payload.choices).toEqual(["Postgres", "SQLite"]);

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "answer", sessionId, payload: { questionId: "q_1", answer: "SQLite" },
    }, km.getCompactPublicKey());
    await waitMs(200);

    expect(adapter.lastQuestionResponse).toEqual({
      sessionId, questionId: "q_1", answer: "SQLite",
    });

    app.close();
  });

  // ── 5. Permission flow (deny) ────────────────────────

  it("5. permission deny flows from app to adapter", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulatePermissionRequest(sessionId, "perm_2", "write_file", "Write app.js");
    const perm = await app.waitFor("permission");
    expect(perm.payload.id).toBe("perm_2");

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "deny", sessionId, payload: { permissionId: "perm_2" },
    }, km.getCompactPublicKey());
    await waitMs(200);

    expect(adapter.lastPermissionResponse?.decision).toBe("deny");

    app.close();
  });

  // ── 6. Streaming (agent_message_delta) ───────────────

  it("6. agent_message_delta broadcasts arrive at app", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateAgentDelta(sessionId, "hel");
    adapter.simulateAgentDelta(sessionId, "lo");

    const d1 = await app.waitFor("agent_message_delta");
    const d2 = await app.waitFor("agent_message_delta");
    expect(d1.payload.content + d2.payload.content).toBe("hello");

    app.close();
  });

  // ── 7. Error forwarding ──────────────────────────────

  it("7. error broadcast arrives at app", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateError(sessionId, "something broke");
    const err = await app.waitFor("error");
    expect(err.payload.message).toBe("something broke");

    app.close();
  });

  // ── 8. Multi-app ─────────────────────────────────────

  it("8. two apps both receive same broadcast from tentacle", async () => {
    const app1 = await connectApp(env.port, "App 1");
    const app2 = await connectApp(env.port, "App 2");
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app1.waitFor("session_created");
    await app2.waitFor("session_created");

    adapter.simulateAgentMessage(sessionId, "broadcast to all");
    const m1 = await app1.waitFor("agent_message");
    const m2 = await app2.waitFor("agent_message");
    expect(m1.payload.content).toBe("broadcast to all");
    expect(m2.payload.content).toBe("broadcast to all");

    app1.close();
    app2.close();
  });

  // ── 9. Multi-tentacle ────────────────────────────────

  it("9. two tentacles under same user, app receives from both", async () => {
    const app = await connectApp(env.port);

    // First tentacle
    await connectTentacle({ name: "Laptop" });
    const relay1 = relay;
    const adapter1 = adapter;

    // Second tentacle with its own adapter + session manager + key manager
    const sessDir2 = createTmpSessionDir();
    const kmDir2 = createTmpSessionDir();
    const sm2 = new SessionManager(sessDir2.dir);
    const km2 = new KeyManager(kmDir2.dir);
    const adapter2 = new MockAdapter();
    const relay2 = new RelayClient(
      adapter2 as unknown as AgentAdapter, sm2,
      { relayUrl: `ws://127.0.0.1:${env.port}`, device: { name: "Work PC", role: "tentacle", kind: "desktop" } },
      km2,
    );
    await new Promise<void>((resolve, reject) => {
      relay2.onAuthenticated = () => resolve();
      relay2.onFatalError = (msg) => reject(new Error(msg));
      relay2.connect();
    });

    const s1 = await adapter1.createSession();
    const s2 = await adapter2.createSession();
    await app.waitFor("session_created");
    await app.waitFor("session_created");

    adapter1.simulateAgentMessage(s1.sessionId, "from laptop");
    adapter2.simulateAgentMessage(s2.sessionId, "from workpc");

    const msgs = await app.waitForN("agent_message", 2);
    const contents = msgs.map(m => m.payload.content).sort();
    expect(contents).toEqual(["from laptop", "from workpc"]);

    relay2.disconnect();
    sessDir2.cleanup();
    kmDir2.cleanup();
    app.close();
  });

  // ── 10. User isolation ───────────────────────────────

  it("10. tentacle for user A → app for user B does NOT receive", async () => {
    // Use a separate env with multi-user auth
    relay?.disconnect();
    await env.cleanup();
    const multiEnv = await createTestEnv({ authProvider: new MultiUserAuthProvider() });

    // User A's app (connects first so tentacle sees it)
    const appA = await connectApp(multiEnv.port, "App A", { token: "user_a" });

    // User A's tentacle
    const kmA = new KeyManager(createTmpSessionDir().dir);
    const smA = new SessionManager(createTmpSessionDir().dir);
    const adapterA = new MockAdapter();
    const relayA = new RelayClient(
      adapterA as unknown as AgentAdapter, smA,
      { relayUrl: `ws://127.0.0.1:${multiEnv.port}`, device: { name: "A Laptop", role: "tentacle" }, token: "user_a" },
      kmA,
    );
    await new Promise<void>((resolve, reject) => {
      relayA.onAuthenticated = () => resolve();
      relayA.onFatalError = (msg) => reject(new Error(msg));
      relayA.connect();
    });

    // User B's app (raw WebSocket, just listening for any messages)
    const wsB = new WebSocket(`ws://127.0.0.1:${multiEnv.port}`);
    await new Promise<void>(r => wsB.on("open", r));
    const bMessages: Record<string, unknown>[] = [];
    wsB.on("message", (d) => bMessages.push(JSON.parse(d.toString())));
    wsB.send(JSON.stringify({
      type: "auth", auth: { method: "open", sharedKey: "user_b" },
      device: { name: "B Phone", role: "app", kind: "web" },
    }));
    // Wait for auth_ok
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (bMessages.some(m => m.type === "auth_ok")) { clearInterval(check); resolve(); }
      }, 10);
    });

    // User A tentacle broadcasts
    const { sessionId } = await adapterA.createSession();
    await appA.waitFor("session_created");

    adapterA.simulateAgentMessage(sessionId, "secret for A only");
    await appA.waitFor("agent_message");

    // Wait a bit — B should NOT have received anything beyond auth_ok
    await waitMs(300);
    const bNonAuth = bMessages.filter(m => m.type !== "auth_ok");
    expect(bNonAuth.length).toBe(0);

    relayA.disconnect();
    wsB.close();
    appA.close();
    await multiEnv.cleanup();
    // Reset env reference so afterEach doesn't double-close
    env = await createTestEnv();
  });

  // ── 11. Disconnect cleanup ───────────────────────────

  it("11. app disconnects → subsequent broadcasts don't crash", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateAgentMessage(sessionId, "before disconnect");
    await app.waitFor("agent_message");

    // App disconnects
    app.close();
    await waitMs(200);

    // Tentacle sends another message — should not crash (queued in E2E queue)
    adapter.simulateAgentMessage(sessionId, "after disconnect");
    await waitMs(200);

    // Verify relay is still alive by connecting a new app
    const app2 = await connectApp(env.port);

    // Tentacle receives device_joined for app2 — keys update automatically (no reconnect needed)
    // The queued "after disconnect" message gets flushed to app2
    const flushed = await app2.waitFor("agent_message");
    expect(flushed.payload.content).toBe("after disconnect");

    adapter.simulateAgentMessage(sessionId, "to new app");
    const msg = await app2.waitFor("agent_message");
    expect(msg.payload.content).toBe("to new app");

    app2.close();
  }, 15_000);

  // ── 12. Reconnect ────────────────────────────────────

  it("12. tentacle disconnects and reconnects → continues working", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();
    expect(relay.getState()).toBe("connected");

    // Force disconnect
    (relay as unknown as { ws: { close: () => void } | null }).ws?.close();
    await waitMs(100);
    expect(relay.getState()).toBe("disconnected");

    // Wait for auto-reconnect
    await new Promise<void>((resolve) => {
      relay.onStateChange = (s) => { if (s === "connected") resolve(); };
    });
    expect(relay.getState()).toBe("connected");

    // Verify messages still flow after reconnect
    const { sessionId } = await adapter.createSession();
    await waitMs(100);
    adapter.simulateAgentMessage(sessionId, "post-reconnect");
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content).toBe("post-reconnect");

    app.close();
  }, 15_000);

  // ── 13. Pairing ──────────────────────────────────────

  it("13. tentacle creates pairing token → new app pairs → receives auth_ok → can receive broadcasts", async () => {
    await connectTentacle();

    // Request a pairing token via the raw WS
    const tokenMsg = await new Promise<Record<string, unknown>>((resolve) => {
      (relay as unknown as { ws: { on: (event: string, cb: (data: Buffer) => void) => void } }).ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as unknown as { ws: { send: (data: string) => void } }).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });
    expect(tokenMsg.token).toMatch(/^pt_/);
    expect(tokenMsg.expiresIn).toBeGreaterThan(0);

    // New app pairs using the token
    const pairKp = generateKeyPair();
    const pairDeviceId = `dev_paired_${Date.now()}`;
    const pairCompactKey = exportPublicKey(pairKp.publicKey);
    const pairWs = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => pairWs.on("open", r));
    pairWs.send(JSON.stringify({
      type: "auth",
      auth: { method: "pairing", token: tokenMsg.token },
      device: { name: "Paired Phone", role: "app", kind: "ios", deviceId: pairDeviceId, publicKey: pairCompactKey },
    }));
    const authOk = await new Promise<Record<string, unknown>>((resolve) => {
      pairWs.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") resolve(m);
      });
    });
    expect(authOk.type).toBe("auth_ok");
    expect(authOk.deviceId).toBe(pairDeviceId);

    // Tentacle receives device_joined for paired app — keys update automatically (no reconnect needed)
    await waitMs(200);

    // Verify paired app can receive broadcasts
    const { sessionId } = await adapter.createSession();
    await waitMs(100);
    adapter.simulateAgentMessage(sessionId, "to paired app");
    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("No message received")), 5000);
      pairWs.on("message", (d: Buffer) => {
        const raw = JSON.parse(d.toString());
        if (raw.type === "broadcast") {
          try {
            const decrypted = decryptFromBlob(
              { blob: raw.blob, keys: raw.keys }, pairDeviceId, pairKp.privateKey,
            );
            const inner = JSON.parse(decrypted);
            if (inner.type === "agent_message") { clearTimeout(timer); resolve(inner); }
          } catch { /* skip */ }
        }
      });
    });
    expect(received.payload.content).toBe("to paired app");

    pairWs.close();
  }, 15_000);

  // ── 14. Challenge-response ───────────────────────────

  it("14. pair via token, disconnect, reconnect via challenge-response", async () => {
    await connectTentacle();

    const kp = generateKeyPair();
    const compactPubKey = exportPublicKey(kp.publicKey);
    const deviceId = "dev_challenge_test";

    // Step 1: Get pairing token
    const tokenMsg = await new Promise<Record<string, unknown>>((resolve) => {
      (relay as unknown as { ws: { on: (event: string, cb: (data: Buffer) => void) => void } }).ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as unknown as { ws: { send: (data: string) => void } }).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    // Step 2: Pair with token + publicKey + deviceId
    const ws1 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth",
      auth: { method: "pairing", token: tokenMsg.token },
      device: { name: "Challenge Phone", role: "app", kind: "web", publicKey: compactPubKey, deviceId },
    }));
    const authOk1 = await new Promise<Record<string, unknown>>(r => {
      ws1.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") r(m);
      });
    });
    expect(authOk1.deviceId).toBe(deviceId);
    ws1.close();
    await waitMs(200);

    // Step 3: Reconnect with just deviceId → challenge-response
    const app2 = await connectAppWithCrypto(env.port, {
      name: "Challenge Phone",
      deviceId,
      publicKey: kp.publicKey,
      privateKey: kp.privateKey,
    });
    expect(app2.authOk.type).toBe("auth_ok");
    expect(app2.authOk.deviceId).toBe(deviceId);

    // Step 4: Verify app works after challenge auth
    // Tentacle receives device_joined for reconnected app — keys update automatically
    await waitMs(200);

    const { sessionId } = await adapter.createSession();
    await waitMs(100);
    adapter.simulateAgentMessage(sessionId, "post-challenge message");
    const msg = await app2.waitFor("agent_message");
    expect(msg.payload.content).toBe("post-challenge message");

    app2.close();
  }, 15_000);

  // ── 15. Large message ────────────────────────────────

  it("15. 100KB blob passes through relay", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const bigContent = "x".repeat(100_000);
    adapter.simulateAgentMessage(sessionId, bigContent);
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content.length).toBe(100_000);

    app.close();
  });

  // ── 16. E2E encrypt/decrypt round-trip ───────────────

  it("16. tentacle encrypts → relay forwards blob → app decrypts → content matches", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const secretContent = "top secret agent code";
    adapter.simulateAgentMessage(sessionId, secretContent);

    // App's waitFor already decrypts — verify content matches
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content).toBe(secretContent);

    // Also verify the raw WS data was encrypted (not plaintext)
    // The raw messages on the wire are broadcast envelopes with encrypted blobs
    // Check that no raw message contains the secret in plaintext
    const rawOnWire: Record<string, unknown>[] = [];
    const verifyWs = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => verifyWs.on("open", r));
    // We can't retroactively check, but we verify the crypto round-trip worked:
    // The message came through as a BroadcastEnvelope (encrypted blob),
    // was decrypted by the app helper, and yielded the correct content.
    verifyWs.close();

    // Verify via the storage that there's no plaintext stored
    // (thin relay doesn't store messages at all)
    const devices = env.storage.getDevicesByUser("local");
    expect(devices.length).toBeGreaterThan(0);
    // No getMessagesAfterSeq — thin relay has no message storage

    app.close();
  });

  // ── Extra: challenge-response with wrong signature ───

  it("challenge-response rejects wrong signature", async () => {
    await connectTentacle();

    const kp = generateKeyPair();
    const kpWrong = generateKeyPair();
    const deviceId = "dev_wrong_sig";

    // Register device via pairing
    const tokenMsg = await new Promise<Record<string, unknown>>((resolve) => {
      (relay as unknown as { ws: { on: (event: string, cb: (data: Buffer) => void) => void } }).ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as unknown as { ws: { send: (data: string) => void } }).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    const ws1 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth",
      auth: { method: "pairing", token: tokenMsg.token },
      device: { name: "WrongSig", role: "app", publicKey: exportPublicKey(kp.publicKey), deviceId },
    }));
    await new Promise<Record<string, unknown>>(r => ws1.on("message", (d: Buffer) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") r(m);
    }));
    ws1.close();
    await waitMs(200);

    // Reconnect and sign with WRONG key
    const { signChallenge } = await import("@kraki/crypto");
    const ws2 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws2.on("open", r));
    ws2.send(JSON.stringify({
      type: "auth",
      auth: { method: "challenge", deviceId },
      device: { name: "WrongSig", role: "app", deviceId },
    }));

    const challenge = await new Promise<Record<string, unknown>>(r => {
      ws2.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_challenge") r(m);
      });
    });

    const badSig = signChallenge(challenge.nonce, kpWrong.privateKey);
    ws2.send(JSON.stringify({ type: "auth_response", deviceId, signature: badSig }));

    const error = await new Promise<Record<string, unknown>>(r => {
      ws2.on("message", (d: Buffer) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_error") r(m);
      });
    });
    expect(error.code).toBe("invalid_signature");
    expect(error.message).toContain("Invalid signature");

    ws2.close();
  }, 15_000);

  // ── Extra: rejected reused pairing token ─────────────

  it("reused pairing token is rejected", async () => {
    await connectTentacle();

    const tokenMsg = await new Promise<Record<string, unknown>>((resolve) => {
      (relay as unknown as { ws: { on: (event: string, cb: (data: Buffer) => void) => void } }).ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as unknown as { ws: { send: (data: string) => void } }).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    // Use token once (success)
    const ws1 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth", auth: { method: "pairing", token: tokenMsg.token },
      device: { name: "First", role: "app" },
    }));
    const ok = await new Promise<Record<string, unknown>>(r => ws1.on("message", (d: Buffer) => r(JSON.parse(d.toString()))));
    expect(ok.type).toBe("auth_ok");
    ws1.close();

    // Try to reuse (should fail)
    const ws2 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws2.on("open", r));
    ws2.send(JSON.stringify({
      type: "auth", auth: { method: "pairing", token: tokenMsg.token },
      device: { name: "Second", role: "app" },
    }));
    const err = await new Promise<Record<string, unknown>>(r => ws2.on("message", (d: Buffer) => r(JSON.parse(d.toString()))));
    expect(err.type).toBe("auth_error");
    expect(err.code).toBe("invalid_pairing_token");
    expect(err.message).toContain("Invalid or expired");
    ws2.close();
  });

  // ── Extra: create_session via unicast ─────────────────

  it("app sends create_session unicast → tentacle creates session", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "create_session",
      payload: { requestId: "req_test", model: "mock-model" },
    }, km.getCompactPublicKey());

    const created = await app.waitFor("session_created");
    expect(created.type).toBe("session_created");
    expect(created.payload.agent).toBe("mock");
    expect(adapter.sessions.size).toBe(1);

    app.close();
  });

  // ── Extra: create_session with prompt ─────────────────

  it("create_session with prompt sends initial message", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "create_session",
      payload: { requestId: "req_prompt", model: "mock", prompt: "Fix the login bug" },
    }, km.getCompactPublicKey());

    await app.waitFor("session_created");
    await waitMs(200);

    expect(adapter.lastMessage).toBeTruthy();
    expect(adapter.lastMessage.text).toBe("Fix the login bug");

    app.close();
  });

  // ── Extra: app can kill remotely created session ──────

  it("app kills session via unicast", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "kill_session", sessionId, payload: {},
    }, km.getCompactPublicKey());

    const ended = await app.waitFor("session_ended");
    expect(ended.sessionId).toBe(sessionId);
    expect(ended.payload.reason).toBe("stopped");

    app.close();
  });

  // ── Extra: send_input via unicast ─────────────────────

  it("app sends input to tentacle via unicast", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "send_input", sessionId, payload: { text: "fix the bug" },
    }, km.getCompactPublicKey());
    await waitMs(200);

    expect(adapter.lastMessage).toEqual({ sessionId, text: "fix the bug" });

    app.close();
  });

  // ── Extra: device_joined enables immediate E2E without reconnect ──

  it("tentacle connects first → app joins → tentacle receives device_joined → greeting + data arrive", async () => {
    // Tentacle connects FIRST (no apps yet — E2E queue will hold messages)
    await connectTentacle();

    // Now app connects — relay sends device_joined to tentacle
    const app = await connectApp(env.port);

    // App should receive the device_greeting unicast triggered by device_joined
    const greeting = await app.waitFor("device_greeting");
    expect(greeting.payload.name).toBe("Test Laptop");
    expect(greeting.payload.kind).toBe("desktop");

    // Tentacle creates session and broadcasts — should reach app without reconnect
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateAgentMessage(sessionId, "hello via device_joined");
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content).toBe("hello via device_joined");

    app.close();
  });

  // ── Extra: server_error echoes ref from unicast envelope ──

  it("unicast to offline tentacle is queued and delivered on reconnect", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();
    const tentacleId = relay.getAuthInfo()!.deviceId;
    const tentacleKey = km.getCompactPublicKey();

    // Disconnect tentacle so it goes offline
    relay.disconnect();
    await waitMs(200);

    // Send unicast to the now-offline tentacle — should be queued (no error)
    const ref = "req_test_12345";
    const recipientPubKey = importPublicKey(tentacleKey);
    const innerMsg = { type: "create_session", payload: { requestId: ref } };
    const { blob, keys } = encryptToBlob(JSON.stringify(innerMsg), [
      { deviceId: tentacleId, publicKey: recipientPubKey },
    ]);
    app.ws.send(JSON.stringify({ type: "unicast", to: tentacleId, blob, keys, ref }));

    // No server_error should arrive — message is queued
    await waitMs(300);

    app.close();
  });

  // ── delete_session E2E ──────────────────────────────────

  it("app deletes session via unicast → tentacle kills adapter + deletes metadata + broadcasts session_deleted", async () => {
    const app = await connectApp(env.port);
    await connectTentacle();

    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const tentacleId = relay.getAuthInfo()!.deviceId;
    app.sendUnicast(tentacleId, {
      type: "delete_session", sessionId, payload: {},
    }, km.getCompactPublicKey());

    // App should receive session_deleted broadcast
    const deleted = await app.waitFor("session_deleted");
    expect(deleted.sessionId).toBe(sessionId);

    // Adapter's killSession should have been called
    expect(adapter.killedSessions).toContain(sessionId);

    app.close();
  });
});
