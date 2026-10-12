/** Shared helpers for the local-link integration tests. */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Endpoint } from "@coinfra/pulse";
import {
	decryptFromBlob,
	encryptToBlob,
	exportPublicKey,
	generateKeyPair,
	type KeyPair,
	signChallenge,
	verifyChallenge,
} from "@kraki/crypto";
import { expect } from "vitest";
import { WebSocket } from "ws";
import {
	appProofMessage,
	tentacleProofMessage,
} from "../../tentacle/src/local-link.js";
import { waitMs } from "./helpers.js";

export class EmitAdapter {
	onSessionCreated:
		| ((e: { sessionId: string; agent: string; model?: string }) => void)
		| null = null;
	onMessage: ((sessionId: string, e: { content: string }) => void) | null =
		null;
	onMessageDelta: ((sessionId: string, e: { content: string }) => void) | null =
		null;
	onPermissionRequest: ((sessionId: string, e: unknown) => void) | null = null;
	onPermissionAutoResolved:
		| ((sessionId: string, permissionId: string) => void)
		| null = null;
	onQuestionRequest: ((sessionId: string, e: unknown) => void) | null = null;
	onToolStart: ((sessionId: string, e: unknown) => void) | null = null;
	onToolComplete: ((sessionId: string, e: unknown) => void) | null = null;
	onIdle: ((sessionId: string) => void) | null = null;
	onError: ((sessionId: string, e: { message: string }) => void) | null = null;
	onSessionEnded: ((sessionId: string, e: { reason: string }) => void) | null =
		null;
	async start() {}
	async stop() {}
	async createSession(config?: { sessionId?: string }) {
		const sessionId = config?.sessionId ?? "sess_1";
		this.onSessionCreated?.({ sessionId, agent: "mock", model: "mock-v1" });
		return { sessionId };
	}
	async resumeSession(sessionId: string) {
		return { sessionId };
	}
	async sendMessage() {}
	async respondToPermission() {}
	async respondToQuestion() {}
	async killSession() {}
	async abortSession() {}
	listModels() {
		return [];
	}
	listModelDetails() {
		return [];
	}
}

export const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
export const unb64 = (s: string): Uint8Array =>
	new Uint8Array(Buffer.from(s, "base64"));
export const enc = new TextEncoder();
export const dec = new TextDecoder();

export type Msg = Record<string, unknown>;

/** Arrival order across both routes: every decrypted message is appended
 *  with the route it came from (non-enumerable data kept out of the message). */
export const arrivals: Array<{
	route: "head" | "link";
	app: string;
	msg: Msg;
	from?: string;
}> = [];

/** App's Head connection (pulse over the relay). */
export interface HeadApp {
	deviceId: string;
	keyPair: KeyPair;
	received: Msg[];
	/** Head control delivered over Pulse ({from:"@head", msg}). */
	controls: Msg[];
	/** Raw (non-Pulse) frame to the Head, e.g. register_push_token. */
	sendRaw: (msg: Msg) => void;
	sendReliable: (msg: Msg, tentacleId: string, tentaclePubPem: string) => void;
	close: () => void;
}

