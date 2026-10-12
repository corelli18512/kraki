/**
 * Subscribing while the Tentacle holds an unflushed (debounced) delta must not
 * deliver that text twice — once inside the subscription snapshot's draft and
 * again as the delayed delta. Pre-existing on the Head path; the local link
 * makes resubscribes frequent (every route change).
 */
import type { AgentAdapter } from "@kraki/tentacle";
import { KeyManager, RelayClient, SessionManager } from "@kraki/tentacle";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTestEnv,
	createTmpSessionDir,
	type TestEnv,
	waitMs,
} from "./helpers.js";
import {
	connectHeadApp,
	EmitAdapter,
	type Msg,
	ofType,
	until,
} from "./local-link-helpers.js";

describe("subscribe mid-stream", () => {
	let env: TestEnv | undefined;
	let relay: RelayClient | undefined;
	const dirs: Array<{ cleanup: () => void }> = [];
	afterEach(async () => {
		relay?.disconnect();
		await env?.cleanup();
		for (const d of dirs) d.cleanup();
	});

	it("never duplicates draft text between the snapshot and the next delta", async () => {
		env = await createTestEnv();
		const sess = createTmpSessionDir();
		const kmDir = createTmpSessionDir();
		dirs.push(sess, kmDir);
		const adapter = new EmitAdapter();
		const km = new KeyManager(kmDir.dir);
		relay = new RelayClient(
			adapter as unknown as AgentAdapter,
			new SessionManager(sess.dir),
			{
				relayUrl: `ws://127.0.0.1:${env.port}`,
				device: { name: "T", role: "tentacle", kind: "desktop" },
				localLink: false,
			},
			km,
		);
		const app = await connectHeadApp(env.port);
		await new Promise<void>((resolve) => {
			relay!.onAuthenticated = () => resolve();
			relay!.connect();
		});
		const T = relay.getAuthInfo()!.deviceId;
		const pub = km.getKeyPair().publicKey;
		adapter.onSessionCreated?.({ sessionId: "s", agent: "mock", model: "m" });
		await waitMs(200);

		const sub = (sessionId: string | null) =>
			app.sendReliable(
				{
					type: "set_session_subscription",
					deviceId: app.deviceId,
					seq: 0,
					timestamp: new Date().toISOString(),
					payload: { sessionId },
				},
				T,
				pub,
			);

		let failures = 0;
		for (let round = 0; round < 20; round++) {
			// Stream while (re)subscribing at a random moment inside the 40 ms debounce.
			const start = app.received.length;
			sub(null);
			await waitMs(30);
			let expected = "";
			for (let i = 0; i < 6; i++) {
				const chunk = `r${round}c${i} `;
				expected += chunk;
				adapter.onMessageDelta?.("s", { content: chunk });
				if (i === 2) {
					await waitMs(Math.floor(Math.random() * 30));
					sub("s");
				}
				await waitMs(15);
			}
			await waitMs(150);
			const ackIn = (list: Msg[]) =>
				ofType(list, "session_subscription_set").find(
					(m) => (m.payload as Msg).sessionId === "s",
				);
			// Wait for the ACK itself, then for the stream to settle.
			await until(() => !!ackIn(app.received.slice(start)), 5000);
			await waitMs(150);
			const after = app.received.slice(start);
			const ack = ackIn(after)!;
			const ackIdx = after.indexOf(ack);
			let draft = String(
				((((ack.payload as Msg).snapshot as Msg)?.card as Msg)
					?.draft as string) ?? "",
			);
			// Apply deltas the way the App does, including `reset`.
			for (const m of ofType(after.slice(ackIdx), "agent_message_delta")) {
				const p = m.payload as Msg;
				draft = p.reset ? String(p.content) : draft + String(p.content);
			}
			const tail = "";
			const shown = draft + tail;
			const roundText = shown.slice(shown.indexOf(`r${round}c0`));
			if (roundText !== expected) {
				failures++;
				console.log(
					"MISMATCH expected",
					JSON.stringify(expected),
					"got",
					JSON.stringify(roundText),
				);
			}
			// Reset the card for the next round.
			adapter.onMessage?.("s", { content: `done ${round}` });
			await waitMs(80);
		}
		expect(failures).toBe(0);
		app.close();
	}, 60_000);
});
