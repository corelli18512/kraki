/**
 * LocalLink — a direct loopback transport between this Tentacle and an App
 * running on the same machine (POC).
 *
 * Normally every App⇄Tentacle byte goes Tentacle → Head → App, even when both
 * run on the same Mac. The local link lets a same-machine App talk to the
 * Tentacle over `ws://127.0.0.1:<port>` instead. Head stays in the picture for
 * everything else (identity/device list, other machines, push, voice, prefs).
 *
 * Wire model (deliberately identical to the Head hop above the transport):
 *   - Payloads are the same E2E `{blob, keys}` ciphertext the Head would carry,
 *     so the App's decrypt/route path is unchanged.
 *   - Reliability/ordering is a fresh per-connection Pulse StreamSet (live +
 *     bulk), the same `TentaclePulse` used on the Head hop. A new connection is
 *     a new epoch; reconnect authority is re-established by `session_list`,
 *     exactly as after a Head `device_joined`.
 *
 * Trust: loopback is not an identity. Both sides prove possession of the
 * device signing key the Head already registered for them (mutual challenge,
 * domain-separated so a signature can never be replayed as Head challenge
 * auth). Browser origins are refused outright.
 *
 * Discovery: `<KRAKI_HOME>/local-link.json` (0600) carries the port and this
 * Tentacle's device ID. It is removed on shutdown.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { importPublicKey, signChallenge, verifyChallenge } from "@kraki/crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createLogger } from "./logger.js";
import { TentaclePulse } from "./tentacle-pulse.js";

const logger = createLogger("local-link");

export const LOCAL_LINK_VERSION = 1;
export const LOCAL_LINK_FILE = "local-link.json";
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Unauthenticated connections allowed at once (any local process can connect). */
const MAX_PENDING = 16;
/** Handshake frames are tiny; anything larger before auth is hostile. */
const MAX_HANDSHAKE_FRAME = 4096;
const TICK_MS = 5_000;
const PING_MS = 10_000;
const MAX_PAYLOAD = 64 * 1024 * 1024;

/** Strings each side signs. Domain-separated from Head challenge auth (which
 *  signs a bare nonce) so neither side can be used as a signing oracle. */
export function tentacleProofMessage(
	appNonce: string,
	appId: string,
	tentacleId: string,
): string {
	return `kraki-local-link/v${LOCAL_LINK_VERSION}/tentacle\n${appNonce}\n${appId}\n${tentacleId}`;
}
export function appProofMessage(
	tentacleNonce: string,
	tentacleId: string,
	appId: string,
): string {
	return `kraki-local-link/v${LOCAL_LINK_VERSION}/app\n${tentacleNonce}\n${tentacleId}\n${appId}`;
}

export interface LocalLinkHost {
	/** This Tentacle's device ID, once known. */
	tentacleId(): string | undefined;
	/** This Tentacle's private key PEM (same key registered with the Head). */
	privateKeyPem(): string | undefined;
	/** The registered signing key (compact SPKI) of an App device, or undefined
	 *  if the device is unknown / not an App of this user. */
	appSigningKey(appId: string): string | undefined;
	onPeerUp(appId: string): void;
	onPeerDown(appId: string): void;
	/** A Pulse-delivered payload from an authenticated local App. */
	onDelivered(appId: string, payloadJson: string): void;
}

export interface LocalLinkStats {
	peers: string[];
	framesOut: number;
	framesIn: number;
	bytesOut: number;
	bytesIn: number;
	payloadsOut: number;
	payloadsIn: number;
}

interface Peer {
	appId: string;
	ws: WebSocket;
	pulse: TentaclePulse;
	alive: boolean;
}

export class LocalLinkServer {
	private wss: WebSocketServer | null = null;
	private peers = new Map<string, Peer>();
	/** Every accepted socket, authenticated or not, so stop() closes them all. */
	private sockets = new Set<WebSocket>();
	private pending = 0;
	private pendingOrder: WebSocket[] = [];
	/** Pending sockets that sent a valid hello (got a challenge). */
	private greeted = new WeakSet<WebSocket>();
	/** Identifies this listener in the discovery file (PIDs can be reused). */
	private readonly instance = randomBytes(16).toString("hex");
	private tickTimer: ReturnType<typeof setInterval> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private port = 0;
	private readonly stats = {
		framesOut: 0,
		framesIn: 0,
		bytesOut: 0,
		bytesIn: 0,
		payloadsOut: 0,
		payloadsIn: 0,
	};

	constructor(
		private readonly host: LocalLinkHost,
		private readonly krakiHome: string,
	) {}

	get filePath(): string {
		return join(this.krakiHome, LOCAL_LINK_FILE);
	}

	get listening(): boolean {
		return this.wss !== null && this.port > 0;
	}