export async function connectHeadApp(port: number): Promise<HeadApp> {
	const keyPair = generateKeyPair();
	const deviceId = `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const received: Msg[] = [];
	const controls: Msg[] = [];
	const endpoint = new Endpoint({
		epoch: `app:${deviceId}`,
		random: () => 0.5,
		durable: { supported: false },
	});
	let currentTo = "";
	const run = (effects: ReturnType<Endpoint["onTick"]>) => {
		for (const e of effects) {
			if (e.t === "transmit") {
				ws.send(
					JSON.stringify({
						type: "unicast",
						to: currentTo,
						pulse: b64(e.bytes),
						blob: "",
						keys: {},
					}),
				);
			} else if (e.t === "deliver") {
				try {
					const parsed = JSON.parse(dec.decode(e.payload));
					if (parsed.from === "@head") {
						controls.push(parsed.msg);
						continue;
					}
					const { blob, keys, src } = parsed;
					const msg = JSON.parse(
						decryptFromBlob({ blob, keys }, deviceId, keyPair.privateKey),
					);
					received.push(msg);
					arrivals.push({ route: "head", app: deviceId, msg, from: src });
				} catch {
					/* control / not for us */
				}
			}
		}
	};
	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	ws.on("message", (data) => {
		const raw = JSON.parse(data.toString());
		if (raw.type === "auth_ok") run(endpoint.onConnected(Date.now()));
		else if (
			(raw.type === "unicast" || raw.type === "broadcast") &&
			typeof raw.pulse === "string"
		) {
			run(endpoint.onBytes(unb64(raw.pulse), Date.now()));
		}
	});
	ws.send(
		JSON.stringify({
			type: "auth",
			auth: { method: "open" },
			device: {
				name: "Mac App",
				role: "app",
				kind: "desktop",
				deviceId,
				publicKey: exportPublicKey(keyPair.publicKey),
			},
		}),
	);
	await waitMs(300);
	const tick = setInterval(() => run(endpoint.onTick(Date.now())), 200);
	return {
		controls,
		sendRaw: (msg: Msg) => ws.send(JSON.stringify(msg)),
		deviceId,
		keyPair,
		received,
		sendReliable: (msg, tentacleId, pub) => {
			const { blob, keys } = encryptToBlob(JSON.stringify(msg), [
				{ deviceId: tentacleId, publicKey: pub },
			]);
			currentTo = tentacleId;
			run(endpoint.send(enc.encode(JSON.stringify({ blob, keys }))).effects);
		},
		close: () => {
			clearInterval(tick);
			ws.close();
		},
	};
}

/** App's local link to the Tentacle on the same machine. */
export interface LocalApp {
	ws: WebSocket;
	received: Msg[];
	sendReliable: (msg: Msg) => void;
	close: () => void;
}

export function readDiscovery(home: string): {
	port: number;
	tentacleId: string;
} {
	return JSON.parse(readFileSync(join(home, "local-link.json"), "utf8"));
}

export async function connectLocal(
	home: string,
	app: { deviceId: string; keyPair: KeyPair },
	tentaclePubPem: string,
	options: { forgeSignature?: boolean; origin?: string } = {},
): Promise<LocalApp> {
	const { port, tentacleId } = readDiscovery(home);
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}`,
		options.origin ? { origin: options.origin } : {},
	);
	const received: Msg[] = [];
	const endpoint = new Endpoint({
		epoch: `app-local:${app.deviceId}:${Date.now()}`,
		random: () => 0.5,
		durable: { supported: false },
	});
	const run = (effects: ReturnType<Endpoint["onTick"]>) => {
		for (const e of effects) {
			if (e.t === "transmit")
				ws.send(JSON.stringify({ type: "pulse", pulse: b64(e.bytes) }));
			else if (e.t === "deliver") {
				const { blob, keys } = JSON.parse(dec.decode(e.payload));
				const msg = JSON.parse(
					decryptFromBlob({ blob, keys }, app.deviceId, app.keyPair.privateKey),
				);
				received.push(msg);
				arrivals.push({
					route: "link",
					app: app.deviceId,
					msg,
					from: tentacleId,
				});
			}
		}
	};
	await new Promise<void>((resolve, reject) => {
		ws.on("open", resolve);
		ws.on("error", reject);
	});
	const appNonce = randomBytes(32).toString("base64");
	const ready = new Promise<void>((resolve, reject) => {
		ws.on("close", (code) => reject(new Error(`closed ${code}`)));
		ws.on("message", (data) => {
			const raw = JSON.parse(data.toString());
			if (raw.type === "challenge") {
				// Authenticate the Tentacle before proving ourselves.
				if (
					raw.tentacleId !== tentacleId ||
					!verifyChallenge(
						tentacleProofMessage(appNonce, app.deviceId, tentacleId),
						raw.signature,
						tentaclePubPem,
					)
				) {
					reject(new Error("tentacle proof failed"));
					ws.close();
					return;
				}
				const proof = appProofMessage(raw.nonce, tentacleId, app.deviceId);
				const signature = options.forgeSignature
					? signChallenge(proof, generateKeyPair().privateKey)
					: signChallenge(proof, app.keyPair.privateKey);
				ws.send(JSON.stringify({ type: "auth", signature }));
			} else if (raw.type === "ready") {
				arrivals.push({
					route: "link",
					app: app.deviceId,
					msg: { type: "__link_up" },
					from: tentacleId,
				});
				run(endpoint.onConnected(Date.now()));
				resolve();
			} else if (raw.type === "error") {
				reject(new Error(raw.code));
			} else if (raw.type === "pulse") {
				run(endpoint.onBytes(unb64(raw.pulse), Date.now()));
			}
		});
	});
	ws.send(
		JSON.stringify({
			type: "hello",
			v: 1,
			appId: app.deviceId,
			nonce: appNonce,
		}),
	);
	await ready;
	const tick = setInterval(() => run(endpoint.onTick(Date.now())), 200);
	return {
		ws,
		received,
		sendReliable: (msg) => {
			const { blob, keys } = encryptToBlob(JSON.stringify(msg), [
				{ deviceId: tentacleId, publicKey: tentaclePubPem },
			]);
			run(endpoint.send(enc.encode(JSON.stringify({ blob, keys }))).effects);
		},
		close: () => {
			clearInterval(tick);
			ws.close();
		},
	};
}

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!cond() && Date.now() < deadline) await waitMs(25);
	expect(cond()).toBe(true);
}

export const ofType = (list: Msg[], type: string) =>
	list.filter((m) => m.type === type);
