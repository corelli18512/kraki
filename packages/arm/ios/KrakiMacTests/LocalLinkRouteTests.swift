import Foundation
import Pulse
import XCTest
@testable import Kraki_Dev

/// Route-switch guards for the Mac local link.
@MainActor
final class LocalLinkRouteTests: XCTestCase {
    private func makeApp() throws -> (AppState, EncryptionHandler, SecKey, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ll-route-\(UUID().uuidString)")
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.deviceId = "app-1"
        let keychain = KeychainManager()
        keychain.activateEphemeralKeys()
        let handler = EncryptionHandler(crypto: CryptoManager(), keychain: keychain, appState: app)
        let pair = try keychain.getOrCreateEncryptionKey()
        return (app, handler, pair.publicKey, root)
    }

    private func envelope(_ inner: [String: Any], to key: SecKey, stale: Bool, src: String = "T1") throws -> Data {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: inner), as: UTF8.self)
        let blob = try CryptoManager().encryptToBlob(json, recipients: [RecipientKey(deviceId: "app-1", publicKey: key)])
        var object: [String: Any] = ["blob": blob.blob, "keys": blob.keys, "src": src]
        if stale { object[EncryptionHandler.staleRouteKey] = true }
        return try JSONSerialization.data(withJSONObject: object)
    }

    func testStaleRouteDropsOnlyConnectionScopedLiveState() throws {
        let (app, handler, key, root) = try makeApp()
        defer { withExtendedLifetime(app) {} }
        defer { try? FileManager.default.removeItem(at: root) }
        for type in ["agent_message_delta", "card_action", "session_subscription_set"] {
            let data = try envelope(["type": type, "deviceId": "T1", "sessionId": "S"], to: key, stale: true)
            XCTAssertThrowsError(try handler.decryptInbound(data), type) { error in
                guard case EncryptionError.staleRoute = error else { return XCTFail("\(type): \(error)") }
            }
            // The same message on the current route is applied.
            XCTAssertNoThrow(try handler.decryptInbound(try envelope(["type": type, "deviceId": "T1"], to: key, stale: false)))
        }
        // Idempotent authorities still apply when they arrive late on the old
        // route: session_list is the fallback barrier after a link drop.
        for type in ["session_list", "agent_message", "user_message", "idle", "session_deleted"] {
            XCTAssertNoThrow(try handler.decryptInbound(try envelope(["type": type, "deviceId": "T1"], to: key, stale: true)), type)
        }
    }

    func testReassembledFragmentKeepsTheHeadStampedSender() throws {
        let whole = #"{"blob":"b","keys":{}}"#
        let part = try JSONSerialization.data(withJSONObject: ["kfrag": 1, "id": "x", "i": 0, "n": 1, "d": whole, "src": "T1"])
        let stamped = PulseManager.stampSender(whole, from: [UInt8](part))
        let object = try JSONSerialization.jsonObject(with: Data(stamped.utf8)) as? [String: Any]
        XCTAssertEqual(object?["src"] as? String, "T1")
        // A part without a sender leaves the payload untouched.
        let bare = try JSONSerialization.data(withJSONObject: ["kfrag": 1, "id": "x", "i": 0, "n": 1, "d": whole])
        XCTAssertEqual(PulseManager.stampSender(whole, from: [UInt8](bare)), whole)
    }

    func testSenderCheckNowAppliesToReassembledPayloads() throws {
        let (app, handler, key, root) = try makeApp()
        defer { withExtendedLifetime(app) {} }
        defer { try? FileManager.default.removeItem(at: root) }
        // T2 claims to be T1 inside the ciphertext; the stamped sender exposes it.
        let data = try envelope(["type": "agent_message", "deviceId": "T1"], to: key, stale: false, src: "T2")
        XCTAssertThrowsError(try handler.decryptInbound(data)) { error in
            guard case EncryptionError.senderMismatch = error else { return XCTFail("\(error)") }
        }
    }

    // MARK: Unconfirmed commands survive a link loss

    private final class Host: PulseHost {
        var frames: [String] = []
        func sendPulseFrame(_ b64: String, target: String?) { frames.append(b64) }
        func onDelivered(json: String) {}
        func onAcked(seqUpTo: UInt64) {}
        func onResetInbound(fromSeq: UInt64, epoch: String) {}
        func requestConnect() {}
        func requestDisconnect() {}
    }

    private func blob(_ payload: Data) -> String? {
        (try? JSONSerialization.jsonObject(with: payload) as? [String: Any])?["blob"] as? String
    }

    func testDrainReturnsOnlyUnackedReplayableCommandsInOrder() {
        let host = Host()
        let link = PulseManager(host: host)
        link.onConnected()
        link.sendEncrypted(blob: "approve-1", keys: [:], target: "T1", replayable: true)
        link.sendEncrypted(blob: "create", keys: [:], target: "T1")                       // not replayable
        link.sendEncrypted(blob: "abort", keys: [:], target: "T1", connectionScoped: true, replayable: true)
        link.sendEncrypted(blob: "input-2", keys: [:], target: "T1", replayable: true)
        let drained = link.drainUnackedReplayable()
        XCTAssertEqual(drained.map { blob($0.payload) }, ["approve-1", "input-2"])
        XCTAssertEqual(drained.map(\.target), ["T1", "T1"])
        XCTAssertTrue(link.drainUnackedReplayable().isEmpty, "drain is one-shot")
    }

    func testReplayableCommandBehindFragmentQueueSurvivesRouteLoss() {
        let host = Host()
        let link = PulseManager(host: host)
        link.acksPromptly = true
        link.onConnected()
        // A large earlier upload fills the 100 KiB Pulse pacing window.
        // The later command is accepted by sendEncrypted but remains in outQueue.
        link.sendEncrypted(blob: String(repeating: "x", count: 256 * 1024), keys: [:], target: "T1", fragment: true)
        XCTAssertGreaterThan(link.queuedForTesting, 0)
        link.sendEncrypted(blob: "approve-queued", keys: [:], target: "T1", replayable: true)
        XCTAssertGreaterThan(link.queuedForTesting, 0)
        let drained = link.drainUnackedReplayable()
        XCTAssertEqual(drained.compactMap { blob($0.payload) }, ["approve-queued"],
                       "teardown discards queued commands not yet admitted to Pulse")
    }

    func testAckedCommandsAreNotReplayed() {
        let host = Host()
        let link = PulseManager(host: host)
        link.onConnected()
        let peer = Endpoint(epoch: "peer", streamId: 0)
        var toLink: [[UInt8]] = []
        func pump(_ effects: [Effect]) { for case .transmit(let b) in effects { toLink.append(b) } }
        pump(peer.onConnected(0))
        link.sendEncrypted(blob: "acked", keys: [:], target: "T1", replayable: true)
        for frame in host.frames { pump(peer.onBytes(Array(Data(base64Encoded: frame)!), 1)) }
        pump(peer.onTick(60_000))
        for bytes in toLink { link.onFrame(Data(bytes).base64EncodedString()) }
        link.sendEncrypted(blob: "pending", keys: [:], target: "T1", replayable: true)
        XCTAssertEqual(link.drainUnackedReplayable().map { blob($0.payload) }, ["pending"])
    }

    @MainActor
    func testReplayableTypesExcludeNonIdempotentAndConnectionScopedCommands() {
        for t in ["create_session", "fork_session", "abort_session", "set_session_subscription", "request_card", "mark_unread"] {
            XCTAssertFalse(AppState.replayableAcrossRoutes.contains(t), t)
        }
        for t in ["send_input", "approve", "deny", "always_allow", "delete_session"] {
            XCTAssertTrue(AppState.replayableAcrossRoutes.contains(t), t)
        }
    }

    func testFragmentedReplayableCommandIsReplayedWholeUntilEveryPartIsAcked() {
        let host = Host()
        let link = PulseManager(host: host)
        link.acksPromptly = true
        link.onConnected()
        let big = String(repeating: "y", count: 256 * 1024)
        link.sendEncrypted(blob: big, keys: [:], target: "T1", fragment: true, replayable: true)
        link.sendEncrypted(blob: "after", keys: [:], target: "T1", replayable: true)
        let drained = link.drainUnackedReplayable()
        // Whole logical commands in order, never isolated fragments.
        XCTAssertEqual(drained.compactMap { blob($0.payload) }, [big, "after"])
    }

    func testFullyAckedQueuedCommandIsForgotten() {
        let host = Host()
        let link = PulseManager(host: host)
        link.onConnected()
        let peer = Endpoint(epoch: "peer", streamId: 0)
        var toLink: [[UInt8]] = []
        func pump(_ effects: [Effect]) { for case .transmit(let b) in effects { toLink.append(b) } }
        pump(peer.onConnected(0))
        link.sendEncrypted(blob: String(repeating: "z", count: 200 * 1024), keys: [:], target: "T1", fragment: true, replayable: true)
        for frame in host.frames { pump(peer.onBytes(Array(Data(base64Encoded: frame)!), 1)) }
        pump(peer.onTick(60_000))
        for bytes in toLink { link.onFrame(Data(bytes).base64EncodedString()) }
        XCTAssertTrue(link.drainUnackedReplayable().isEmpty)
    }
}
