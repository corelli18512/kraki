
/**
 * Real integration tests: Head + RelayClient + SessionManager + MockAdapter
 *
 * Uses real head server, real relay client, real session manager.
 * Only the agent adapter is mocked (no real Copilot SDK).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPair, encrypt, decrypt, exportPublicKey, importPublicKey } from "@kraki/crypto";
import { createTestEnv, connectApp, connectAppWithKeys, connectAppWithCrypto, createRelayClient, createTmpSessionDir, waitMs, type TestEnv, type MockApp } from "./helpers.js";
import { SessionManager, RelayClient, KeyManager } from "@kraki/tentacle";
import type { AgentAdapter, CreateSessionConfig, SessionInfo, SessionContext } from "@kraki/tentacle";

class MockAdapter {
  onSessionCreated: any = null;
  onMessage: any = null;
  onMessageDelta: any = null;
  onPermissionRequest: any = null;
  onQuestionRequest: any = null;
  onToolStart: any = null;
  onToolComplete: any = null;
  onIdle: any = null;
  onError: any = null;
  onSessionEnded: any = null;

  private sessionCounter = 0;
  started = false;
  sessions = new Map<string, { ended: boolean }>();
  lastPermissionResponse: any = null;
  lastQuestionResponse: any = null;
  lastMessage: any = null;

  async start() { this.started = true; }
  async stop() { this.started = false; }
  async createSession(config?: CreateSessionConfig): Promise<{ sessionId: string }> {
    const sessionId = config?.sessionId ?? `mock_sess_${++this.sessionCounter}`;
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: "mock", model: "mock-v1" });
    return { sessionId };
  }
  async resumeSession(sessionId: string, context?: SessionContext): Promise<{ sessionId: string }> {
    this.sessions.set(sessionId, { ended: false });
    this.onSessionCreated?.({ sessionId, agent: "mock", model: "mock-v1" });
    return { sessionId };
  }
  async sendMessage(sessionId: string, text: string) { this.lastMessage = { sessionId, text }; }
  async respondToPermission(sid: string, pid: string, d: string) { this.lastPermissionResponse = { sessionId: sid, permissionId: pid, decision: d }; }
  async respondToQuestion(sid: string, qid: string, a: string) { this.lastQuestionResponse = { sessionId: sid, questionId: qid, answer: a }; }
  async endSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "ended" });
  }
  async stopSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "stopped" });
  }
  // Adapter requires this method name
  async killSession(sessionId: string) {
    const s = this.sessions.get(sessionId);
    if (s) s.ended = true;
    this.onSessionEnded?.(sessionId, { reason: "stopped" });
  }
  async listSessions(): Promise<SessionInfo[]> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id, state: s.ended ? "ended" as const : "active" as const,
    }));
  }
  async listModels(): Promise<string[]> {
    return ["mock-model-a", "mock-model-b"];
  }
  setSessionMode(_sid: string, _mode: 'ask' | 'auto'): void { /* no-op */ }
  updateAllowList(_tools: Set<string>): void { /* no-op */ }

  simulateAgentMessage(sid: string, content: string) { this.onMessage?.(sid, { content }); }
  simulateAgentDelta(sid: string, content: string) { this.onMessageDelta?.(sid, { content }); }
  simulatePermissionRequest(sid: string, id: string, toolName: string, desc: string) {
    this.onPermissionRequest?.(sid, { id, toolArgs: { toolName, args: {} }, description: desc });
  }
  simulateQuestion(sid: string, id: string, question: string, choices?: string[]) {
    this.onQuestionRequest?.(sid, { id, question, choices, allowFreeform: true });
  }
  simulateToolStart(sid: string, toolName: string, args: Record<string, unknown> = {}) {
    this.onToolStart?.(sid, { toolName, args });
  }
  simulateToolComplete(sid: string, toolName: string, result: string) {
    this.onToolComplete?.(sid, { toolName, result });
  }
  simulateIdle(sid: string) { this.onIdle?.(sid); }
  simulateError(sid: string, message: string) { this.onError?.(sid, { message }); }
}

