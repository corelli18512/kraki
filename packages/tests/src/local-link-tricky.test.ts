/**
 * Local link — adversarial / race tests. Each test targets one way the
 * route switch could go wrong in production.
 */
import { randomBytes } from "node:crypto";
import { encryptToBlob, generateKeyPair, signChallenge } from "@kraki/crypto";
import type { AgentAdapter } from "@kraki/tentacle";
import { KeyManager, RelayClient, SessionManager } from "@kraki/tentacle";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { appProofMessage } from "../../tentacle/src/local-link.js";
import { ChaosProxy } from "./chaos/proxy.js";
import {
	createTestEnv,
	createTmpSessionDir,
	type TestEnv,
	waitMs,
} from "./helpers.js";
import {
	arrivals,
	connectHeadApp,
	connectLocal,
	EmitAdapter,
	type HeadApp,
	type Msg,
	ofType,
	readDiscovery,
	until,
} from "./local-link-helpers.js";

class LedgerAdapter extends EmitAdapter {
	inputs = new Map<string, number>();
	async sendMessage(sessionId: string, text: string) {
		this.inputs.set(text, (this.inputs.get(text) ?? 0) + 1);
		// Finish the turn so the Tentacle admits the next queued prompt.
		setTimeout(() => this.onIdle?.(sessionId), 5);
	}
	getSessionUsage() {
		return undefined;
	}
	setSessionUsage() {}
	setTurnIdentity() {}
	isTurnSettled() {
		return true;
	}
	registerSessionAgent() {}
	async generateTitle() {
		return null;
	}
}

/**
 * The Swift App's card rule, replayed over the real cross-route arrival
 * order: a route change clears subscription authority; an accepted ack seeds
 * the draft from the snapshot; deltas append only while confirmed.
 * `dropStaleHead` = while linked to T, ignore Head-delivered payloads from T.
 */
function replayCard(
	appId: string,
	T: string,
	S: string,
	dropStaleHead: boolean,
): string {
	let linked = false;
	let confirmed = false;
	let draft = "";
	for (const a of arrivals) {
		if (a.app !== appId) continue;
		const m = a.msg;
		if (m.type === "__link_up" && a.from === T) {
			linked = true;
			confirmed = false;
			continue;
		}
		if (a.from !== T) continue;
		if (dropStaleHead && linked && a.route === "head") continue;
		const p = (m.payload ?? {}) as Msg;
		if (
			m.type === "session_subscription_set" &&
			p.sessionId === S &&
			p.accepted
		) {
			confirmed = true;
			draft = String(
				(((p.snapshot as Msg)?.card as Msg)?.draft as string) ?? "",
			);
		} else if (
			m.type === "agent_message_delta" &&
			m.sessionId === S &&
			confirmed
		) {
			draft = p.reset ? String(p.content) : draft + String(p.content);
		}
	}
	return draft;
}

