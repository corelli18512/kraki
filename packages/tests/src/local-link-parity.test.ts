/**
 * Local link PARITY — the same deterministic script, run twice:
 *   A) the Mac App reaches this Mac's Tentacle through the Head (today)
 *   B) the Mac App reaches it over the local link
 * A phone on the Head and a second computer take part in both runs.
 *
 * Every decrypted message the Mac and the phone receive after bootstrap is
 * normalised (device ids, timestamps, random ids) and must be identical
 * between A and B. The script covers every App⇄Tentacle flow the clients use:
 * input + echo, streaming deltas, status card / tools, permission, question +
 * answer, abort, session settings, history ranges (bulk stream), Steps,
 * paced attachments, a large message, delete (durable) and the other computer.
 */

import type { AgentAdapter } from "@kraki/tentacle";
import {
	AttachmentStore,
	KeyManager,
	RelayClient,
	SessionManager,
} from "@kraki/tentacle";
import { afterEach, describe, expect, it } from "vitest";
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
	type HeadApp,
	type LocalApp,
	type Msg,
	ofType,
	readDiscovery,
	until,
} from "./local-link-helpers.js";

class RichAdapter extends EmitAdapter {
	aborted: string[] = [];
	answered: string[] = [];
	async respondToQuestion(_s: string, id: string) {
		this.answered.push(id);
		return "accepted" as const;
	}
	async abortSession(sessionId: string) {
		this.aborted.push(sessionId);
	}
	getSessionUsage() {
		return undefined;
	}
	setSessionUsage() {}
	setSessionMode() {}
	async setSessionModel() {}
	setTurnIdentity() {}
	isTurnSettled() {
		return true;
	}
	registerSessionAgent() {}
	async generateTitle() {
		return null;
	}
}

/** Spine types carry a per-session seq; everything else a global counter. */
const SPINE = new Set([
	"session_created",
	"agent_message",
	"user_message",
	"error",
	"system_message",
	"interrupted_turn",
	"turn_status",
	"session_ended",
	"idle",
]);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalise(value: unknown, ids: Map<string, string>): unknown {
	if (typeof value === "string") {
		if (ids.has(value)) return ids.get(value);
		if (ISO.test(value)) return "<ts>";
		return value.replace(UUID, "<uuid>");
	}
	if (Array.isArray(value)) return value.map((v) => normalise(v, ids));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => a.localeCompare(b),
		)) {
			if (
				[
					"timestamp",
					"openedAt",
					"abortedAt",
					"lastSeen",
					"createdAt",
					"updatedAt",
					"lastActivityAt",
					"startedAt",
				].includes(k)
			)
				continue;
			out[k] = normalise(v, ids);
		}
		return out;
	}
	return value;
}

/** Bulk-stream types (tentacle-pulse streamForType): ordered among themselves,
 *  but independent of the live stream. */
const BULK = new Set([
	"session_replay_batch",
	"session_messages_batch",
	"session_messages_range_batch",
	"turn_trace_batch",
	"attachment_data",
	"usage_history",
]);

/**
 * Canonical form that KEEPS delivery order where order is guaranteed: one
 * ordered list per (sender, stream). Interleaving between different senders or
 * between live and bulk is not guaranteed on either route, so only that is
 * left free. A reorder within a group fails the comparison.
 */
function canon(list: Msg[], ids: Map<string, string>): string[] {
	const groups = new Map<string, string[]>();
	for (const m of list) {
		const copy = { ...m };
		if (!SPINE.has(String(m.type))) delete copy.seq;
		const key = `${ids.get(String(m.deviceId)) ?? m.deviceId}|${BULK.has(String(m.type)) ? "bulk" : "live"}`;
		const g = groups.get(key) ?? [];
		g.push(JSON.stringify(normalise(copy, ids)));
		groups.set(key, g);
	}
	return [...groups.keys()]
		.sort()
		.flatMap((k) => groups.get(k)!.map((line) => `${k} ${line}`));
}

function findKey(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	if (key in (value as Record<string, unknown>))
		return (value as Record<string, unknown>)[key];
	for (const v of Object.values(value as Record<string, unknown>)) {
		const hit = findKey(v, key);
		if (hit !== undefined) return hit;
	}
	return undefined;
}

interface RunResult {
	mac: string[];
	phone: string[];
	headFramesToLinkedMac: number;
	/** local_notification copies the linked Mac got, and Head push dispatches. */
	localNotifications: number;
	pushDispatches: number;
	linkedPayloadsOut: number;
	types: string[];
}

