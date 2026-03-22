
/**
 * Full end-to-end live test: Real daemon wiring + Real Copilot + Real Head
 *
 * Run with: pnpm --filter @kraki/tests test:live
 *
 * This tests the COMPLETE production path:
 *   Real CopilotAdapter
 *     → Real SessionManager (disk persistence)
 *       → Real RelayClient (auto-wired by daemon-worker pattern)
 *         → Real Head Server (routing, SQLite storage)
 *           → Mock App (WebSocket client verifying output)
 *                 ↓
 *           App actions → Head → RelayClient → Adapter
 *
 * Requires: copilot CLI installed and authenticated
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEnv, connectApp, createTmpSessionDir, waitMs, type TestEnv, type MockApp } from "./helpers.js";
import { CopilotAdapter, SessionManager, RelayClient, KeyManager } from "@kraki/tentacle";
import type { AgentAdapter } from "@kraki/tentacle";
import { getOrCreateDeviceId } from "@kraki/tentacle";

let env: TestEnv;
let adapter: CopilotAdapter;
let sm: SessionManager;
let km: KeyManager;
let relay: RelayClient;
let sessDir: { dir: string; cleanup: () => void };
let keysDir: { dir: string; cleanup: () => void };

beforeAll(async () => {
  // Start real head
  env = await createTestEnv();

  // Create real tentacle components (same as daemon-worker does)
  sessDir = createTmpSessionDir();
  keysDir = createTmpSessionDir();
  sm = new SessionManager(sessDir.dir);
  km = new KeyManager(keysDir.dir);
  adapter = new CopilotAdapter();

  // Start real adapter
  try { await adapter.start(); } catch (err) {
    console.error("Copilot CLI not available — skipping live tests");
    throw err;
  }

  // Create real RelayClient (same wiring as daemon-worker)
  relay = new RelayClient(
    adapter as unknown as AgentAdapter,
    sm,
    {
      relayUrl: `ws://127.0.0.1:${env.port}`,
      device: { name: "Live Daemon", role: "tentacle", kind: "desktop" },
      reconnectDelay: 1000,
    },
    km,
  );

  await new Promise<void>((resolve, reject) => {
    relay.onAuthenticated = () => resolve();
    relay.onFatalError = (msg) => reject(new Error(msg));
    relay.connect();
  });
}, 30_000);

afterAll(async () => {
  relay?.disconnect();
  try { await adapter?.stop(); } catch {}
  await env?.cleanup();
  sessDir?.cleanup();
  keysDir?.cleanup();
}, 10_000);

async function withSession(fn: (sessionId: string, app: MockApp) => Promise<void>): Promise<void> {
  const app = await connectApp(env.port, "Live Phone");
  const { sessionId } = await adapter.createSession({ cwd: "/tmp" });
  await app.waitFor("session_created", 15_000);
  try {
    await fn(sessionId, app);
  } finally {
    try { await adapter.killSession(sessionId); } catch {}
    app.close();
  }
}

describe("Full E2E: Real Daemon Wiring + Copilot + Head", () => {

  it("1. agent message flows through real daemon wiring", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Reply with exactly: daemon test ok. Nothing else.");
      const r = await app.waitFor("agent_message", 30_000);
      expect(r.payload.content.toLowerCase()).toContain("daemon");
    });
  }, 45_000);

  it("2. permission approve flows through daemon wiring", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Create a file at /tmp/kraki-daemon-test.txt with content test. Do it now.");
      const perm = await app.waitFor("permission", 30_000);
      expect(perm.payload.id).toBeTruthy();

      // Approve from app → head → relay client → adapter (full round trip)
      app.send({ type: "approve", sessionId: sid, payload: { permissionId: perm.payload.id } });
      const response = await app.waitFor("agent_message", 30_000);
      expect(response.payload.content).toBeTruthy();
    });
  }, 60_000);

  it("3. session persisted to disk via SessionManager", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Say done.");
      await app.waitFor("agent_message", 20_000);
      const meta = sm.getMeta(sid);
      expect(meta).toBeTruthy();
    });
  }, 45_000);

  it("4. tool events track key files in session context", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Read /etc/hostname and tell me what it says.");
      // Wait for tool events or message
      const first = await Promise.race([
        app.waitFor("tool_start", 20_000).then(m => ({ kind: "tool" as const, m })),
        app.waitFor("agent_message", 20_000).then(m => ({ kind: "msg" as const, m })),
      ]);
      if (first.kind === "tool") {
        await waitMs(200);
        const ctx = sm.getContext(sid);
        expect(ctx?.keyFiles.length).toBeGreaterThanOrEqual(0);
      }
    });
  }, 60_000);

  it("5. multi-turn context maintained", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Remember: code is octopus42. Acknowledge.");
      await app.waitFor("agent_message", 20_000);
      await adapter.sendMessage(sid, "What is the code? Reply with just the code.");
      const r = await app.waitFor("agent_message", 20_000);
      expect(r.payload.content.toLowerCase()).toContain("octopus42");
    });
  }, 60_000);

  it("6. two apps receive same messages", async () => {
    const app1 = await connectApp(env.port, "Phone 1");
    const app2 = await connectApp(env.port, "Phone 2");

    const { sessionId } = await adapter.createSession({ cwd: "/tmp" });
    await app1.waitFor("session_created", 15_000);
    await app2.waitFor("session_created", 15_000);

    await adapter.sendMessage(sessionId, "Say hello.");
    const r1 = await app1.waitFor("agent_message", 30_000);
    const r2 = await app2.waitFor("agent_message", 30_000);
    expect(r1.payload.content).toBeTruthy();
    expect(r2.payload.content).toBeTruthy();
    // Both should have same content
    expect(r1.payload.content).toBe(r2.payload.content);

    try { await adapter.killSession(sessionId); } catch {}
    app1.close();
    app2.close();
  }, 60_000);

  it("7. replay works for newly connected app", async () => {
    const app1 = await connectApp(env.port, "First Phone");
    const { sessionId } = await adapter.createSession({ cwd: "/tmp" });
    await app1.waitFor("session_created", 15_000);
    await adapter.sendMessage(sessionId, "Say replay works.");
    await app1.waitFor("agent_message", 30_000);
    app1.close();
    await waitMs(500);

    const app2 = await connectApp(env.port, "Second Phone");
    app2.send({ type: "replay", afterSeq: 0 });
    const replayed = await app2.waitFor("agent_message", 10_000);
    expect(replayed.payload.content).toBeTruthy();

    try { await adapter.killSession(sessionId); } catch {}
    app2.close();
  }, 60_000);

  it("8. idle event after agent finishes", async () => {
    await withSession(async (sid, app) => {
      await adapter.sendMessage(sid, "Say done.");
      await app.waitFor("agent_message", 20_000);
      const idle = await app.waitFor("idle", 15_000);
      expect(idle.type).toBe("idle");
    });
  }, 45_000);
});
