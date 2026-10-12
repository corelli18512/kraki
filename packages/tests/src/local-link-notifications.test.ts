/**
 * Notifications with the local link. The Mac does not use APNs: the Tentacle
 * sends an encrypted preview to the Head (`dispatch_push`), and the Head
 * forwards it to online Macs that registered a `local` token
 * (`notification_preview`). Offline phones get it through the push manager.
 * The link must change none of this.
 */
import { decryptFromBlob } from "@kraki/crypto";
import type { AgentAdapter } from "@kraki/tentacle";
import { KeyManager, RelayClient, SessionManager } from "@kraki/tentacle";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { ChaosProxy } from "./chaos/proxy.js";
import { createTestEnv, createTmpSessionDir, waitMs } from "./helpers.js";
import {
	connectHeadApp,
	connectLocal,
	EmitAdapter,
	type HeadApp,
	type Msg,
	ofType,
	readDiscovery,
	until,
} from "./local-link-helpers.js";

class TurnAdapter extends EmitAdapter {
	async sendMessage() {}
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
	async respondToQuestion() {
		return "accepted" as const;
	}
}

function macPreviews(
	mac: HeadApp,
): Array<{ type: string; summary?: string; sessionId: string }> {
	return ofType(mac.controls, "notification_preview").map((m) => {
		const p = m.payload as { blob: string; key: string };
		return JSON.parse(
			decryptFromBlob(
				{ blob: p.blob, keys: { [mac.deviceId]: p.key } },
				mac.deviceId,
				mac.keyPair.privateKey,
			),
		);
	});
}

async function setup(link: boolean, tentacleProxy = false) {
	const env = await createTestEnv();
	const proxy = tentacleProxy
		? new ChaosProxy("tentacle-head", () => env.port)
		: undefined;
	const relayPort = proxy ? await proxy.listen() : env.port;
	const dirs = [
		createTmpSessionDir(),
		createTmpSessionDir(),
		createTmpSessionDir(),
	];
	process.env.KRAKI_HOME = dirs[2].dir;
	const adapter = new TurnAdapter();
	const km = new KeyManager(dirs[1].dir);
	const relay = new RelayClient(
		adapter as unknown as AgentAdapter,
		new SessionManager(dirs[0].dir),
		{
			relayUrl: `ws://127.0.0.1:${relayPort}`,
			device: { name: "This Mac", role: "tentacle", kind: "desktop" },
			localLink: link,
		},
		km,
	);
	const mac = await connectHeadApp(env.port);
	mac.sendRaw({
		type: "register_push_token",
		payload: { provider: "local", token: mac.deviceId },
	});
	const phone = await connectHeadApp(env.port);
	await waitMs(200);
	await new Promise<void>((resolve) => {
		relay.onAuthenticated = () => resolve();
		relay.connect();
	});
	const T = relay.getAuthInfo()!.deviceId;
	const tPub = km.getKeyPair().publicKey;
	let local: Awaited<ReturnType<typeof connectLocal>> | undefined;
	if (link) {
		await until(() => {
			try {
				return readDiscovery(dirs[2].dir).tentacleId === T;
			} catch {
				return false;
			}
		});
		local = await connectLocal(dirs[2].dir, mac, tPub);
		await until(() => ofType(local!.received, "session_list").length > 0);
	}
	// Like the App: use the link while it is open, otherwise the Head.
	const macSend = (msg: Msg) =>
		local && local.ws.readyState === 1
			? local.sendReliable(msg)
			: mac.sendReliable(msg, T, tPub);
	const cmd = (type: string, sessionId: string, payload: Msg): Msg => ({
		type,
		deviceId: mac.deviceId,
		sessionId,
		seq: 0,
		timestamp: new Date().toISOString(),
		payload,
	});
	const cleanup = async () => {
		local?.close();
		mac.close();
		phone.close();
		relay.disconnect();
		await proxy?.close();
		await env.cleanup();
		for (const d of dirs) d.cleanup();
		delete process.env.KRAKI_HOME;
	};
	return {
		proxy,
		env,
		adapter,
		relay,
		mac,
		phone,
		local,
		macSend,
		cmd,
		T,
		cleanup,
	};
}

/** Permission, question, and a completed turn — the three notifying events. */
async function notifyingTurn(s: Awaited<ReturnType<typeof setup>>, S: string) {
	s.adapter.onSessionCreated?.({ sessionId: S, agent: "mock", model: "m" });
	await waitMs(150);
	s.macSend(s.cmd("send_input", S, { text: "go", clientId: `c-${S}` }));
	await waitMs(200);
	s.adapter.onPermissionRequest?.(S, {
		id: `perm-${S}`,
		toolArgs: { toolName: "write", args: {} },
		description: "Write a file",
	} as never);
	await waitMs(200);
	s.adapter.onQuestionRequest?.(S, {
		id: `q-${S}`,
		question: "Which colour?",
		choices: ["red"],
	} as never);
	await waitMs(200);
	s.macSend(
		s.cmd("send_input", S, {
			text: "red",
			clientId: `a-${S}`,
			answerTo: `q-${S}`,
		}),
	);
	await waitMs(300);
	s.adapter.onMessage?.(S, { content: "All done." });
	s.adapter.onIdle?.(S);
	await waitMs(500);
}

type Preview = {
	nid?: string;
	type: string;
	summary?: string;
	sessionId: string;
};

function linkPreviews(local: { received: Msg[] } | undefined): Preview[] {
	return ofType(local?.received ?? [], "local_notification").map((m) =>
		JSON.parse(String((m.payload as Msg).preview)),
	);
}