async function runScript(mode: "head" | "link"): Promise<RunResult> {
	const env: TestEnv = await createTestEnv();
	const dirs = [
		createTmpSessionDir(),
		createTmpSessionDir(),
		createTmpSessionDir(),
		createTmpSessionDir(),
		createTmpSessionDir(),
	];
	const [sess, kmDir, homeDir, sessB, kmB] = dirs;
	process.env.KRAKI_HOME = homeDir.dir;
	const adapter = new RichAdapter();
	const km = new KeyManager(kmDir.dir);
	const relay = new RelayClient(
		adapter as unknown as AgentAdapter,
		new SessionManager(sess.dir),
		{
			relayUrl: `ws://127.0.0.1:${env.port}`,
			device: { name: "This Mac", role: "tentacle", kind: "desktop" },
			localLink: mode === "link",
		},
		km,
		new AttachmentStore(sess.dir),
	);
	const adapterB = new RichAdapter();
	const kmBKeys = new KeyManager(kmB.dir);
	const relayB = new RelayClient(
		adapterB as unknown as AgentAdapter,
		new SessionManager(sessB.dir),
		{
			relayUrl: `ws://127.0.0.1:${env.port}`,
			device: { name: "Other PC", role: "tentacle", kind: "desktop" },
			localLink: false,
		},
		kmBKeys,
	);
	let mac: HeadApp | undefined;
	let phone: HeadApp | undefined;
	let macLocal: LocalApp | undefined;
	try {
		mac = await connectHeadApp(env.port);
		phone = await connectHeadApp(env.port);
		for (const r of [relay, relayB]) {
			await new Promise<void>((resolve, reject) => {
				r.onAuthenticated = () => resolve();
				r.onFatalError = (m) => reject(new Error(m));
				r.connect();
			});
		}
		const T = relay.getAuthInfo()!.deviceId;
		const TB = relayB.getAuthInfo()!.deviceId;
		const tPub = km.getKeyPair().publicKey;
		const tbPub = kmBKeys.getKeyPair().publicKey;
		await until(
			() =>
				ofType(phone!.received, "session_list").length >= 2 &&
				ofType(mac!.received, "session_list").length >= 2,
		);

		// The Mac's inbox for this Tentacle depends on the route.
		let macInbox: Msg[] = mac.received;
		if (mode === "link") {
			await until(() => {
				try {
					return readDiscovery(homeDir.dir).tentacleId === T;
				} catch {
					return false;
				}
			});
			macLocal = await connectLocal(homeDir.dir, mac, tPub);
			await until(() => ofType(macLocal!.received, "session_list").length > 0);
			macInbox = macLocal.received;
		}
		const macSend = (msg: Msg) =>
			macLocal ? macLocal.sendReliable(msg) : mac!.sendReliable(msg, T, tPub);
		const phoneSend = (msg: Msg) => phone!.sendReliable(msg, T, tPub);
		const cmd = (
			from: HeadApp,
			type: string,
			sessionId: string | undefined,
			payload: Msg,
		): Msg => ({
			type,
			deviceId: from.deviceId,
			...(sessionId && { sessionId }),
			seq: 0,
			timestamp: new Date().toISOString(),
			payload,
		});
		const settle = () => waitMs(250);

		// ── Only what happens from here on is compared. ──
		const macStart = macInbox.length;
		const macHeadStart = mac.received.length;
		const phoneStart = phone.received.length;
		const S = "parity-session";

		adapter.onSessionCreated?.({ sessionId: S, agent: "mock", model: "m" });
		await settle();
		macSend(cmd(mac, "set_session_subscription", undefined, { sessionId: S }));
		phoneSend(
			cmd(phone, "set_session_subscription", undefined, { sessionId: S }),
		);
		await until(() =>
			ofType(macInbox, "session_subscription_set").some(
				(m) => (m.payload as Msg).sessionId === S,
			),
		);
		await settle();

		// 1. Input from the phone, then from the Mac (echoes to both).
		phoneSend(
			cmd(phone, "send_input", S, {
				text: "from phone",
				clientId: "c-phone-1",
			}),
		);
		await until(() => ofType(macInbox, "user_message").length >= 1);
		await settle();
		// The phone's turn ends first: a normal prompt sent while a turn is
		// still running is persisted only when it dispatches (after that idle).
		adapter.onIdle?.(S);
		await settle();
		macSend(
			cmd(mac, "send_input", S, { text: "from mac", clientId: "c-mac-1" }),
		);
		await until(() => ofType(phone.received, "user_message").length >= 2);
		await settle();

		// 2. A turn: tool steps on the card, streaming, a permission, a reply.
		adapter.onToolStart?.(S, {
			toolName: "bash",
			args: { command: "ls -la" },
			toolCallId: "tc1",
		});
		await settle();
		adapter.onToolComplete?.(S, {
			toolName: "bash",
			result: "file\n".repeat(200),
			toolCallId: "tc1",
			success: true,
		});
		await settle();
		adapter.onMessageDelta?.(S, { content: "Thinking " });
		adapter.onMessageDelta?.(S, { content: "about it…" });
		await settle();
		adapter.onPermissionRequest?.(S, {
			id: "perm-1",
			toolArgs: { toolName: "write", args: { path: "/tmp/x" } },
			description: "Write /tmp/x",
		} as never);
		await until(() =>
			ofType(macInbox, "card_action").some((m) =>
				JSON.stringify(m).includes("perm-1"),
			),
		);
		macSend(cmd(mac, "approve", S, { permissionId: "perm-1" }));
		await until(
			() => ofType(phone.received, "permission_resolved").length >= 1,
		);
		adapter.onMessage?.(S, { content: "Done. Here is the reply." });
		adapter.onIdle?.(S);
		await settle();

		// 3. A question answered from the phone.
		adapter.onQuestionRequest?.(S, {
			id: "q-1",
			question: "Which colour?",
			choices: ["red", "blue"],
		} as never);
		await until(() =>
			ofType(macInbox, "agent_message").some((m) =>
				JSON.stringify(m).includes("Which colour?"),
			),
		);
		phoneSend(
			cmd(phone, "send_input", S, {
				text: "blue",
				clientId: "c-phone-2",
				answerTo: "q-1",
			}),
		);
		await until(() => adapter.answered.includes("q-1"));
		adapter.onMessage?.(S, { content: "Blue it is." });
		adapter.onIdle?.(S);
		await settle();

		// 4. Abort from the Mac mid-turn.
		macSend(
			cmd(mac, "send_input", S, { text: "long task", clientId: "c-mac-2" }),
		);
		await settle();
		adapter.onToolStart?.(S, {
			toolName: "bash",
			args: { command: "sleep 100" },
			toolCallId: "tc2",
		});
		await settle();
		macSend(cmd(mac, "abort_session", S, {}));
		await until(() => adapter.aborted.includes(S));
		adapter.onIdle?.(S);
		await settle();

		// 5. Session settings from the Mac.
		macSend(cmd(mac, "set_session_mode", S, { mode: "plan" }));
		macSend(cmd(mac, "rename_session", S, { title: "Parity" }));
		macSend(cmd(mac, "pin_session", S, { pinned: true }));
		macSend(cmd(mac, "mark_read", S, { seq: 3 }));
		await settle();

		// 6. History, Steps, attachment chunks — the bulk stream.
		const lastSeq = Math.max(
			...ofType(macInbox, "agent_message").map((m) => Number(m.seq)),
		);
		macSend(
			cmd(mac, "request_session_messages_range", undefined, {
				sessionId: S,
				fromSeq: 1,
				toSeq: lastSeq,
				requestId: "r-range",
			}),
		);
		await until(
			() => ofType(macInbox, "session_messages_range_batch").length > 0,
		);
		const replySeq = Number(
			ofType(macInbox, "agent_message").find(
				(m) => (m.payload as Msg).content === "Done. Here is the reply.",
			)!.seq,
		);
		macSend(
			cmd(mac, "request_turn_trace", undefined, {
				sessionId: S,
				bubbleSeq: replySeq,
				requestId: "r-trace",
			}),
		);
		await until(() => ofType(macInbox, "turn_trace_batch").length > 0);
		const ref = findKey(ofType(macInbox, "turn_trace_batch"), "resultRef") as
			| { id: string }
			| undefined;
		expect(ref?.id).toBeTruthy();
		macSend(
			cmd(mac, "request_attachment", undefined, {
				id: ref!.id,
				sessionId: S,
				mode: "paced",
				index: 0,
			}),
		);
		await until(() => ofType(macInbox, "attachment_data").length > 0);
		await settle();

		// 6b. Error, system notice and compaction inside a turn; card snapshot.
		phoneSend(
			cmd(phone, "send_input", S, { text: "another", clientId: "c-phone-3" }),
		);
		await settle();
		adapter.onCompaction?.(S, { phase: "start", reason: "threshold" });
		await settle();
		adapter.onCompaction?.(S, { phase: "end", reason: "threshold" });
		adapter.onSystemMessage?.(S, { kind: "notice", content: "Model switched" });
		adapter.onError?.(S, { message: "rate limited" });
		adapter.onIdle?.(S);
		await settle();
		macSend(cmd(mac, "request_card", undefined, { sessionId: S }));
		macSend(cmd(mac, "set_session_model", S, { model: "m2" }));
		macSend(cmd(mac, "request_usage_history", undefined, { since: 0 }));
		await settle();

		// 6c. Archive, list archived, unarchive.
		macSend(cmd(mac, "archive_session", S, { archived: true }));
		await settle();
		macSend(
			cmd(mac, "request_archived_sessions", undefined, { requestId: "r-arch" }),
		);
		await until(() => ofType(macInbox, "archived_session_list").length > 0);
		macSend(cmd(mac, "archive_session", S, { archived: false }));
		await settle();

		// 7. A 1 MB reply.
		adapter.onMessage?.(S, { content: `big ${"y".repeat(1_000_000)}` });
		await until(() =>
			ofType(macInbox, "agent_message").some((m) =>
				String((m.payload as Msg).content).startsWith("big "),
			),
		);
		await settle();

		// 8. The other computer: Mac and phone see it and can drive it (Head).
		adapterB.onSessionCreated?.({
			sessionId: "other-session",
			agent: "mock",
			model: "m",
		});
		adapterB.onMessage?.("other-session", { content: "hello from other pc" });
		mac.sendReliable(
			cmd(mac, "send_input", "other-session", {
				text: "mac to other pc",
				clientId: "c-mac-3",
			}),
			TB,
			tbPub,
		);
		await until(() =>
			ofType(phone.received, "user_message").some(
				(m) => (m.payload as Msg).content === "mac to other pc",
			),
		);
		await settle();

		// 9. Delete from the Mac (the only durable message).
		macSend(cmd(mac, "delete_session", S, {}));
		await until(
			() =>
				ofType(phone.received, "session_deleted").length > 0 &&
				ofType(macInbox, "session_deleted").length > 0,
		);
		await waitMs(500);

		const ids = new Map([
			[T, "<THIS_MAC_TENTACLE>"],
			[TB, "<OTHER_PC>"],
			[mac.deviceId, "<MAC_APP>"],
			[phone.deviceId, "<PHONE>"],
		]);
		// The Mac's full view: this Tentacle's messages from its route, plus
		// the other computer's from the Head.
		const localNotifications = ofType(
			macInbox.slice(macStart),
			"local_notification",
		).length;
		const macView = [
			...macInbox.slice(macStart),
			...(mode === "link" ? mac.received.slice(macHeadStart) : []),
		];
		const stats = relay.getLocalLinkStats();
		return {
			// The link adds same-machine notification copies (deduped by the App);
			// they are checked separately below.
			mac: canon(
				macView.filter((m) => m.type !== "local_notification"),
				ids,
			),
			localNotifications,
			pushDispatches: env.pushSpy.previews.length,
			phone: canon(phone.received.slice(phoneStart), ids),
			headFramesToLinkedMac: stats?.head.framesToLinkedApps ?? 0,
			linkedPayloadsOut: stats?.payloadsOut ?? 0,
			types: [...new Set(macView.map((m) => String(m.type)))].sort(),
		};
	} finally {
		macLocal?.close();
		mac?.close();
		phone?.close();
		relay.disconnect();
		relayB.disconnect();
		await env.cleanup();
		for (const d of dirs) d.cleanup();
	}
}