	async start(): Promise<void> {
		if (this.wss) return;
		const wss = new WebSocketServer({
			host: "127.0.0.1",
			port: Number(process.env.KRAKI_LOCAL_LINK_PORT ?? 0),
			maxPayload: MAX_PAYLOAD,
			// A browser page can open ws://127.0.0.1 too. Native clients send no
			// Origin; refuse anything that does before any handshake work.
			verifyClient: (info: { origin?: string }) => !info.origin,
		});
		this.wss = wss;
		await new Promise<void>((resolve, reject) => {
			wss.once("listening", () => resolve());
			wss.once("error", reject);
		});
		this.port = (wss.address() as AddressInfo).port;
		wss.on("connection", (ws) => this.accept(ws));
		wss.on("error", (err) =>
			logger.warn({ err: err.message }, "local link server error"),
		);
		this.writeDiscoveryFile();
		this.tickTimer = setInterval(() => {
			for (const peer of this.peers.values()) peer.pulse.tick();
		}, TICK_MS);
		this.pingTimer = setInterval(() => this.pingPeers(), PING_MS);
		this.tickTimer.unref?.();
		this.pingTimer.unref?.();
		logger.info(
			{ port: this.port, file: this.filePath },
			"Local link listening",
		);
	}

	stop(): void {
		if (this.tickTimer) clearInterval(this.tickTimer);
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.tickTimer = null;
		this.pingTimer = null;
		for (const peer of [...this.peers.values()]) peer.pulse.onDisconnected();
		this.peers.clear();
		// Close every socket, including ones still in the handshake; their
		// timers are cleared by the close handler.
		for (const ws of [...this.sockets]) {
			try {
				ws.close(1001, "shutdown");
			} catch {
				/* ignore */
			}
			ws.terminate();
		}
		this.sockets.clear();
		this.pending = 0;
		this.pendingOrder = [];
		this.wss?.close();
		this.wss = null;
		this.port = 0;
		// A successor in the same KRAKI_HOME may already have published its own
		// record: only remove the file if it is still ours.
		try {
			const current = JSON.parse(readFileSync(this.filePath, "utf8"));
			if (current?.instance === this.instance)
				rmSync(this.filePath, { force: true });
		} catch {
			/* missing or unreadable: nothing of ours to remove */
		}
	}

	has(appId: string): boolean {
		return this.peers.has(appId);
	}

	peerIds(): string[] {
		return [...this.peers.keys()];
	}

	getStats(): LocalLinkStats {
		return { peers: this.peerIds(), ...this.stats };
	}

	/** Reliable send to one local App. Returns false when it is not linked. */
	send(
		appId: string,
		payloadJson: string,
		durable: boolean,
		coalesceKey: string | undefined,
		stream: number,
	): boolean {
		const peer = this.peers.get(appId);
		if (!peer) return false;
		this.stats.payloadsOut++;
		peer.pulse.send(payloadJson, undefined, durable, coalesceKey, stream);
		return true;
	}

	/** Drop a peer (e.g. the device was removed from the account). */
	disconnectPeer(appId: string, reason: string): void {
		this.peers.get(appId)?.ws.close(4003, reason);
	}

