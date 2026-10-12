/**
 * Local link END-TO-END (POC) — real Head + real Tentacle RelayClient + an App
 * that is connected to the Head AND opens the Tentacle's loopback link, the
 * way Kraki for Mac talks to the Tentacle running on the same Mac.
 *
 *   App ⇄(pulse/ws)⇄ Head ⇄(pulse/ws)⇄ Tentacle        identity, presence, other devices
 *   App ⇄(pulse/ws://127.0.0.1)⇄ Tentacle              all App⇄this-Tentacle traffic
 *
 * Proves: mutual-signature handshake, bootstrap over the link, producer
 * messages bypass the Head, App→Tentacle commands over the link, fallback to
 * the Head when the link drops, and rejection of unknown/forged peers.
 */

import { generateKeyPair } from "@kraki/crypto";
import type { AgentAdapter } from "@kraki/tentacle";
import { KeyManager, RelayClient, SessionManager } from "@kraki/tentacle";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
	createTestEnv,
	createTmpSessionDir,
	type TestEnv,
	waitMs,
} from "./helpers.js";
import {
	connectHeadApp,
	connectLocal,
	EmitAdapter,
	type Msg,
	ofType,
	readDiscovery,
	until,
} from "./local-link-helpers.js";

describe("Local link e2e: same-machine App ⇄ Tentacle bypassing the Head", () => {
	let env: TestEnv;
	let adapter: EmitAdapter;
	let relay: RelayClient;
	let km: KeyManager;
	let dirs: Array<{ dir: string; cleanup: () => void }>;
	let home: string;
	let tentacleId: string;
	let tentaclePub: string;

	beforeEach(async () => {
		env = await createTestEnv();
		adapter = new EmitAdapter();
		const sess = createTmpSessionDir();
		const kmDir = createTmpSessionDir();
		const homeDir = createTmpSessionDir();
		dirs = [sess, kmDir, homeDir];
		home = homeDir.dir;
		process.env.KRAKI_HOME = home;
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
		relay?.disconnect();
		await env.cleanup();
		for (const d of dirs) d.cleanup();
	});

	async function startTentacle(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			relay.onAuthenticated = () => resolve();
			relay.onFatalError = (m) => reject(new Error(m));
			relay.connect();
		});
		tentacleId = relay.getAuthInfo()!.deviceId;
		tentaclePub = km.getKeyPair().publicKey;
		await until(() => {
			try {
				return readDiscovery(home).tentacleId === tentacleId;
			} catch {
				return false;
			}
		});
	}

	it("serves a same-machine App entirely over the loopback link, then falls back to the Head", async () => {
		const app = await connectHeadApp(env.port);
		await startTentacle();
		await until(() => ofType(app.received, "session_list").length > 0); // normal Head bootstrap
		const headBaseline = app.received.length;

		// 1. Link up: bootstrap arrives over the link.
		const local = await connectLocal(home, app, tentaclePub);
		await until(() => ofType(local.received, "session_list").length > 0);
		expect(ofType(local.received, "device_greeting").length).toBe(1);
		expect(relay.getLocalLinkStats()!.peers).toEqual([app.deviceId]);

		// 2. Producer messages bypass the Head.
		adapter.onSessionCreated?.({ sessionId: "s1", agent: "mock", model: "m" });
		adapter.onMessage?.("s1", { content: "hello over loopback" });
		await until(() => ofType(local.received, "agent_message").length === 1);
		expect(
			(ofType(local.received, "agent_message")[0]!.payload as Msg).content,
		).toBe("hello over loopback");

		// 3. App → Tentacle over the link: subscribe, then receive subscriber-only deltas.
		local.sendReliable({
			type: "set_session_subscription",
			deviceId: app.deviceId,
			seq: 0,
			timestamp: new Date().toISOString(),
			payload: { sessionId: "s1" },
		});
		await until(() =>
			ofType(local.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).accepted === true,
			),
		);
		adapter.onMessageDelta?.("s1", { content: "streaming…" });
		await until(() => ofType(local.received, "agent_message_delta").length > 0);

		await waitMs(300);
		// Nothing from this Tentacle reached the App through the Head meanwhile.
		expect(app.received.length).toBe(headBaseline);
		expect(relay.getLocalLinkStats()!.head.framesToLinkedApps).toBe(0);

		// 4. Link drops: the Tentacle falls back to the Head with a fresh barrier.
		local.close();
		await until(
			() => ofType(app.received.slice(headBaseline), "session_list").length > 0,
		);
		adapter.onMessage?.("s1", { content: "back on the head" });
		await until(() =>
			ofType(app.received, "agent_message").some(
				(m) => (m.payload as Msg).content === "back on the head",
			),
		);
		expect(ofType(local.received, "agent_message").length).toBe(1);
		app.close();
	});

	it("keeps the link when the Tentacle reconnects to the Head", async () => {
		const app = await connectHeadApp(env.port);
		await startTentacle();
		const local = await connectLocal(home, app, tentaclePub);
		await until(() => ofType(local.received, "session_list").length > 0);
		local.sendReliable({
			type: "set_session_subscription",
			deviceId: app.deviceId,
			seq: 0,
			timestamp: new Date().toISOString(),
			payload: { sessionId: null },
		});
		await until(
			() => ofType(local.received, "session_subscription_set").length > 0,
		);

		// Kill the Head socket only (as on a network blip); the link stays up.
		(relay as unknown as { ws: WebSocket }).ws.terminate();
		await waitMs(100);
		adapter.onSessionCreated?.({ sessionId: "s2", agent: "mock", model: "m" });
		adapter.onMessage?.("s2", { content: "while head is down" });
		await until(() =>
			ofType(local.received, "agent_message").some(
				(m) => (m.payload as Msg).content === "while head is down",
			),
		);
		expect(relay.getLocalLinkStats()!.peers).toEqual([app.deviceId]);
		local.close();
		app.close();
	});

	it("rejects unknown devices, forged signatures and browser origins", async () => {
		const app = await connectHeadApp(env.port);
		await startTentacle();
		const stranger = { deviceId: "app_stranger", keyPair: generateKeyPair() };
		await expect(connectLocal(home, stranger, tentaclePub)).rejects.toThrow(
			/unknown_device|closed/,
		);
		await expect(
			connectLocal(home, app, tentaclePub, { forgeSignature: true }),
		).rejects.toThrow(/invalid_signature|closed/);
		await expect(
			connectLocal(home, app, tentaclePub, { origin: "https://evil.example" }),
		).rejects.toThrow();
		expect(relay.getLocalLinkStats()!.peers).toEqual([]);
		app.close();
	});

	it("with several devices: the linked Mac gets local, the phone still gets everything via the Head", async () => {
		const mac = await connectHeadApp(env.port);
		const phone = await connectHeadApp(env.port);
		await startTentacle();
		await until(() => ofType(phone.received, "session_list").length > 0);
		const macLocal = await connectLocal(home, mac, tentaclePub);
		await until(() => ofType(macLocal.received, "session_list").length > 0);
		const macHeadBaseline = mac.received.length;

		// One agent message reaches both: Mac over loopback, phone over the Head.
		adapter.onSessionCreated?.({ sessionId: "m1", agent: "mock", model: "m" });
		adapter.onMessage?.("m1", { content: "to everyone" });
		await until(() => ofType(macLocal.received, "agent_message").length === 1);
		await until(() => ofType(phone.received, "agent_message").length === 1);

		// The phone talks to the Tentacle through the Head and is answered there.
		phone.sendReliable(
			{
				type: "set_session_subscription",
				deviceId: phone.deviceId,
				seq: 0,
				timestamp: new Date().toISOString(),
				payload: { sessionId: "m1" },
			},
			tentacleId,
			tentaclePub,
		);
		await until(() =>
			ofType(phone.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).sessionId === "m1",
			),
		);
		expect(
			ofType(macLocal.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).sessionId === "m1",
			),
		).toBe(false);

		// Subscriptions are per device: only the phone gets m1's live deltas.
		adapter.onMessageDelta?.("m1", { content: "typing..." });
		await until(() => ofType(phone.received, "agent_message_delta").length > 0);
		await waitMs(200);
		expect(ofType(macLocal.received, "agent_message_delta").length).toBe(0);

		// Nothing for the Mac went through the Head.
		expect(mac.received.length).toBe(macHeadBaseline);
		expect(relay.getLocalLinkStats()!.head.framesToLinkedApps).toBe(0);
		macLocal.close();
		mac.close();
		phone.close();
	});

	it("both directions across devices: phone input shows on the Mac, Mac input shows on the phone, other computers unaffected", async () => {
		const mac = await connectHeadApp(env.port);
		const phone = await connectHeadApp(env.port);
		await startTentacle();
		const macLocal = await connectLocal(home, mac, tentaclePub);
		await until(() => ofType(macLocal.received, "session_list").length > 0);
		adapter.onSessionCreated?.({
			sessionId: "s-this-mac",
			agent: "mock",
			model: "m",
		});
		await waitMs(200);
		const input = (from: string, text: string, sessionId = "s-this-mac") => ({
			type: "send_input",
			deviceId: from,
			sessionId,
			seq: 0,
			timestamp: new Date().toISOString(),
			payload: { text, clientId: `c-${Math.random().toString(36).slice(2)}` },
		});
		const userTexts = (list: Msg[]) =>
			ofType(list, "user_message").map((m) => (m.payload as Msg).content);

		// 1. Phone types (via Head) -> the Mac sees it over the local link.
		phone.sendReliable(
			input(phone.deviceId, "from phone"),
			tentacleId,
			tentaclePub,
		);
		await until(() => userTexts(macLocal.received).includes("from phone"));
		await until(() => userTexts(phone.received).includes("from phone"));

		// 2. Mac types (over the local link) -> the phone sees it via the Head.
		macLocal.sendReliable(input(mac.deviceId, "from mac"));
		await until(() => userTexts(phone.received).includes("from mac"));
		await until(() => userTexts(macLocal.received).includes("from mac"));

		// 3. Agent reply on this Mac -> both.
		adapter.onMessage?.("s-this-mac", { content: "reply here" });
		const replies = (list: Msg[]) =>
			ofType(list, "agent_message").map((m) => (m.payload as Msg).content);
		await until(
			() =>
				replies(macLocal.received).includes("reply here") &&
				replies(phone.received).includes("reply here"),
		);

		// 4. Another computer (its own Tentacle, Head only) -> the Mac and phone
		//    both see it via the Head, and the Mac can drive it via the Head.
		const adapterB = new EmitAdapter();
		const sessB = createTmpSessionDir();
		const kmB = createTmpSessionDir();
		dirs.push(sessB, kmB);
		const keysB = new KeyManager(kmB.dir);
		const relayB = new RelayClient(
			adapterB as unknown as AgentAdapter,
			new SessionManager(sessB.dir),
			{
				relayUrl: `ws://127.0.0.1:${env.port}`,
				device: { name: "Other PC", role: "tentacle", kind: "desktop" },
				localLink: false,
			},
			keysB,
		);
		try {
			await new Promise<void>((resolve, reject) => {
				relayB.onAuthenticated = () => resolve();
				relayB.onFatalError = (m) => reject(new Error(m));
				relayB.connect();
			});
			const idB = relayB.getAuthInfo()!.deviceId;
			await waitMs(300);
			adapterB.onSessionCreated?.({
				sessionId: "s-other-pc",
				agent: "mock",
				model: "m",
			});
			adapterB.onMessage?.("s-other-pc", { content: "hello from other pc" });
			await until(
				() =>
					replies(mac.received).includes("hello from other pc") &&
					replies(phone.received).includes("hello from other pc"),
			);
			mac.sendReliable(
				input(mac.deviceId, "mac drives other pc", "s-other-pc"),
				idB,
				keysB.getKeyPair().publicKey,
			);
			await until(
				() =>
					userTexts(phone.received).includes("mac drives other pc") &&
					userTexts(mac.received).includes("mac drives other pc"),
			);
		} finally {
			relayB.disconnect();
		}

		// This Mac's Tentacle never routed anything for the linked Mac via the Head.
		expect(relay.getLocalLinkStats()!.head.framesToLinkedApps).toBe(0);
		macLocal.close();
		mac.close();
		phone.close();
	});

	it("removes the discovery file on shutdown", async () => {
		await startTentacle();
		relay.disconnect();
		expect(() => readDiscovery(home)).toThrow();
	});
});