describe("Real Integration: Head + RelayClient + SessionManager", () => {
  let env: TestEnv;
  let adapter: MockAdapter;
  let sm: SessionManager;
  let relay: RelayClient;
  let sessDir: { dir: string; cleanup: () => void };

  beforeEach(async () => {
    env = await createTestEnv();
    adapter = new MockAdapter();
    sessDir = createTmpSessionDir();
    sm = new SessionManager(sessDir.dir);
    relay = createRelayClient(adapter as unknown as AgentAdapter, sm, env.port);

    await new Promise<void>((resolve, reject) => {
      relay.onAuthenticated = () => resolve();
      relay.onFatalError = (msg) => reject(new Error(msg));
      relay.connect();
    });
  });

  afterEach(async () => {
    relay.disconnect();
    await env.cleanup();
    sessDir.cleanup();
  });

  it("1. should route agent message through relay to app", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateAgentMessage(sessionId, "hello from agent");
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content).toBe("hello from agent");
    expect(msg.seq).toBeGreaterThan(0);
    app.close();
  });

  it("2. should route app approval back to adapter", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulatePermissionRequest(sessionId, "perm_1", "shell", "Run npm test");
    await app.waitFor("permission");

    app.send({ type: "approve", sessionId, payload: { permissionId: "perm_1" } });
    await waitMs(200);

    expect(adapter.lastPermissionResponse).toEqual({
      sessionId, permissionId: "perm_1", decision: "approve",
    });
    app.close();
  });

  it("3. should route question to app and answer back", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateQuestion(sessionId, "q_1", "Which DB?", ["Postgres", "SQLite"]);
    const q = await app.waitFor("question");
    expect(q.payload.choices).toEqual(["Postgres", "SQLite"]);

    app.send({ type: "answer", sessionId, payload: { questionId: "q_1", answer: "SQLite" } });
    await waitMs(200);

    expect(adapter.lastQuestionResponse).toEqual({ sessionId, questionId: "q_1", answer: "SQLite" });
    app.close();
  });

  it("4. should route app input to adapter", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    app.send({ type: "send_input", sessionId, payload: { text: "fix the bug" } });
    await waitMs(200);

    expect(adapter.lastMessage).toEqual({ sessionId, text: "fix the bug" });
    app.close();
  });

  it("5. should forward deltas to app", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const deltas: any[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      app.ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "agent_message_delta") {
          deltas.push(msg);
          if (deltas.length === 2) resolve();
        }
      });
    });
    adapter.simulateAgentDelta(sessionId, "hel");
    adapter.simulateAgentDelta(sessionId, "lo");
    await gotTwo;
    expect(deltas[0].payload.content + deltas[1].payload.content).toBe("hello");
    app.close();
  });

  it("6. should track key files in session context via tool events", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateToolStart(sessionId, "read_file", { path: "src/auth.ts" });
    await app.waitFor("tool_start");
    await waitMs(100);

    const ctx = sm.getContext(sessionId);
    expect(ctx?.keyFiles).toContain("src/auth.ts");
    app.close();
  });

  it("7. should persist session to disk", async () => {
    const { sessionId } = await adapter.createSession();
    await waitMs(200);

    const meta = sm.getMeta(sessionId);
    expect(meta).toBeTruthy();
  });

  it("8. should reconnect after disconnect", async () => {
    expect(relay.getState()).toBe("connected");
    (relay as any).ws?.close();
    await waitMs(100);
    expect(relay.getState()).toBe("disconnected");

    await new Promise<void>((resolve) => {
      relay.onStateChange = (s) => { if (s === "connected") resolve(); };
    });
    expect(relay.getState()).toBe("connected");
  }, 10_000);

  it("9. should resume sessions after reconnect", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    sm.updateContext(sessionId, { summary: "Was doing work" });
    sm.markDisconnected(sessionId);

    (relay as any).ws?.close();

    // Wait for reconnect + resume (session_created fires again)
    const resumed = await app.waitFor("session_created", 10_000);
    expect(resumed.sessionId).toBe(sessionId);

    const meta = sm.getMeta(sessionId);
    app.close();
  }, 15_000);

  it("10. should handle multiple concurrent sessions", async () => {
    const app = await connectApp(env.port);
    const s1 = await adapter.createSession();
    const s2 = await adapter.createSession();
    await app.waitFor("session_created");
    await app.waitFor("session_created");

    const msgs: any[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      app.ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "agent_message") {
          msgs.push(msg);
          if (msgs.length === 2) resolve();
        }
      });
    });
    adapter.simulateAgentMessage(s1.sessionId, "from s1");
    adapter.simulateAgentMessage(s2.sessionId, "from s2");
    await gotTwo;
    const contents = msgs.map((m: any) => m.payload.content).sort();
    expect(contents).toEqual(["from s1", "from s2"]);
    app.close();
  });

  it("11. should forward error events", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulateError(sessionId, "something broke");
    const err = await app.waitFor("error");
    expect(err.payload.message).toBe("something broke");
    app.close();
  });

  it("12. app deny routed to adapter", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    adapter.simulatePermissionRequest(sessionId, "perm_2", "write_file", "Write to app.js");
    await app.waitFor("permission");

    app.send({ type: "deny", sessionId, payload: { permissionId: "perm_2" } });
    await waitMs(200);

    expect(adapter.lastPermissionResponse?.decision).toBe("deny");
    app.close();
  });


  // ── 13. Pairing token flow ────────────────────────

  it("13. should create pairing token and pair a new device", async () => {
    // Tentacle requests a pairing token
    const tokenMsg = await new Promise<any>((resolve) => {
      (relay as any).ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as any).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });
    expect(tokenMsg.token).toMatch(/^pt_/);
    expect(tokenMsg.expiresIn).toBeGreaterThan(0);

    // New app pairs using the token (no OAuth)
    const pairWs = new (await import("ws")).WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => pairWs.on("open", r));
    pairWs.send(JSON.stringify({
      type: "auth",
      pairingToken: tokenMsg.token,
      device: { name: "Paired Phone", role: "app", kind: "ios" },
    }));
    const authOk = await new Promise<any>((resolve) => {
      pairWs.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "auth_ok") resolve(msg);
      });
    });
    expect(authOk.type).toBe("auth_ok");
    expect(authOk.channel).toBeTruthy();
    pairWs.close();
  });

  it("14. should reject expired/reused pairing token", async () => {
    // Get a token
    const tokenMsg = await new Promise<any>((resolve) => {
      (relay as any).ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as any).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    // Use it once (success)
    const ws1 = new (await import("ws")).WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth", pairingToken: tokenMsg.token,
      device: { name: "First", role: "app" },
    }));
    const ok = await new Promise<any>(r => ws1.on("message", (d: any) => r(JSON.parse(d.toString()))));
    expect(ok.type).toBe("auth_ok");
    ws1.close();

    // Try to reuse (should fail)
    const ws2 = new (await import("ws")).WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws2.on("open", r));
    ws2.send(JSON.stringify({
      type: "auth", pairingToken: tokenMsg.token,
      device: { name: "Second", role: "app" },
    }));
    const err = await new Promise<any>(r => ws2.on("message", (d: any) => r(JSON.parse(d.toString()))));
    expect(err.type).toBe("auth_error");
    expect(err.message).toContain("Invalid or expired");
    ws2.close();
  });



  // ── 15. E2E encrypted message flow ────────────────

  it("15. encrypted message survives relay without head reading it", async () => {
    // Generate keys for the app (consumer)
    const appKp = generateKeyPair();
    const appDeviceId = "dev_encrypted_phone";

    // Connect app with public key
    const appWs = new (await import("ws")).WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => appWs.on("open", r));
    appWs.send(JSON.stringify({
      type: "auth",
      device: { name: "Encrypted Phone", role: "app", kind: "ios", publicKey: exportPublicKey(appKp.publicKey), deviceId: appDeviceId },
    }));
    const appAuth = await new Promise<any>(r => {
      appWs.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") r(m);
      });
    });
    expect(appAuth.type).toBe("auth_ok");

    // Create a session from the mock adapter
    const { sessionId } = await adapter.createSession();
    await waitMs(100);

    // Simulate tentacle encrypting a message for the app
    const plaintext = JSON.stringify({ type: "agent_message", payload: { content: "secret code" } });
    const recipients = [{ deviceId: appDeviceId, publicKey: appKp.publicKey }];
    const encrypted = encrypt(plaintext, recipients);

    // Send encrypted message through relay
    (relay as any).ws.send(JSON.stringify({
      type: "encrypted",
      sessionId,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      tag: encrypted.tag,
      keys: encrypted.keys,
    }));

    // App receives the encrypted blob
    const received = await new Promise<any>((resolve) => {
      appWs.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "encrypted") resolve(m);
      });
    });

    // Verify the relay forwarded the encrypted payload intact
    expect(received.ciphertext).toBe(encrypted.ciphertext);
    expect(received.iv).toBe(encrypted.iv);

    // App can decrypt
    const decrypted = decrypt(
      { iv: received.iv, ciphertext: received.ciphertext, tag: received.tag, keys: received.keys },
      appDeviceId,
      appKp.privateKey
    );
    const parsed = JSON.parse(decrypted);
    expect(parsed.payload.content).toBe("secret code");

    // Verify head stored an opaque blob (check storage directly)
    const stored = env.storage.getMessagesAfterSeq(appAuth.channel, 0);
    const encMsg = stored.find(m => m.type === "encrypted");
    if (encMsg) {
      // Head stored the message but the payload is encrypted — it cannot extract "secret code"
      expect(encMsg.payload).not.toContain("secret code");
    }

    appWs.close();
  });



  // ── 16. Full E2E: tentacle encrypts via RelayClient → head → app decrypts ──

  it("16. RelayClient auto-encrypts when E2E enabled and app has keys", async () => {
    // Create a NEW env with e2e: true
    relay.disconnect();
    await env.cleanup();
    sessDir.cleanup();

    const e2eEnv = await createTestEnv({ e2e: true });
    const e2eSessDir = createTmpSessionDir();
    const e2eSm = new SessionManager(e2eSessDir.dir);
    const e2eKm = new KeyManager(createTmpSessionDir().dir);
    const e2eAdapter = new MockAdapter();

    const e2eRelay = new RelayClient(
      e2eAdapter as unknown as AgentAdapter,
      e2eSm,
      { relayUrl: `ws://127.0.0.1:${e2eEnv.port}`, device: { name: "E2E Laptop", role: "tentacle" } },
      e2eKm,
    );

    await new Promise<void>((resolve, reject) => {
      e2eRelay.onAuthenticated = () => resolve();
      e2eRelay.onFatalError = (msg) => reject(new Error(msg));
      e2eRelay.connect();
    });

    // Connect app with its own keypair
    const appKm = new KeyManager(createTmpSessionDir().dir);
    const appDeviceId = "dev_e2e_app";
    const appPubKey = appKm.getCompactPublicKey();

    const appWs = new (await import("ws")).WebSocket(`ws://127.0.0.1:${e2eEnv.port}`);
    await new Promise<void>(r => appWs.on("open", r));
    appWs.send(JSON.stringify({
      type: "auth",
      device: { name: "E2E Phone", role: "app", publicKey: appPubKey, deviceId: appDeviceId },
    }));
    const appAuth = await new Promise<any>(r => {
      appWs.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") r(m);
      });
    });

    // Wait for head_notice to propagate consumer key to relay
    await waitMs(200);

    // Create session and send a message (should be auto-encrypted by RelayClient)
    const { sessionId } = await e2eAdapter.createSession();
    await waitMs(100);
    e2eAdapter.simulateAgentMessage(sessionId, "top secret code");

    // App should receive an encrypted message
    const received = await new Promise<any>((resolve) => {
      appWs.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "encrypted") resolve(m);
      });
    });

    expect(received.type).toBe("encrypted");
    expect(received.ciphertext).toBeTruthy();
    // The raw message should NOT contain the plaintext
    expect(JSON.stringify(received)).not.toContain("top secret code");

    // App decrypts
    const decrypted = appKm.decryptForMe(
      { iv: received.iv, ciphertext: received.ciphertext, tag: received.tag, keys: received.keys },
      appDeviceId,
    );
    const inner = JSON.parse(decrypted);
    expect(inner.payload.content).toBe("top secret code");

    // Verify head stored opaque blob
    const stored = e2eEnv.storage.getMessagesAfterSeq(appAuth.channel, 0);
    for (const msg of stored) {
      expect(msg.payload).not.toContain("top secret code");
    }

    appWs.close();
    e2eRelay.disconnect();
    await e2eEnv.cleanup();
    e2eSessDir.cleanup();
  }, 15_000);



  // ── 17. Two tentacles → one head → one app ───────

  it("17. two tentacles route to same app via same head", async () => {
    // Second tentacle with its own adapter + session manager
    const sessDir2 = createTmpSessionDir();
    const sm2 = new SessionManager(sessDir2.dir);
    const adapter2 = new MockAdapter();
    const relay2 = new RelayClient(
      adapter2 as unknown as AgentAdapter,
      sm2,
      { relayUrl: `ws://127.0.0.1:${env.port}`, device: { name: "Work PC", role: "tentacle" } },
    );
    await new Promise<void>((resolve, reject) => {
      relay2.onAuthenticated = () => resolve();
      relay2.onFatalError = (msg) => reject(new Error(msg));
      relay2.connect();
    });

    const app = await connectApp(env.port);

    const s1 = await adapter.createSession();
    const s2 = await adapter2.createSession();
    await app.waitFor("session_created");
    await app.waitFor("session_created");

    adapter.simulateAgentMessage(s1.sessionId, "from laptop");
    adapter2.simulateAgentMessage(s2.sessionId, "from workpc");

    const msgs: any[] = [];
    const gotTwo = new Promise<void>((resolve) => {
      app.ws.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "agent_message") {
          msgs.push(m);
          if (msgs.length === 2) resolve();
        }
      });
    });
    await gotTwo;

    const contents = msgs.map((m: any) => m.payload.content).sort();
    expect(contents).toEqual(["from laptop", "from workpc"]);

    relay2.disconnect();
    sessDir2.cleanup();
    app.close();
  });

  // ── 18. Two apps both receive same message ────────

  it("18. two apps both receive same message from tentacle", async () => {
    const app1 = await connectApp(env.port, "App 1");
    const app2 = await connectApp(env.port, "App 2");

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

  // ── 19. Large message through relay ───────────────

  it("19. large message (100KB) passes through relay", async () => {
    const app = await connectApp(env.port);
    const { sessionId } = await adapter.createSession();
    await app.waitFor("session_created");

    const bigContent = "x".repeat(100_000);
    adapter.simulateAgentMessage(sessionId, bigContent);
    const msg = await app.waitFor("agent_message");
    expect(msg.payload.content.length).toBe(100_000);

    app.close();
  });



  // ── 20. Challenge-response auth: pair then reconnect ──

  it("20. pair via token, disconnect, reconnect via challenge-response", async () => {
    const { generateKeyPair, exportPublicKey, signChallenge } = await import("@kraki/crypto");
    const WebSocket = (await import("ws")).WebSocket;

    // Generate keypair (simulates what browser IndexedDB stores)
    const kp = generateKeyPair();
    const compactPubKey = exportPublicKey(kp.publicKey);
    const deviceId = "dev_challenge_test";

    // Step 1: Pair via pairing token
    // First get a pairing token from a tentacle
    const tokenMsg = await new Promise<any>((resolve) => {
      (relay as any).ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as any).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    // Pair: connect with pairing token + public key + deviceId
    const ws1 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth",
      pairingToken: tokenMsg.token,
      device: { name: "Challenge Phone", role: "app", kind: "web", publicKey: compactPubKey, deviceId },
    }));
    const authOk1 = await new Promise<any>(r => {
      ws1.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") r(m);
      });
    });
    expect(authOk1.type).toBe("auth_ok");
    expect(authOk1.deviceId).toBe(deviceId);

    // Verify device is registered with public key
    const device = env.storage.getDevice(deviceId);
    expect(device).toBeTruthy();

    // Step 2: Disconnect
    ws1.close();
    await waitMs(200);

    // Step 3: Reconnect with challenge-response (no token, just deviceId)
    const ws2 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws2.on("open", r));

    // Send auth with just deviceId (like a return visit)
    ws2.send(JSON.stringify({
      type: "auth",
      device: { name: "Challenge Phone", role: "app", kind: "web", deviceId },
    }));

    // Head should send a challenge
    const challenge = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No challenge received")), 5000);
      ws2.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_challenge") { clearTimeout(timeout); resolve(m); }
        if (m.type === "auth_error") { clearTimeout(timeout); reject(new Error(m.message)); }
        if (m.type === "auth_ok") { clearTimeout(timeout); reject(new Error("Got auth_ok without challenge")); }
      });
    });
    expect(challenge.type).toBe("auth_challenge");
    expect(challenge.nonce).toBeTruthy();

    // Sign the nonce with our private key
    const signature = signChallenge(challenge.nonce, kp.privateKey);

    // Send the signed response
    ws2.send(JSON.stringify({
      type: "auth_response",
      deviceId,
      signature,
    }));

    // Should get auth_ok
    const authOk2 = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No auth_ok after challenge")), 5000);
      ws2.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_ok") { clearTimeout(timeout); resolve(m); }
        if (m.type === "auth_error") { clearTimeout(timeout); reject(new Error(m.message)); }
      });
    });
    expect(authOk2.type).toBe("auth_ok");
    expect(authOk2.deviceId).toBe(deviceId);

    // Step 4: Verify we can receive messages after challenge auth
    const { sessionId } = await adapter.createSession();
    await waitMs(100);
    adapter.simulateAgentMessage(sessionId, "post-challenge message");

    const msg = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("No message after challenge auth")), 5000);
      ws2.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "agent_message") { clearTimeout(timeout); resolve(m); }
      });
    });
    expect(msg.payload.content).toBe("post-challenge message");

    ws2.close();
  }, 15_000);

  // ── 21. Challenge-response: wrong signature rejected ──

  it("21. challenge-response rejects wrong signature", async () => {
    const { generateKeyPair, exportPublicKey, signChallenge } = await import("@kraki/crypto");
    const WebSocket = (await import("ws")).WebSocket;

    const kp = generateKeyPair();
    const kpWrong = generateKeyPair();
    const deviceId = "dev_wrong_sig";

    // Register device via pairing
    const tokenMsg = await new Promise<any>((resolve) => {
      (relay as any).ws.on("message", (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pairing_token_created") resolve(msg);
      });
      (relay as any).ws.send(JSON.stringify({ type: "create_pairing_token" }));
    });

    const ws1 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws1.on("open", r));
    ws1.send(JSON.stringify({
      type: "auth",
      pairingToken: tokenMsg.token,
      device: { name: "WrongSig", role: "app", publicKey: exportPublicKey(kp.publicKey), deviceId },
    }));
    await new Promise<any>(r => ws1.on("message", (d: any) => {
      const m = JSON.parse(d.toString());
      if (m.type === "auth_ok") r(m);
    }));
    ws1.close();
    await waitMs(200);

    // Reconnect and sign with WRONG key
    const ws2 = new WebSocket(`ws://127.0.0.1:${env.port}`);
    await new Promise<void>(r => ws2.on("open", r));
    ws2.send(JSON.stringify({
      type: "auth",
      device: { name: "WrongSig", role: "app", deviceId },
    }));

    const challenge = await new Promise<any>(r => {
      ws2.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_challenge") r(m);
      });
    });

    // Sign with the WRONG private key
    const badSig = signChallenge(challenge.nonce, kpWrong.privateKey);
    ws2.send(JSON.stringify({ type: "auth_response", deviceId, signature: badSig }));

    const error = await new Promise<any>(r => {
      ws2.on("message", (d: any) => {
        const m = JSON.parse(d.toString());
        if (m.type === "auth_error") r(m);
      });
    });
    expect(error.type).toBe("auth_error");
    expect(error.message).toContain("Invalid signature");

    ws2.close();
  }, 30_000);

  // ── Remote session control tests ──────────────────────

  it("22. create_session from app creates session on tentacle", async () => {
    const app = await connectApp(env.port);

    // Get device list to find the tentacle deviceId
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");
    expect(tentacle).toBeTruthy();

    // App sends create_session
    app.send({
      type: "create_session",
      payload: { requestId: "req_test", targetDeviceId: tentacle.id, model: "mock-model" },
    });

    // Tentacle adapter should create the session
    const created = await app.waitFor("session_created");
    expect(created.type).toBe("session_created");
    expect(created.payload.agent).toBe("mock");

    // Adapter should have the session
    expect(adapter.sessions.size).toBe(1);

    app.close();
  });

  it("23. create_session with prompt sends initial message after creation", async () => {
    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    app.send({
      type: "create_session",
      payload: {
        requestId: "req_prompt",
        targetDeviceId: tentacle.id,
        model: "mock-model",
        prompt: "Fix the login bug",
      },
    });

    await app.waitFor("session_created");
    // Give relay-client time to call sendMessage after createSession
    await waitMs(100);

    expect(adapter.lastMessage).toBeTruthy();
    expect(adapter.lastMessage.text).toBe("Fix the login bug");

    app.close();
  });

  it("24. create_session with cwd passes it to adapter", async () => {
    // Enhance mock adapter to capture createSession config
    let capturedConfig: any = null;
    const origCreate = adapter.createSession.bind(adapter);
    adapter.createSession = async (config?: CreateSessionConfig) => {
      capturedConfig = config;
      return origCreate(config);
    };

    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    app.send({
      type: "create_session",
      payload: {
        requestId: "req_cwd",
        targetDeviceId: tentacle.id,
        model: "test-model",
        cwd: "/home/user/project",
      },
    });

    await app.waitFor("session_created");

    expect(capturedConfig).toBeTruthy();
    expect(capturedConfig.model).toBe("test-model");
    expect(capturedConfig.cwd).toBe("/home/user/project");

    app.close();
  });

  it("25. create_session broadcasts session_created to all apps", async () => {
    const app1 = await connectApp(env.port, "Phone");
    const app2 = await connectApp(env.port, "Tablet");
    const authOk = app1.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    app1.send({
      type: "create_session",
      payload: { requestId: "req_test", targetDeviceId: tentacle.id, model: "mock-model" },
    });

    // Both apps should receive session_created
    const created1 = await app1.waitFor("session_created");
    const created2 = await app2.waitFor("session_created");
    expect(created1.sessionId).toBe(created2.sessionId);

    app1.close();
    app2.close();
  });

  it("26. create_session to wrong deviceId does not create session", async () => {
    const app = await connectApp(env.port);
    const sessionsBefore = adapter.sessions.size;

    app.send({
      type: "create_session",
      payload: { requestId: "req_offline", targetDeviceId: "dev_nonexistent", model: "mock-model" },
    });

    // Wait a bit to make sure nothing happens
    await waitMs(200);
    expect(adapter.sessions.size).toBe(sessionsBefore);

    app.close();
  });

  it("27. app can send input to remotely created session", async () => {
    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    // Create session remotely
    app.send({
      type: "create_session",
      payload: { requestId: "req_test", targetDeviceId: tentacle.id, model: "mock-model" },
    });
    const created = await app.waitFor("session_created");

    // Now send input to that session
    app.send({
      type: "send_input",
      sessionId: created.sessionId,
      payload: { text: "Hello from the web app!" },
    });
    await waitMs(100);

    expect(adapter.lastMessage).toBeTruthy();
    expect(adapter.lastMessage.sessionId).toBe(created.sessionId);
    expect(adapter.lastMessage.text).toBe("Hello from the web app!");

    app.close();
  });

  it("28. app can kill remotely created session", async () => {
    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    app.send({
      type: "create_session",
      payload: { requestId: "req_test", targetDeviceId: tentacle.id, model: "mock-model" },
    });
    const created = await app.waitFor("session_created");

    // Kill it
    app.send({
      type: "kill_session",
      sessionId: created.sessionId,
      payload: {},
    });

    const ended = await app.waitFor("session_ended");
    expect(ended.sessionId).toBe(created.sessionId);
    expect(ended.payload.reason).toBe("stopped");

    app.close();
  });

  it("29. multiple create_session requests create separate sessions", async () => {
    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    // Track all createSession calls
    const createCalls: any[] = [];
    const origCreate = adapter.createSession.bind(adapter);
    adapter.createSession = async (config?: CreateSessionConfig) => {
      createCalls.push(config);
      return origCreate(config);
    };

    // First session
    app.send({
      type: "create_session",
      payload: { requestId: "req_a", targetDeviceId: tentacle.id, model: "model-a" },
    });
    const s1 = await app.waitFor("session_created");
    await waitMs(50);

    // Second session
    app.send({
      type: "create_session",
      payload: { requestId: "req_b", targetDeviceId: tentacle.id, model: "model-b" },
    });
    const s2 = await app.waitFor("session_created");
    await waitMs(50);

    expect(createCalls).toHaveLength(2);
    expect(adapter.sessions.size).toBe(2);

    app.close();
  });

  // ── Encrypted storage + replay tests ──────────────────

  it("30. encrypted messages are stored and replayed — decrypt round-trip verified", async () => {
    // Create E2E env with real crypto
    const e2eEnv = await createTestEnv({ e2e: true });
    const e2eAdapter = new MockAdapter();
    const e2eSessDir = createTmpSessionDir();
    const e2eSm = new SessionManager(e2eSessDir.dir);

    // Create relay with a real KeyManager for encryption
    const e2eKm = new KeyManager(e2eSessDir.dir);
    const e2eRelay = new RelayClient(
      e2eAdapter as unknown as AgentAdapter,
      e2eSm,
      { relayUrl: `ws://127.0.0.1:${e2eEnv.port}`, device: { name: "E2E Laptop", role: "tentacle" } },
      e2eKm,
    );

    await new Promise<void>((resolve, reject) => {
      e2eRelay.onAuthenticated = () => resolve();
      e2eRelay.onFatalError = (msg) => reject(new Error(msg));
      e2eRelay.connect();
    });

    // Generate app keypair and connect with explicit deviceId + publicKey
    const appKP = generateKeyPair();
    const appPubKey = exportPublicKey(appKP.publicKey);
    const appDeviceId = "dev_e2e_replay_app";
    const app = await connectAppWithKeys(e2eEnv.port, {
      name: "E2E Replay App",
      deviceId: appDeviceId,
      publicKey: appPubKey,
    });

    // Wait for tentacle to learn about the app's key
    await waitMs(500);

    // Create session and trigger an encrypted message
    const { sessionId } = await e2eAdapter.createSession();
    await waitMs(200);

    const testContent = "Hello encrypted replay test!";
    e2eAdapter.simulateAgentMessage(sessionId, testContent);
    await waitMs(500);

    // Verify first delivery is encrypted and decryptable
    // Find the encrypted agent_message (not session_created)
    const encryptedMsgs = app.messages.filter((m: any) => m.type === "encrypted" && m.sessionId === sessionId);
    // The last encrypted message should be the agent_message
    const liveMsg = encryptedMsgs[encryptedMsgs.length - 1];
    expect(liveMsg).toBeTruthy();
    expect(liveMsg.keys[appDeviceId]).toBeTruthy();

    // Decrypt live message
    const liveDecrypted = decrypt(
      { iv: liveMsg.iv, ciphertext: liveMsg.ciphertext, tag: liveMsg.tag, keys: liveMsg.keys },
      appDeviceId,
      appKP.privateKey,
    );
    const liveInner = JSON.parse(liveDecrypted);
    expect(liveInner.payload.content).toBe(testContent);

    // Disconnect app
    const lastSeq = Math.max(...app.messages.filter((m: any) => m.seq).map((m: any) => m.seq));
    app.close();
    await waitMs(300);

    // Reconnect SAME device with crypto (handles challenge-response)
    const app2 = await connectAppWithCrypto(e2eEnv.port, {
      name: "E2E Replay App",
      deviceId: appDeviceId,
      publicKey: appPubKey,
      privateKey: appKP.privateKey,
    });
    app2.send({ type: "replay", afterSeq: 0 });
    await waitMs(1000);

    // Find replayed encrypted messages
    const replayedEncrypted = app2.messages.filter((m: any) =>
      m.type === "encrypted" && m.sessionId === sessionId && !m._consumed,
    );
    expect(replayedEncrypted.length).toBeGreaterThan(0);

    // Decrypt replayed message
    const replayMsg = replayedEncrypted[replayedEncrypted.length - 1];
    expect(replayMsg.keys[appDeviceId]).toBeTruthy();
    const replayDecrypted = decrypt(
      { iv: replayMsg.iv, ciphertext: replayMsg.ciphertext, tag: replayMsg.tag, keys: replayMsg.keys },
      appDeviceId,
      appKP.privateKey,
    );
    const replayInner = JSON.parse(replayDecrypted);
    expect(replayInner.payload.content).toBe(testContent);

    // Verify NO plaintext agent_message was replayed in E2E mode
    const plaintextReplayed = app2.messages.filter((m: any) =>
      m.type === "agent_message" && m.sessionId === sessionId && !m._consumed,
    );
    expect(plaintextReplayed.length).toBe(0);

    app2.close();
    e2eRelay.disconnect();
    await e2eEnv.cleanup();
    e2eSessDir.cleanup();
  }, 30_000);

  it("31. server_error sent when create_session targets offline device", async () => {
    const app = await connectApp(env.port);

    app.send({
      type: "create_session",
      payload: { requestId: "req_offline_test", targetDeviceId: "dev_nonexistent_xyz", model: "mock" },
    });

    // Should receive server_error with requestId
    const err = await app.waitFor("server_error");
    expect(err.type).toBe("server_error");
    expect(err.requestId).toBe("req_offline_test");
    expect(err.message).toContain("not online");

    app.close();
  });

  it("32. session_created carries requestId from create_session", async () => {
    const app = await connectApp(env.port);
    const authOk = app.messages.find((m: any) => m.type === "auth_ok");
    const tentacle = authOk.devices.find((d: any) => d.role === "tentacle");

    app.send({
      type: "create_session",
      payload: { requestId: "req_track_123", targetDeviceId: tentacle.id, model: "mock-model" },
    });

    const created = await app.waitFor("session_created");
    expect(created.payload.requestId).toBe("req_track_123");

    app.close();
  });

});