	private writeDiscoveryFile(): void {
		// Unpredictable name, created exclusively (O_EXCL never follows a
		// planted symlink), then renamed over the record atomically.
		const tmp = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`;
		const body = JSON.stringify({
			v: LOCAL_LINK_VERSION,
			port: this.port,
			tentacleId: this.host.tentacleId(),
			pid: process.pid,
			instance: this.instance,
			startedAt: new Date().toISOString(),
		});
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, body);
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, this.filePath);
	}

	private pingPeers(): void {
		for (const peer of this.peers.values()) {
			if (!peer.alive) {
				logger.warn(
					{ appId: peer.appId },
					"Local link peer missed ping; terminating",
				);
				peer.ws.terminate();
				continue;
			}
			peer.alive = false;
			try {
				peer.ws.ping();
			} catch {
				/* close follows */
			}
		}
	}

	private accept(ws: WebSocket): void {
		// Bound unauthenticated connections. When full, evict one rather than
		// refuse the newcomer, so squatters cannot lock the real App out:
		// sockets that never said hello go first (a real App says hello at
		// once), so an App already in the challenge survives a flood.
		if (this.pendingOrder.length >= MAX_PENDING) {
			const silent = this.pendingOrder.find((c) => !this.greeted.has(c));
			const victim = silent ?? this.pendingOrder[0];
			logger.warn(
				"Local link: too many unauthenticated connections; evicting one",
			);
			const i = this.pendingOrder.indexOf(victim);
			if (i >= 0) this.pendingOrder.splice(i, 1);
			victim.terminate();
		}
		this.sockets.add(ws);
		this.pendingOrder.push(ws);
		this.pending++;
		let counted = true;
		const settlePending = () => {
			if (counted) {
				counted = false;
				this.pending--;
				const i = this.pendingOrder.indexOf(ws);
				if (i >= 0) this.pendingOrder.splice(i, 1);
			}
		};
		let phase: "hello" | "challenged" | "ready" = "hello";
		let appId = "";
		let tentacleNonce = "";
		let peer: Peer | null = null;
		const fail = (code: string, message: string) => {
			logger.warn({ code, appId }, `Local link handshake rejected: ${message}`);
			try {
				ws.send(JSON.stringify({ type: "error", code, message }));
			} catch {
				/* ignore */
			}
			ws.close(4001, code);
		};
		const handshakeTimer = setTimeout(() => {
			if (phase !== "ready") fail("handshake_timeout", "Handshake timed out");
		}, HANDSHAKE_TIMEOUT_MS);

		ws.on("message", (data) => {
			if (phase !== "ready" && (data as Buffer).length > MAX_HANDSHAKE_FRAME) {
				fail("frame_too_large", "Handshake frame too large");
				return;
			}
			const raw = data.toString();
			this.stats.framesIn++;
			this.stats.bytesIn += raw.length;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			if (phase === "ready" && peer) {
				if (msg.type === "pulse" && typeof msg.pulse === "string")
					peer.pulse.onFrame(msg.pulse);
				return;
			}
			if (phase === "hello") {
				if (
					msg.type !== "hello" ||
					msg.v !== LOCAL_LINK_VERSION ||
					typeof msg.appId !== "string" ||
					typeof msg.nonce !== "string" ||
					msg.nonce.length < 16
				) {
					fail("bad_hello", "Malformed hello");
					return;
				}
				appId = msg.appId;
				const tentacleId = this.host.tentacleId();
				const pem = this.host.privateKeyPem();
				if (!tentacleId || !pem) {
					fail("not_ready", "Tentacle is not signed in yet");
					return;
				}
				if (!this.host.appSigningKey(appId)) {
					fail("unknown_device", "Not an App device of this account");
					return;
				}
				tentacleNonce = randomBytes(32).toString("base64");
				const signature = signChallenge(
					tentacleProofMessage(msg.nonce, appId, tentacleId),
					pem,
				);
				phase = "challenged";
				this.greeted.add(ws);
				ws.send(
					JSON.stringify({
						type: "challenge",
						v: LOCAL_LINK_VERSION,
						tentacleId,
						nonce: tentacleNonce,
						signature,
					}),
				);
				return;
			}
			if (phase === "challenged") {
				const tentacleId = this.host.tentacleId();
				const key = this.host.appSigningKey(appId);
				if (
					msg.type !== "auth" ||
					typeof msg.signature !== "string" ||
					!tentacleId ||
					!key
				) {
					fail("bad_auth", "Malformed auth");
					return;
				}
				let ok = false;
				try {
					ok = verifyChallenge(
						appProofMessage(tentacleNonce, tentacleId, appId),
						msg.signature,
						importPublicKey(key),
					);
				} catch {
					ok = false;
				}
				if (!ok) {
					fail("invalid_signature", "App signature did not verify");
					return;
				}
				clearTimeout(handshakeTimer);
				phase = "ready";
				settlePending();
				// One link per App: a newer connection replaces the older one.
				const previous = this.peers.get(appId);
				if (previous) {
					// The new link's onPeerUp re-bootstraps the App; no fallback in between.
					this.peers.delete(appId);
					previous.pulse.onDisconnected();
					previous.ws.close(4002, "replaced");
				}
				const linkedAppId = appId;
				peer = {
					appId,
					ws,
					alive: true,
					pulse: new TentaclePulse(
						{
							now: () => Date.now(),
							sendPulseFrame: (pulseB64) => this.transmit(ws, pulseB64),
							onDelivered: (payloadJson) => {
								this.stats.payloadsIn++;
								this.host.onDelivered(linkedAppId, payloadJson);
							},
						},
						`tentacle-local:${tentacleId}:${linkedAppId}:${Date.now()}`,
					),
				};
				this.peers.set(appId, peer);
				ws.send(JSON.stringify({ type: "ready", v: LOCAL_LINK_VERSION }));
				peer.pulse.onConnected();
				logger.info({ appId }, "Local link peer authenticated");
				this.host.onPeerUp(appId);
			}
		});

		ws.on("pong", () => {
			if (peer) peer.alive = true;
		});

		ws.on("close", () => {
			clearTimeout(handshakeTimer);
			settlePending();
			this.sockets.delete(ws);
			if (peer && this.peers.get(peer.appId) === peer) {
				this.peers.delete(peer.appId);
				peer.pulse.onDisconnected();
				logger.info({ appId: peer.appId }, "Local link peer disconnected");
				this.host.onPeerDown(peer.appId);
			}
		});
		ws.on("error", (err) =>
			logger.debug({ err: err.message }, "local link socket error"),
		);
	}

	private transmit(ws: WebSocket, pulseB64: string): void {
		if (ws.readyState !== WebSocket.OPEN) return;
		const raw = JSON.stringify({ type: "pulse", pulse: pulseB64 });
		this.stats.framesOut++;
		this.stats.bytesOut += raw.length;
		ws.send(raw);
	}
}