/** What the Mac actually posts: both routes, first copy of each nid wins. */
function posted(
	mac: HeadApp,
	local: { received: Msg[] } | undefined,
): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of [...linkPreviews(local), ...macPreviews(mac)]) {
		if (p.nid && seen.has(p.nid)) continue;
		if (p.nid) seen.add(p.nid);
		out.push(`${p.type}:${p.summary ?? ""}`);
	}
	return out;
}

const summary = (list: Array<{ type: string; summary?: string }>) =>
	list.map((p) => `${p.type}:${p.summary ?? ""}`);

describe("Local link and notifications", () => {
	it("the Mac gets the same notifications, exactly once, whether linked or not; offline phones too", async () => {
		const results: Record<string, { mac: string[]; offline: number }> = {};
		for (const link of [false, true]) {
			const s = await setup(link);
			try {
				s.phone.close(); // phone offline → push manager
				await waitMs(300);
				const before = s.env.pushSpy.previews.length;
				await notifyingTurn(s, "n1");
				await waitMs(1500);
				console.log(
					"MODE",
					link ? "link" : "head",
					JSON.stringify(summary(macPreviews(s.mac))),
					"controls",
					JSON.stringify(s.mac.controls.map((c) => c.type)),
					"spy",
					s.env.pushSpy.previews.length - before,
				);
				await waitMs(300);
				if (link) {
					// Same three notifications over the link, same ids as the Head copies.
					expect(linkPreviews(s.local).map((p) => p.nid)).toEqual(
						macPreviews(s.mac).map((p) => p.nid),
					);
					expect(new Set(macPreviews(s.mac).map((p) => p.nid)).size).toBe(3);
				} else {
					expect(linkPreviews(s.local)).toEqual([]);
				}
				results[link ? "link" : "head"] = {
					mac: posted(s.mac, s.local),
					offline: s.env.pushSpy.previews.length - before,
				};
				// Offline previews are encrypted for the phone too.
				expect(
					s.env.pushSpy.previews.at(-1)!.keys[s.phone.deviceId],
				).toBeTruthy();
			} finally {
				await s.cleanup();
			}
		}
		console.log("notifications", JSON.stringify(results));
		expect(results.head.mac).toEqual([
			"permission:Write a file",
			"question:Which colour?",
			"idle:All done.",
		]);
		expect(results.link).toEqual(results.head);
	}, 30_000);

	it("linked Mac whose Head connection is down: messages and notifications still arrive over the link", async () => {
		const s = await setup(true);
		try {
			(s.mac as unknown as { close: () => void }).close();
			await waitMs(300);
			await notifyingTurn(s, "n2");
			const got = ofType(s.local!.received, "agent_message").some(
				(m) => (m.payload as Msg).content === "All done.",
			);
			console.log(
				"Head down: reply over link =",
				got,
				"| Mac notifications =",
				macPreviews(s.mac).length,
			);
			expect(got).toBe(true);
			expect(macPreviews(s.mac).length).toBe(0);
		} finally {
			await s.cleanup();
		}
	}, 30_000);

	it("Tentacle offline from the Head for 8 s during a turn: notifications arrive on time over the link, late Head copies are duplicates", async () => {
		const s = await setup(true, true);
		try {
			s.proxy!.set({ refuse: true });
			expect(s.proxy!.liveConnections).toBe(1);
			s.proxy!.reset();
			await until(() => s.relay.getState() !== "connected");
			const t0 = Date.now();
			await notifyingTurn(s, "n3");
			// On time, over the link, while the Head is unreachable.
			expect(summary(linkPreviews(s.local))).toEqual([
				"permission:Write a file",
				"question:Which colour?",
				"idle:All done.",
			]);
			expect(macPreviews(s.mac).length).toBe(0);
			await waitMs(Math.max(0, 8000 - (Date.now() - t0)));
			s.proxy!.set({ refuse: false });
			await until(() => s.relay.getState() === "connected", 20_000);
			await until(() => macPreviews(s.mac).length === 3, 5000);
			// The late Head copies carry the same ids: the Mac posts nothing more.
			expect(new Set(macPreviews(s.mac).map((p) => p.nid))).toEqual(
				new Set(linkPreviews(s.local).map((p) => p.nid)),
			);
			expect(posted(s.mac, s.local)).toEqual([
				"permission:Write a file",
				"question:Which colour?",
				"idle:All done.",
			]);
		} finally {
			await s.cleanup();
		}
	}, 60_000);

	it("link closed right before the event: the Head copy still notifies (no gap)", async () => {
		const s = await setup(true);
		try {
			s.local!.close();
			await waitMs(300);
			await notifyingTurn(s, "n4");
			expect(linkPreviews(s.local).length).toBe(0);
			expect(posted(s.mac, s.local)).toEqual([
				"permission:Write a file",
				"question:Which colour?",
				"idle:All done.",
			]);
		} finally {
			await s.cleanup();
		}
	}, 30_000);

	it("notifications for other computers and for unlinked apps are unchanged", async () => {
		const s = await setup(true);
		try {
			// A second Mac (not linked) and the phone, both online: only the
			// linked Mac gets local_notification, nothing goes to the others.
			const other = await connectHeadApp(s.env.port);
			other.sendRaw({
				type: "register_push_token",
				payload: { provider: "local", token: other.deviceId },
			});
			await waitMs(300);
			await notifyingTurn(s, "n5");
			await until(() => macPreviews(other).length === 3);
			expect(ofType(other.received, "local_notification").length).toBe(0);
			expect(ofType(s.phone.received, "local_notification").length).toBe(0);
			expect(posted(s.mac, s.local).length).toBe(3);
			other.close();
		} finally {
			await s.cleanup();
		}
	}, 30_000);
});
