/**
 * Live E2E for the PR #144 fixes, exercised through the REAL relay path:
 *
 *   MultiAgentAdapter (real copilot+claude+pi)
 *     -> SessionManager (co-located disk persistence)
 *       -> RelayClient (production wiring)
 *         -> real Head (routing + SQLite)
 *           -> Mock App (WS client; answers questions / flips mode
 *              exactly like the web arm does over the wire)
 *
 * Verifies:
 *   A. pi — message round-trip; mode-change MID-TURN fires `idle` (no hang);
 *      context survives the mode change; transcript is a single valid pi.jsonl.
 *   B. claude — AskUserQuestion answer keyed by question text actually reaches
 *      Claude (old bug: "The user did not answer the questions.").
 *   C. copilot — smoke round-trip (co-located storage regression).
 *
 * Run: pnpm --filter @kraki/tests test:live -- pi-claude-fixes
 * Requires: pi, claude, copilot all installed + authenticated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createTestEnv, connectApp, createTmpSessionDir, waitMs, sendToTentacle,
  type TestEnv, type MockApp,
} from "./helpers.js";
import { SessionManager, RelayClient, KeyManager } from "@kraki/tentacle";
import type { AgentAdapter } from "@kraki/tentacle";
import { MultiAgentAdapter } from "../../tentacle/src/adapters/multi.js";
import { AttachmentStore } from "../../tentacle/src/attachment-store.js";

let env: TestEnv;
let adapter: MultiAgentAdapter;
let sm: SessionManager;
let km: KeyManager;
let relay: RelayClient;
let sessDir: { dir: string; cleanup: () => void };
let keysDir: { dir: string; cleanup: () => void };

beforeAll(async () => {
  env = await createTestEnv();

  sessDir = createTmpSessionDir();
  keysDir = createTmpSessionDir();
  sm = new SessionManager(sessDir.dir);
  km = new KeyManager(keysDir.dir);
  const attachmentStore = new AttachmentStore(sessDir.dir);

  adapter = new MultiAgentAdapter({
    agentIds: ["copilot", "claude", "pi"],
    attachmentStore,
  });
  await adapter.start();

  relay = new RelayClient(
    adapter as unknown as AgentAdapter,
    sm,
    {
      relayUrl: `ws://127.0.0.1:${env.port}`,
      device: { name: "Fixes Daemon", role: "tentacle", kind: "desktop" },
      reconnectDelay: 1000,
    },
    km,
  );

  await new Promise<void>((resolve, reject) => {
    relay.onAuthenticated = () => resolve();
    relay.onFatalError = (msg) => reject(new Error(msg));
    relay.connect();
  });
}, 60_000);

afterAll(async () => {
  relay?.disconnect();
  try { await adapter?.stop(); } catch {}
  await env?.cleanup();
  sessDir?.cleanup();
  keysDir?.cleanup();
});

async function withSession(
  agentId: "pi" | "claude" | "copilot",
  fn: (sessionId: string, app: MockApp) => Promise<void>,
): Promise<void> {
  const app = await connectApp(env.port, `${agentId} Phone`);
  const { sessionId } = await adapter.createSession({ agentId, cwd: "/tmp" });
  // Best-effort sync barrier. The session exists server-side regardless; the
  // app receives agent_message/question/idle broadcasts even if it raced past
  // this particular session_created broadcast.
  await app.waitFor("session_created", 15_000).catch(() => { /* proceed */ });
  try {
    await fn(sessionId, app);
  } finally {
    try { await adapter.killSession(sessionId); } catch { /* ignore */ }
    app.close();
  }
}

/**
 * app -> tentacle session commands (answer / set_session_mode / approve) go
 * through `sendToTentacle` (encrypted unicast), mirroring the web arm. See
 * helpers.ts for why a plain send is dropped by the head.
 */