describe("Local link tricky cases", () => {
	let env: TestEnv;
	let adapter: LedgerAdapter;
	let relay: RelayClient;
	let km: KeyManager;
	let home: string;
	let T: string;
	let tPub: string;
	const dirs: Array<{ dir: string; cleanup: () => void }> = [];
	const sockets: Array<{ close: () => void }> = [];

	beforeEach(async () => {
		arrivals.length = 0;
		env = await createTestEnv();
		const sess = createTmpSessionDir();
		const kmDir = createTmpSessionDir();
		const homeDir = createTmpSessionDir();
		dirs.push(sess, kmDir, homeDir);
		home = homeDir.dir;
		process.env.KRAKI_HOME = home;
		adapter = new LedgerAdapter();
		km = new KeyManager(kmDir.dir);
		relay = new RelayClient(
			adapter as unknown as AgentAdapter,
			new SessionManager(sess.dir),
			{
				relayUrl: `ws://127.0.0.1:${env.port}`,
				device: { name: "This Mac", role: "tentacle", kind: "desktop" },
				localLink: true,
			},
			km,
		);
	});

	afterEach(async () => {
		for (const s of sockets.splice(0)) s.close();
		relay?.disconnect();
		await env.cleanup();
		for (const d of dirs.splice(0)) d.cleanup();
	});

	async function startTentacle(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			relay.onAuthenticated = () => resolve();
			relay.onFatalError = (m) => reject(new Error(m));
			relay.connect();
		});
		T = relay.getAuthInfo()!.deviceId;
		tPub = km.getKeyPair().publicKey;
		await until(() => {
			try {
				return readDiscovery(home).tentacleId === T;
			} catch {
				return false;
			}
		});
	}

	const cmd = (
		app: HeadApp,
		type: string,
		sessionId: string | undefined,
		payload: Msg,
	): Msg => ({
		type,
		deviceId: app.deviceId,
		...(sessionId && { sessionId }),
		seq: 0,
		timestamp: new Date().toISOString(),
		payload,
	});

	it("switching Head→link mid-stream over a slow Head never duplicates or loses draft text", async () => {
		// The Mac's Head connection crosses a 250 ms link (e.g. China ⇄ Tokyo).
		const proxy = new ChaosProxy("mac-head", () => env.port);
		await proxy.listen();
		proxy.set({ latencyMs: 250 });
		const mac = await connectHeadApp(proxy.port);
		sockets.push(mac);
		await startTentacle();
		await until(() => ofType(mac.received, "session_list").length > 0, 8000);
		const S = "stream";
		adapter.onSessionCreated?.({ sessionId: S, agent: "mock", model: "m" });
		await waitMs(700);
		mac.sendReliable(
			cmd(mac, "set_session_subscription", undefined, { sessionId: S }),
			T,
			tPub,
		);
		await until(
			() => ofType(mac.received, "session_subscription_set").length > 0,
			8000,
		);

		let expected = "";
		let linkSubscribed = false;
		for (let i = 0; i < 100; i++) {
			const chunk = `d${i} `;
			expected += chunk;
			adapter.onMessageDelta?.(S, { content: chunk });
			if (i === 40) {
				// Like the App: link up, wait for the link's session_list barrier, resubscribe over it.
				const local = await connectLocal(home, mac, tPub);
				sockets.push(local);
				until(() => ofType(local.received, "session_list").length > 0).then(
					() => {
						local.sendReliable(
							cmd(mac, "set_session_subscription", undefined, { sessionId: S }),
						);
						linkSubscribed = true;
					},
				);
			}
			await waitMs(15);
		}
		await waitMs(1200);
		expect(linkSubscribed).toBe(true);
		const naive = replayCard(mac.deviceId, T, S, false);
		const fixed = replayCard(mac.deviceId, T, S, true);
		const staleHeadFrames = arrivals.filter(
			(a) =>
				a.app === mac.deviceId &&
				a.route === "head" &&
				a.from === T &&
				arrivals.findIndex((b) => b.msg.type === "__link_up") <
					arrivals.indexOf(a),
		).length;
		console.log(
			"stale Head frames after link up:",
			staleHeadFrames,
			"| naive replay correct:",
			naive === expected,
			"| with stale-Head drop correct:",
			fixed === expected,
		);
		expect(fixed).toBe(expected);
		await proxy.close?.();
	}, 30_000);

	it("a delayed Head-routed subscription cannot override the link's subscription", async () => {
		const mac = await connectHeadApp(env.port);
		sockets.push(mac);
		await startTentacle();
		adapter.onSessionCreated?.({ sessionId: "A", agent: "mock", model: "m" });
		adapter.onSessionCreated?.({ sessionId: "B", agent: "mock", model: "m" });
		await waitMs(200);
		const local = await connectLocal(home, mac, tPub);
		sockets.push(local);
		await until(() => ofType(local.received, "session_list").length > 0);
		local.sendReliable(
			cmd(mac, "set_session_subscription", undefined, { sessionId: "B" }),
		);
		await until(() =>
			ofType(local.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).sessionId === "B",
			),
		);
		// A subscribe for A sent over the Head before the switch arrives late.
		mac.sendReliable(
			cmd(mac, "set_session_subscription", undefined, { sessionId: "A" }),
			T,
			tPub,
		);
		await waitMs(300);
		const before = ofType(local.received, "agent_message_delta").length;
		adapter.onMessageDelta?.("B", { content: "live B" });
		await waitMs(300);
		expect(ofType(local.received, "agent_message_delta").length).toBe(
			before + 1,
		);
	});

	it("subscription ACKs echo the request id on both routes, and ignore malformed ids", async () => {
		const mac = await connectHeadApp(env.port);
		sockets.push(mac);
		await startTentacle();
		adapter.onSessionCreated?.({ sessionId: "A", agent: "mock", model: "m" });
		await waitMs(200);
		mac.sendReliable(
			cmd(mac, "set_session_subscription", undefined, {
				sessionId: "A",
				requestId: "req-head-1",
			}),
			T,
			tPub,
		);
		await until(() =>
			ofType(mac.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).requestId === "req-head-1",
			),
		);
		const local = await connectLocal(home, mac, tPub);
		sockets.push(local);
		await until(() => ofType(local.received, "session_list").length > 0);
		local.sendReliable(
			cmd(mac, "set_session_subscription", undefined, {
				sessionId: "nope",
				requestId: "req-link-2",
			}),
		);
		await until(() =>
			ofType(local.received, "session_subscription_set").some(
				(m) =>
					(m.payload as Msg).requestId === "req-link-2" &&
					(m.payload as Msg).accepted === false,
			),
		);
		local.sendReliable(
			cmd(mac, "set_session_subscription", undefined, {
				sessionId: null,
				requestId: "bad id with spaces",
			}),
		);
		await until(() =>
			ofType(local.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).sessionId === null,
			),
		);
		const last = ofType(local.received, "session_subscription_set").at(-1)!;
		expect((last.payload as Msg).requestId).toBeUndefined();
	});

	it("every input runs exactly once while the link flaps and the App re-sends on both routes", async () => {
		const mac = await connectHeadApp(env.port);
		sockets.push(mac);
		await startTentacle();
		adapter.onSessionCreated?.({ sessionId: "S", agent: "mock", model: "m" });
		await waitMs(200);
		let local: Awaited<ReturnType<typeof connectLocal>> | null = null;
		const N = 40;
		for (let i = 0; i < N; i++) {
			const input = cmd(mac, "send_input", "S", {
				text: `input-${i}`,
				clientId: `cid-${i}`,
			});
			// Flap: toggle the link every few inputs.
			if (i % 5 === 0) {
				if (local) {
					local.close();
					local = null;
				} else {
					local = await connectLocal(home, mac, tPub);
					sockets.push(local);
				}
			}
			if (local) local.sendReliable(input);
			else mac.sendReliable(input, T, tPub);
			// resendPendingInputs: the same input again on the other route, and a late re-send.
			mac.sendReliable(input, T, tPub);
			if (i > 2)
				mac.sendReliable(
					cmd(mac, "send_input", "S", {
						text: `input-${i - 3}`,
						clientId: `cid-${i - 3}`,
					}),
					T,
					tPub,
				);
			await waitMs(20);
		}
		await waitMs(3000);
		const missing = Array.from({ length: N }, (_, i) => `input-${i}`).filter(
			(t) => !adapter.inputs.has(t),
		);
		console.log("MISSING", JSON.stringify(missing));
		await until(() => adapter.inputs.size === N, 8000);
		await waitMs(500);
		const counts = [...adapter.inputs.values()];
		console.log(
			"INPUT COUNTS",
			JSON.stringify([...adapter.inputs].filter(([, c]) => c !== 1)),
			"size",
			adapter.inputs.size,
		);
		expect(counts.every((c) => c === 1)).toBe(true);
	}, 30_000);

	it("the phone is unaffected while the Mac's link flaps during a turn", async () => {
		const mac = await connectHeadApp(env.port);
		const phone = await connectHeadApp(env.port);
		sockets.push(mac, phone);
		await startTentacle();
		adapter.onSessionCreated?.({ sessionId: "S", agent: "mock", model: "m" });
		await waitMs(200);
		phone.sendReliable(
			cmd(phone, "set_session_subscription", undefined, { sessionId: "S" }),
			T,
			tPub,
		);
		await until(
			() => ofType(phone.received, "session_subscription_set").length > 0,
		);
		let local: Awaited<ReturnType<typeof connectLocal>> | null = null;
		let expected = "";
		for (let i = 0; i < 60; i++) {
			if (i % 6 === 0) {
				if (local) {
					local.close();
					local = null;
				} else {
					local = await connectLocal(home, mac, tPub);
					sockets.push(local);
				}
			}
			expected += `p${i} `;
			adapter.onMessageDelta?.("S", { content: `p${i} ` });
			if (i % 10 === 9) adapter.onMessage?.("S", { content: `msg-${i}` });
			await waitMs(12);
		}
		await waitMs(500);
		const phoneMsgs = ofType(phone.received, "agent_message").map(
			(m) => (m.payload as Msg).content,
		);
		expect(phoneMsgs).toEqual([
			"msg-9",
			"msg-19",
			"msg-29",
			"msg-39",
			"msg-49",
			"msg-59",
		]);
		const phoneDeltaText = ofType(phone.received, "agent_message_delta")
			.map((m) => String((m.payload as Msg).content))
			.join("");
		expect(phoneDeltaText).toBe(expected);
		// The Mac received each agent message exactly once across both routes.
		const macMsgs = arrivals
			.filter((a) => a.app === mac.deviceId && a.msg.type === "agent_message")
			.map((a) => (a.msg.payload as Msg).content);
		expect(macMsgs).toEqual(phoneMsgs);
	}, 30_000);

	it("a second link from the same App replaces the first without a Head fallback in between", async () => {
		const mac = await connectHeadApp(env.port);
		sockets.push(mac);
		await startTentacle();
		const first = await connectLocal(home, mac, tPub);
		sockets.push(first);
		await until(() => ofType(first.received, "session_list").length > 0);
		const headLists = ofType(mac.received, "session_list").length;
		const second = await connectLocal(home, mac, tPub);
		sockets.push(second);
		await until(() => ofType(second.received, "session_list").length > 0);
		await waitMs(300);
		expect(first.ws.readyState).toBe(WebSocket.CLOSED);
		expect(ofType(mac.received, "session_list").length).toBe(headLists);
		expect(relay.getLocalLinkStats()!.peers).toEqual([mac.deviceId]);
		adapter.onMessage?.("x", { content: "after replace" });
		await until(() => ofType(second.received, "agent_message").length === 1);
	});

	it("an 8 MB App→Tentacle payload crosses the link", async () => {
		const mac = await connectHeadApp(env.port);
		sockets.push(mac);
		await startTentacle();
		adapter.onSessionCreated?.({ sessionId: "S", agent: "mock", model: "m" });
		await waitMs(200);
		const local = await connectLocal(home, mac, tPub);
		sockets.push(local);
		const big = "z".repeat(8 * 1024 * 1024);
		local.sendReliable(
			cmd(mac, "send_input", "S", { text: big, clientId: "big-1" }),
		);
		await until(() => adapter.inputs.has(big), 15_000);
		await until(
			() =>
				ofType(local.received, "user_message").some(
					(m) => (m.payload as Msg).clientId === "big-1",
				),
			15_000,
		);
	}, 30_000);

	describe("hostile local peers", () => {
		async function raw(): Promise<{
			ws: WebSocket;
			next: () => Promise<Msg | "closed">;
		}> {
			const { port } = readDiscovery(home);
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			const queue: Array<Msg | "closed"> = [];
			const waiters: Array<(m: Msg | "closed") => void> = [];
			const push = (m: Msg | "closed") =>
				waiters.length ? waiters.shift()!(m) : queue.push(m);
			ws.on("message", (d) => push(JSON.parse(d.toString())));
			ws.on("close", () => push("closed"));
			await new Promise((r) => ws.on("open", r));
			sockets.push({ close: () => ws.close() });
			return {
				ws,
				next: () =>
					queue.length
						? Promise.resolve(queue.shift()!)
						: new Promise((r) => waiters.push(r)),
			};
		}

		it("replaying a captured auth signature on a new connection fails", async () => {
			const mac = await connectHeadApp(env.port);
			sockets.push(mac);
			await startTentacle();
			const a = await raw();
			a.ws.send(
				JSON.stringify({
					type: "hello",
					v: 1,
					appId: mac.deviceId,
					nonce: randomBytes(32).toString("base64"),
				}),
			);
			const ch = (await a.next()) as Msg;
			const sig = signChallenge(
				appProofMessage(String(ch.nonce), T, mac.deviceId),
				mac.keyPair.privateKey,
			);
			a.ws.send(JSON.stringify({ type: "auth", signature: sig }));
			expect(((await a.next()) as Msg).type).toBe("ready");
			// Attacker replays the same signature on its own connection.
			const b = await raw();
			b.ws.send(
				JSON.stringify({
					type: "hello",
					v: 1,
					appId: mac.deviceId,
					nonce: randomBytes(32).toString("base64"),
				}),
			);
			await b.next();
			b.ws.send(JSON.stringify({ type: "auth", signature: sig }));
			expect(((await b.next()) as Msg).code).toBe("invalid_signature");
		});

		it("impersonating the phone (a real App of the account) without its key fails", async () => {
			const phone = await connectHeadApp(env.port);
			sockets.push(phone);
			await startTentacle();
			await expect(
				connectLocal(
					home,
					{ deviceId: phone.deviceId, keyPair: generateKeyPair() },
					tPub,
				),
			).rejects.toThrow(/invalid_signature|closed/);
		});

		it("frames before the handshake, garbage and oversized hello are ignored or refused", async () => {
			const mac = await connectHeadApp(env.port);
			sockets.push(mac);
			await startTentacle();
			const a = await raw();
			a.ws.send("not json");
			a.ws.send(JSON.stringify({ type: "pulse", pulse: "AAAA" }));
			a.ws.send(JSON.stringify({ type: "auth", signature: "x" }));
			const r = (await a.next()) as Msg;
			expect(r.code).toBe("bad_hello");
			expect(await a.next()).toBe("closed");
		});

		it("an idle unauthenticated connection is closed by the handshake timeout, and many of them do not block the real App", async () => {
			const mac = await connectHeadApp(env.port);
			sockets.push(mac);
			await startTentacle();
			// More squatters than the pending cap: the oldest are evicted.
			const idle = await Promise.all(Array.from({ length: 50 }, () => raw()));
			const local = await connectLocal(home, mac, tPub);
			sockets.push(local);
			await until(() => ofType(local.received, "session_list").length > 0);
			const closedAll = await Promise.race([
				Promise.all(
					idle.map(async (c) => {
						let m = await c.next();
						while (m !== "closed") m = await c.next();
						return true;
					}),
				),
				waitMs(12_000).then(() => false),
			]).then((v) => v !== false);
			expect(closedAll).toBe(true);
			// The authenticated App is never evicted.
			expect(local.ws.readyState).toBe(WebSocket.OPEN);
		}, 20_000);

		it("a flood of silent sockets cannot evict an App that is mid-handshake", async () => {
			const mac = await connectHeadApp(env.port);
			sockets.push(mac);
			await startTentacle();
			await Promise.all(Array.from({ length: 15 }, () => raw()));
			// The App says hello and receives its challenge ...
			const app = await raw();
			app.ws.send(
				JSON.stringify({
					type: "hello",
					v: 1,
					appId: mac.deviceId,
					nonce: randomBytes(32).toString("base64"),
				}),
			);
			const ch = (await app.next()) as Msg;
			expect(ch.type).toBe("challenge");
			// ... while an attacker keeps opening sockets.
			await Promise.all(Array.from({ length: 40 }, () => raw()));
			await waitMs(200);
			expect(app.ws.readyState).toBe(WebSocket.OPEN);
			app.ws.send(
				JSON.stringify({
					type: "auth",
					signature: signChallenge(
						appProofMessage(String(ch.nonce), T, mac.deviceId),
						mac.keyPair.privateKey,
					),
				}),
			);
			expect(((await app.next()) as Msg).type).toBe("ready");
		});

		it("an oversized frame before the handshake is refused", async () => {
			await startTentacle();
			const a = await raw();
			a.ws.send(
				JSON.stringify({
					type: "hello",
					v: 1,
					appId: "x",
					nonce: "y".repeat(10_000),
				}),
			);
			expect(((await a.next()) as Msg).code).toBe("frame_too_large");
		});

		it("an App cannot inject Head control or claim another device's identity over the link", async () => {
			const mac = await connectHeadApp(env.port);
			const phone = await connectHeadApp(env.port);
			sockets.push(mac, phone);
			await startTentacle();
			adapter.onSessionCreated?.({ sessionId: "S", agent: "mock", model: "m" });
			await waitMs(200);
			const local = await connectLocal(home, mac, tPub);
			sockets.push(local);
			await until(() => ofType(local.received, "session_list").length > 0);
			// Claims to be the phone inside the ciphertext.
			local.sendReliable({
				...cmd(phone, "send_input", "S", {
					text: "spoofed",
					clientId: "spoof-1",
				}),
			});
			await waitMs(400);
			expect(adapter.inputs.has("spoofed")).toBe(false);
			// A plaintext Head wrapper sent by the App is dropped.
			const before = ofType(phone.received, "session_list").length;
			const fake = JSON.stringify({
				from: "@head",
				msg: { type: "device_removed", deviceId: phone.deviceId },
			});
			(local as unknown as { ws: WebSocket }).ws.send(
				JSON.stringify({
					type: "pulse",
					pulse: Buffer.from(fake).toString("base64"),
				}),
			);
			await waitMs(300);
			adapter.onMessage?.("S", { content: "still reaches phone" });
			await until(() =>
				ofType(phone.received, "agent_message").some(
					(m) => (m.payload as Msg).content === "still reaches phone",
				),
			);
			expect(
				ofType(phone.received, "session_list").length,
			).toBeGreaterThanOrEqual(before);
			void encryptToBlob;
		});
	});
});
