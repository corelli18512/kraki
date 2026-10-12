/**
 * Local link for the Windows/Linux desktop app: the actual web client
 * (packages/arm/web/src/lib/local-link.ts) against a real Head and Tentacle.
 * The desktop page connects with `Origin: app://kraki`; ordinary browser
 * origins stay refused.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
	decryptFromBlob,
	encryptToBlob,
	exportPublicKey,
	signChallenge,
} from "@kraki/crypto";
import type { AgentAdapter } from "@kraki/tentacle";
import { KeyManager, RelayClient, SessionManager } from "@kraki/tentacle";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { LocalLinkClient } from "../../arm/web/src/lib/local-link.js";
import {
	createTestEnv,
	createTmpSessionDir,
	type TestEnv,
	waitMs,
} from "./helpers.js";
import {
	connectHeadApp,
	EmitAdapter,
	type HeadApp,
	type Msg,
	ofType,
	readDiscovery,
	until,
} from "./local-link-helpers.js";

const DESKTOP_ORIGIN = "app://kraki";

describe("Local link: desktop web client (Windows/Linux)", () => {
	let env: TestEnv;
	let relay: RelayClient;
	let km: KeyManager;
	let adapter: EmitAdapter;
	let home: string;
	let T: string;
	const dirs: Array<{ dir: string; cleanup: () => void }> = [];
	const closers: Array<() => void> = [];

	beforeEach(async () => {
		env = await createTestEnv();
		const sess = createTmpSessionDir();
		const kmDir = createTmpSessionDir();
		const homeDir = createTmpSessionDir();
		dirs.push(sess, kmDir, homeDir);
		home = homeDir.dir;
		process.env.KRAKI_HOME = home;
		adapter = new EmitAdapter();
		km = new KeyManager(kmDir.dir);
		relay = new RelayClient(
			adapter as unknown as AgentAdapter,
			new SessionManager(sess.dir),
			{
				relayUrl: `ws://127.0.0.1:${env.port}`,
				device: { name: "This PC", role: "tentacle", kind: "desktop" },
			},
			km,
		);
	});

	afterEach(async () => {
		for (const c of closers.splice(0)) c();
		relay?.disconnect();
		await env.cleanup();
		for (const d of dirs.splice(0)) d.cleanup();
		delete process.env.KRAKI_HOME;
	});

	async function startTentacle() {
		await new Promise<void>((resolve, reject) => {
			relay.onAuthenticated = () => resolve();
			relay.onFatalError = (m) => reject(new Error(m));
			relay.connect();
		});
		T = relay.getAuthInfo()!.deviceId;
		await until(() => {
			try {
				return readDiscovery(home).tentacleId === T;
			} catch {
				return false;
			}
		});
	}

	/** The web LocalLinkClient as the desktop page runs it. */
	function webClient(
		app: HeadApp,
		opts: { origin?: string; discovery?: () => string | null } = {},
	) {
		const received: Msg[] = [];
		const changes: Array<{ linked: boolean; unacked: number }> = [];
		const client = new LocalLinkClient({
			readDiscovery: async () =>
				opts.discovery
					? opts.discovery()
					: readFileSync(join(home, "local-link.json"), "utf8"),
			appId: () => app.deviceId,
			tentacleKey: (id) =>
				id === T ? exportPublicKey(km.getKeyPair().publicKey) : undefined,
			sign: async (message) => signChallenge(message, app.keyPair.privateKey),
			onLinkChange: (_id, linked, unacked) =>
				changes.push({ linked, unacked: unacked.length }),
			onDelivered: (payloadJson) => {
				const { blob, keys } = JSON.parse(payloadJson);
				received.push(
					JSON.parse(
						decryptFromBlob(
							{ blob, keys },
							app.deviceId,
							app.keyPair.privateKey,
						),
					),
				);
			},
			createSocket: (url) =>
				new WebSocket(url, {
					origin: opts.origin ?? DESKTOP_ORIGIN,
				}) as unknown as globalThis.WebSocket,
		});
		closers.push(() => client.stop());
		const sendToTentacle = (msg: Msg, replayable = false) => {
			const { blob, keys } = encryptToBlob(JSON.stringify(msg), [
				{ deviceId: T, publicKey: km.getKeyPair().publicKey },
			]);
			return client.send(JSON.stringify({ blob, keys }), T, replayable);
		};
		return { client, received, changes, sendToTentacle };
	}

	it("links from the desktop origin, carries traffic both ways, nothing for it through the Head", async () => {
		const app = await connectHeadApp(env.port);
		closers.push(() => app.close());
		await startTentacle();
		const w = webClient(app);
		w.client.start();
		await until(() => w.client.linkedTentacleId === T, 8000);
		await until(() => ofType(w.received, "session_list").length > 0);
		const headBefore = app.received.length;

		adapter.onSessionCreated?.({ sessionId: "S", agent: "mock", model: "m" });
		adapter.onMessage?.("S", { content: "hello windows" });
		await until(() =>
			ofType(w.received, "agent_message").some(
				(m) => (m.payload as Msg).content === "hello windows",
			),
		);

		expect(
			w.sendToTentacle({
				type: "set_session_subscription",
				deviceId: app.deviceId,
				seq: 0,
				timestamp: new Date().toISOString(),
				payload: { sessionId: "S", requestId: "req-1" },
			}),
		).toBe(true);
		await until(() =>
			ofType(w.received, "session_subscription_set").some(
				(m) => (m.payload as Msg).requestId === "req-1",
			),
		);
		adapter.onMessageDelta?.("S", { content: "streaming" });
		await until(() => ofType(w.received, "agent_message_delta").length > 0);

		await waitMs(300);
		expect(app.received.length).toBe(headBefore);
		expect(relay.getLocalLinkStats()!.head.framesToLinkedApps).toBe(0);
		expect(w.changes).toEqual([{ linked: true, unacked: 0 }]);
	});

	it("a link drop hands unconfirmed replayable commands back for the Head route", async () => {
		const app = await connectHeadApp(env.port);
		closers.push(() => app.close());
		await startTentacle();
		const w = webClient(app);
		w.client.start();
		await until(() => w.client.linkedTentacleId === T, 8000);
		w.sendToTentacle(
			{
				type: "mark_read",
				deviceId: app.deviceId,
				sessionId: "S",
				seq: 0,
				timestamp: new Date().toISOString(),
				payload: { seq: 1 },
			},
			true,
		);
		w.client.dropForTesting();
		expect(w.changes.at(-1)).toEqual({ linked: false, unacked: 1 });
	});

	it("browser origins are refused; the client backs off instead of hammering", async () => {
		const app = await connectHeadApp(env.port);
		closers.push(() => app.close());
		await startTentacle();
		const w = webClient(app, { origin: "https://evil.example" });
		w.client.start();
		await waitMs(3000);
		expect(w.client.linkedTentacleId).toBeNull();
		expect(relay.getLocalLinkStats()!.peers).toEqual([]);
	});

	it("a fake server that answers hello with ready is never trusted", async () => {
		const app = await connectHeadApp(env.port);
		closers.push(() => app.close());
		await startTentacle();
		const server = createServer();
		const wss = new WebSocketServer({ server });
		const seen: string[] = [];
		wss.on("connection", (ws) =>
			ws.on("message", (d) => {
				const m = JSON.parse(String(d));
				seen.push(m.type);
				if (m.type === "hello")
					ws.send(JSON.stringify({ type: "ready", v: 1 }));
			}),
		);
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
		closers.push(() => {
			wss.close();
			server.close();
		});
		const port = (server.address() as AddressInfo).port;
		const w = webClient(app, {
			discovery: () => JSON.stringify({ v: 1, port, tentacleId: T }),
		});
		w.client.start();
		await until(() => seen.includes("hello"), 5000);
		await waitMs(500);
		expect(w.client.linkedTentacleId).toBeNull();
		expect(w.client.lastError).toMatch(/unexpected ready/);
		expect(seen).not.toContain("auth");
		expect(
			w.sendToTentacle({ type: "send_input", payload: { text: "x" } }),
		).toBe(false);
	});
});