describe("Local link parity: identical messages whether the Mac goes through the Head or the local link", () => {
	afterEach(() => {
		delete process.env.KRAKI_HOME;
	});

	it("the Mac and the phone receive exactly the same messages in both modes", async () => {
		const viaHead = await runScript("head");
		const viaLink = await runScript("link");

		console.log("message types covered:", viaLink.types.join(", "));
		console.log(
			"Mac messages:",
			viaHead.mac.length,
			"/",
			viaLink.mac.length,
			"phone messages:",
			viaHead.phone.length,
			"/",
			viaLink.phone.length,
		);

		expect(viaLink.mac).toEqual(viaHead.mac);
		expect(viaLink.phone).toEqual(viaHead.phone);
		expect(viaLink.headFramesToLinkedMac).toBe(0);
		expect(viaHead.localNotifications).toBe(0);
		expect(viaLink.pushDispatches).toBe(viaHead.pushDispatches);
		expect(viaLink.localNotifications).toBe(viaLink.pushDispatches);
		expect(viaLink.localNotifications).toBeGreaterThan(0);
		expect(viaLink.linkedPayloadsOut).toBeGreaterThan(20);
		for (const t of [
			"user_message",
			"agent_message",
			"agent_message_delta",
			"card_action",
			"permission_resolved",
			"idle",
			"active",
			"session_list",
			"session_subscription_set",
			"session_messages_range_batch",
			"turn_trace_batch",
			"attachment_data",
			"session_deleted",
			"compacting",
			"system_message",
			"archived_session_list",
			"session_model_set",
			"error",
		]) {
			expect(viaLink.types).toContain(t);
		}
	}, 60_000);
});