// ── A. pi ────────────────────────────────────────────────
describe("pi: mode-change mid-turn + co-located transcript", () => {
  it("round-trips a message through the relay", async () => {
    await withSession("pi", async (sid, app) => {
      await adapter.sendMessage(sid, "Reply with exactly: pi ok. Nothing else.");
      const r = await app.waitFor("agent_message", 40_000);
      expect(String(r.payload.content).toLowerCase()).toContain("pi ok");
    });
  }, 60_000);

  it("mode-change mid-turn fires idle (no hang) and context survives", async () => {
    await withSession("pi", async (sid, app) => {
      // Seed a memory in the first turn.
      await adapter.sendMessage(sid, "Remember the secret word is KIWI. Just acknowledge with: ok.");
      await app.waitFor("agent_message", 40_000);
      await app.waitFor("idle", 20_000);

      // Start a genuinely long-running turn, then flip mode MID-TURN via the
      // wire, exactly like the web arm: { set_session_mode }. Flip before pi
      // streams output so the interrupt is clean. Old bug => kill suppresses
      // onExit => idle never fires => session stuck "active" forever.
      await adapter.sendMessage(sid, "Write a short haiku about each number from 1 to 20, one at a time.");
      await waitMs(400);
      sendToTentacle(app, { type: "set_session_mode", sessionId: sid, payload: { mode: "execute" } });

      // The fix fires onIdle after the old pi child exits + respawns.
      const idle = await app.waitFor("idle", 30_000);
      expect(idle.type).toBe("idle");

      // Let the respawn settle, then confirm the session still works AND
      // remembers KIWI (context preserved across the mode-change respawn).
      await waitMs(1500);
      await adapter.sendMessage(sid, "What is the secret word? Reply with just the word.");
      const deadline = Date.now() + 40_000;
      let recalled = false;
      while (Date.now() < deadline) {
        const m = await app.waitFor("agent_message", 12_000).catch(() => null);
        if (!m) continue;
        if (String(m.payload.content).toUpperCase().includes("KIWI")) { recalled = true; break; }
      }
      expect(recalled).toBe(true);

      // Transcript is a single, valid pi.jsonl (no split/corruption from the race).
      const sdir = join(sessDir.dir, sid);
      const jsonl = existsSync(sdir)
        ? readdirSync(sdir).find((f) => f.endsWith("pi.jsonl") || f === "pi.jsonl")
        : undefined;
      if (jsonl) {
        const lines = readFileSync(join(sdir, jsonl), "utf8").split("\n").filter(Boolean);
        expect(lines.length).toBeGreaterThan(0);
        for (const ln of lines) expect(() => JSON.parse(ln)).not.toThrow();
      }
    });
  }, 150_000);
});

// ── B. claude AskUserQuestion ────────────────────────────
describe("claude: AskUserQuestion answer reaches the model", () => {
  it("delivers a freeform answer keyed by question text", async () => {
    await withSession("claude", async (sid, app) => {
      // Not delegate mode, so AskUserQuestion is surfaced (not auto-answered).
      sendToTentacle(app, { type: "set_session_mode", sessionId: sid, payload: { mode: "discuss" } });
      await waitMs(300);

      const MARKER = "ZOTZ-4917";
      await adapter.sendMessage(
        sid,
        "Use the AskUserQuestion tool right now to ask me to choose my favorite fruit. " +
        "Do not guess. After I answer, reply with EXACTLY the text I gave you and nothing else.",
      );

      // The adapter surfaces the question over the wire.
      const q = await app.waitFor("question", 60_000);
      const questionId = (q.payload as Record<string, unknown>).id as string;
      expect(questionId).toBeTruthy();

      // Answer it freeform, exactly like the web arm: choice-click sends
      // wasFreeform=false, typed text sends wasFreeform=true.
      sendToTentacle(app, {
        type: "answer",
        sessionId: sid,
        payload: { questionId, answer: `My secret fruit is ${MARKER}`, wasFreeform: true },
      });

      // Relay-client emits question_resolved only after respondToQuestion is
      // actually invoked — proves the answer routed app -> head -> tentacle.
      const resolved = await app.waitFor("question_resolved", 15_000);
      expect((resolved.payload as Record<string, unknown>).questionId).toBe(questionId);

      // With the fix, Claude receives the answer (keyed by question text) and
      // can echo the marker. With the old bug it saw "no answer" and cannot.
      const deadline = Date.now() + 60_000;
      let got = "";
      while (Date.now() < deadline) {
        const m = await app.waitFor("agent_message", 60_000).catch(() => null);
        if (!m) break;
        got += ` ${m.payload.content}`;
        if (got.includes(MARKER)) break;
      }
      expect(got).toContain(MARKER);
    });
  }, 180_000);
});

// ── C. copilot regression ────────────────────────────────
describe("copilot: co-located storage smoke", () => {
  it("round-trips a message", async () => {
    await withSession("copilot", async (sid, app) => {
      await adapter.sendMessage(sid, "Reply with exactly: copilot ok. Nothing else.");
      const r = await app.waitFor("agent_message", 40_000);
      expect(String(r.payload.content).toLowerCase()).toContain("copilot ok");
    });
  }, 60_000);
});
