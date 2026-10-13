import CoinfraCrypto
import CryptoKit
import Foundation
import Pulse
import Security
import UserNotifications
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Malicious-relay regressions. Assertions express rejection, including known
/// failures: do not turn them into expected-failure tests or fix product code here.
@MainActor
final class DeviceTrustBoundaryTests: XCTestCase {
    private var app: AppState!
    private var root: URL!
    private var suite: String!
    private let computer = "boundary-computer"
    private let other = "boundary-relay-device"
    private let selfId = "boundary-app"
    private let sid = "boundary-session"
    private var signer: Curve25519.Signing.PrivateKey!
    private var recipient: Curve25519.KeyAgreement.PrivateKey!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-boundary-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        DeviceIdentityKeys.testDirectory = root.appendingPathComponent("identity")
        DeviceIdentityKeys.shared.reset()
        suite = "DeviceTrustBoundary.\(UUID().uuidString)"
        TentacleTrustStore.shared.useDefaults(try XCTUnwrap(UserDefaults(suiteName: suite)))
        DeviceTrustModel.shared.reset()
        #if os(macOS)
        DeviceTrustTesting.localKrakiHome = root.appendingPathComponent("computer-home")
        KeychainManager().activateEphemeralKeys()
        MacNotifications.shared.postHandlerForTesting = { _, _, _ in XCTFail("Unexpected notification") }
        #endif
        signer = Curve25519.Signing.PrivateKey()
        recipient = Curve25519.KeyAgreement.PrivateKey()
        app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite")))
        app.deviceId = selfId
        app.relayURL = "ws://127.0.0.1:4400"
        // RSA belongs solely to this test process (Mac) or dedicated simulator.
        _ = try KeychainManager().getOrCreateEncryptionKey()
    }

    override func tearDown() async throws {
        app.messageRouter?.retireIdentity()
        app.pulseManager?.resetForIdentityChange()
        app = nil
        TentacleTrustStore.shared.reset()
        DeviceTrustModel.shared.reset()
        DeviceIdentityKeys.shared.reset()
        DeviceIdentityKeys.testDirectory = nil
        #if os(macOS)
        DeviceTrustTesting.localKrakiHome = nil
        MacNotifications.shared.postHandlerForTesting = nil
        #endif
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: root)
    }

    private func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    private func pin(paired: Bool = true, via: String = "qr") {
        TentacleTrustStore.shared.update(computer) {
            $0 = TentaclePin(identityKey: DeviceTrustWire.b64url(signer.publicKey.rawRepresentation),
                             encryptionKey: E2EV2.publicKey(recipient), paired: paired,
                             secret: paired ? nil : DeviceTrustWire.b64url(Data(repeating: 7, count: 16)),
                             via: via, pinnedAt: Date())
        }
    }

    private func seedSession(id: String? = nil, archived: Bool = false) throws {
        let digest = try XCTUnwrap(SessionDigest(json: ["id": id ?? sid, "agent": "copilot", "title": "authentic", "state": "idle"]))
        if archived {
            app.sessionStore.archivedSessions[computer] = [digest]
        } else {
            app.sessionStore.upsertSession(digest, deviceId: computer, deviceName: "Pinned computer")
        }
    }

    private func message(_ type: String, device: String? = nil, session: String? = nil, payload: [String: Any] = [:]) -> [String: Any] {
        var object: [String: Any] = ["type": type, "timestamp": ISO8601.now(), "seq": 1, "payload": payload]
        if let device { object["deviceId"] = device }
        if let session { object["sessionId"] = session }
        return object
    }

    /// The relay knows the app's RSA public key and can create this envelope.
    private func legacyEnvelope(_ inner: [String: Any], src: String? = nil) throws -> Data {
        let key = try KeychainManager().getOrCreateEncryptionKey()
        let encrypted = try CryptoManager().encryptToBlob(String(decoding: json(inner), as: UTF8.self),
                                                         recipients: [RecipientKey(deviceId: selfId, publicKey: key.publicKey)])
        var object: [String: Any] = ["type": "unicast", "blob": encrypted.blob, "keys": encrypted.keys]
        if let src { object["src"] = src }
        return try json(object)
    }

    private func signedEnvelope(_ inner: [String: Any], key: Curve25519.Signing.PrivateKey, src: String? = nil) throws -> Data {
        let signed = try DeviceTrustWire.sign(body: String(decoding: json(inner), as: UTF8.self), from: computer, to: selfId, key: key)
        let blob = try E2EV2.encrypt(String(decoding: json(signed), as: UTF8.self),
                                     recipients: [(selfId, E2EV2.publicKey(try DeviceIdentityKeys.shared.agreementKey()))])
        return try json(["v": 2, "blob": blob, "src": src ?? computer])
    }

    /// Production decryption + routing; only rejected envelopes skip routing.
    private func route(_ envelope: Data) throws {
        do {
            let router = try XCTUnwrap(app.messageRouter)
            let clear = try router.encryptionHandler.decryptInbound(envelope)
            router.handleDataMessage(clear.message)
        } catch EncryptionError.untrusted { }
        catch EncryptionError.senderMismatch { }
    }

    /// Capture all production Pulse ciphertexts without the pre-encryption
    /// testOutboundMessageHandler (which would bypass the security code).
    private func outbound() throws -> [[String: Any]] {
        let pulse = try XCTUnwrap(app.pulseManager)
        let live = try XCTUnwrap(Mirror(reflecting: pulse).children.first { $0.label == "live" }?.value as? Endpoint)
        return try live.snapshot().outbox.map {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0.payload)) as? [String: Any])
        }
    }

    private func link(identity: Curve25519.Signing.PrivateKey, encryption: Curve25519.KeyAgreement.PrivateKey) throws -> PairingLink {
        try XCTUnwrap(PairingLink(string: "https://127.0.0.1/?token=boundary&tid=\(computer)&ik=\(DeviceTrustWire.b64url(identity.publicKey.rawRepresentation))&xk=\(E2EV2.publicKey(encryption))&ps=\(DeviceTrustWire.b64url(Data(repeating: 7, count: 16)))"))
    }

    // MARK: Inbound attribution and trust control

    func testRejectsUnsignedPairedAttributionVariants() throws {
        pin()
        try seedSession()
        let variants: [(String?, String?)] = [(computer, nil), (nil, computer), (other, nil), (nil, nil)]
        for (src, claimed) in variants {
            let inner = message("session_title_updated", device: claimed, session: sid, payload: ["title": "forged"])
            try route(legacyEnvelope(inner, src: src))
            XCTAssertEqual(app.sessionStore.sessions[sid]?.title, "authentic", "src=\(src ?? "nil") device=\(claimed ?? "nil")")
        }
        try route(legacyEnvelope(message("session_created", device: computer, session: "forged-new", payload: ["agent": "copilot"])))
        XCTAssertNil(app.sessionStore.sessions["forged-new"])
    }

    func testRejectsUnsignedSessionListEffectsOnPairedSession() throws {
        pin()
        try seedSession()
        let inner = message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "compacting"]]])
        try route(legacyEnvelope(inner, src: other))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer)
        XCTAssertEqual(app.sessionStore.sessions[sid]?.title, "authentic")
        XCTAssertNil(app.messageStore.runtimeStatusBySession[sid], "A foreign list must not change a paired session's runtime status")
    }

    func testForeignSessionListCannotRedirectPairedConversationToRelayKey() throws {
        pin()
        try seedSession()
        let relayKey = try CryptoManager().generateKeyPair()
        let relayPublic = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        // Head can delay the pinned computer's device-list entry and inject its
        // own computer. Cache already knows the paired session's real owner.
        app.messageRouter?.handleRawMessage(try json(["type": "device_joined", "device": ["id": other, "name": "Relay controlled", "role": "tentacle", "kind": "desktop", "online": true, "encryptionKey": relayPublic]]))
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "idle"]]]), src: other))
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", session: sid, payload: ["text": "paired-conversation-secret"])))
        let payload = try XCTUnwrap(outbound().last)
        let clear = try? CryptoManager().decryptFromBlob(CryptoBlobPayload(blob: payload["blob"] as? String ?? "", keys: payload["keys"] as? [String: String] ?? [:]), deviceId: other, privateKey: relayKey.privateKey)
        XCTAssertNil(clear, "Head decrypted outbound paired conversation: \(clear ?? "")")
    }

    func testRejectsUnsignedSessionListRuntimeEffectsWhenOwnerIsInDeviceList() throws {
        pin()
        app.deviceStore.devices[computer] = DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, online: false)
        try seedSession()
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "state": "compacting"]]]), src: other))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer)
        XCTAssertNil(app.messageStore.runtimeStatusBySession[sid])
    }

    func testRejectsUnsignedSessionListBeforeSessionOwnershipLoads() throws {
        pin()
        XCTAssertTrue(app.deviceStore.devices.isEmpty)
        XCTAssertTrue(app.sessionStore.sessions.isEmpty)
        try route(legacyEnvelope(message("session_list", device: other, payload: ["sessions": [["id": sid, "title": "forged", "state": "idle"]]]), src: other))
        // The real signed list arrives later, after the forged ownership claim.
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "authentic", "state": "idle"]]]), key: signer))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer, "Unauthenticated prepopulation must not block the pinned owner's signed snapshot")
        XCTAssertEqual(app.sessionStore.sessions[sid]?.title, "authentic")
    }

    func testRejectsUnsignedNewSessionBeforeSignedOwnershipArrives() throws {
        pin()
        try route(legacyEnvelope(message("session_created", device: other, session: sid, payload: ["agent": "copilot"]), src: other))
        try route(signedEnvelope(message("session_list", device: computer, payload: ["sessions": [["id": sid, "title": "authentic", "state": "idle"]]]), key: signer))
        XCTAssertEqual(app.sessionStore.sessions[sid]?.deviceId, computer)
        XCTAssertEqual(app.sessionStore.sessions[sid]?.title, "authentic")
    }

    func testRejectsUnsignedArchivedSessionAttribution() throws {
        pin()
        try seedSession(archived: true)
        try route(legacyEnvelope(message("session_created", device: other, session: sid, payload: ["agent": "copilot"]), src: other))
        XCTAssertNil(app.sessionStore.sessions[sid])
        XCTAssertEqual(app.sessionStore.archivedSessionInfo(sid)?.deviceId, computer)
    }

    func testRejectsUnsignedAttachmentForPairedSession() async throws {
        pin()
        try seedSession()
        let id = SHA256.hash(data: Data("forged".utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
        try route(legacyEnvelope(message("attachment_data", session: sid, payload: ["id": id, "mimeType": "text/plain", "data": Data("forged".utf8).base64EncodedString(), "index": 0, "total": 1]), src: other))
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(app.attachmentStore.state(for: id))
    }

    func testRejectsUnsignedAttachmentClaimingLegacySessionForPairedContent() async throws {
        pin()
        try seedSession()
        let legacyDigest = try XCTUnwrap(SessionDigest(json: ["id": "legacy-session", "state": "idle"]))
        app.sessionStore.upsertSession(legacyDigest, deviceId: other, deviceName: "Legacy")
        // attachment_data is keyed globally by id, not by envelope sessionId.
        let id = SHA256.hash(data: Data("authentic".utf8)).map { String(format: "%02x", $0) }.joined().prefix(32).description
        app.attachmentStore.requestIfNeeded(id: id, sessionId: sid, priority: .userOpened)
        try route(legacyEnvelope(message("attachment_data", session: "legacy-session", payload: ["id": id, "mimeType": "text/plain", "data": Data("forged".utf8).base64EncodedString(), "index": 0, "total": 1]), src: other))
        try await Task.sleep(nanoseconds: 50_000_000)
        if case .ready? = app.attachmentStore.state(for: id) { XCTFail("Unsigned foreign-session bytes completed a paired session's attachment") }
    }

    func testRejectsUnsignedBatchesWithPayloadOnlySessionId() throws {
        pin()
        try seedSession()
        for type in ["session_replay_batch", "session_messages_batch"] {
            let seq = type == "session_replay_batch" ? 41 : 42
            let row = message("agent_message", device: computer, session: sid, payload: ["content": "forged-batch"])
                .merging(["seq": seq]) { _, new in new }
            let inner = message(type, device: other, payload: ["sessionId": sid, "messages": [row], "firstSeq": seq, "lastSeq": seq, "totalLastSeq": seq, "containsHead": true])
            try route(legacyEnvelope(inner, src: other))
            XCTAssertFalse(app.messageDatabase.messagesAfter(sid, afterSeq: 0, limit: 100).contains { $0.content == "forged-batch" }, type)
        }
    }

    func testRejectsUnsignedTrustControlsForPairedComputer() throws {
        for type in ["pair_result", "trust_required", "trusted_devices"] {
            pin()
            let before = TentacleTrustStore.shared.pin(computer)
            let inner = message(type, device: computer, payload: ["ok": false, "reason": "trust_required", "enforced": false, "devices": []])
            try route(legacyEnvelope(inner, src: computer))
            try route(signedEnvelope(inner, key: Curve25519.Signing.PrivateKey()))
            XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before, type)
            XCTAssertNil(app.deviceTrust.info[computer])
        }
    }

    func testRejectsUnsignedTrustControlsDuringPairing() throws {
        pin(paired: false)
        let before = TentacleTrustStore.shared.pin(computer)
        try route(legacyEnvelope(message("pair_result", device: computer, payload: ["ok": true, "enforced": true]), src: computer))
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before, "Pinning must already require a signature before pair confirmation")
    }

    func testRejectsUnsignedTrustRequiredAfterSignedDowngrade() throws {
        pin()
        try route(signedEnvelope(message("trust_required", device: computer), key: signer))
        let before = TentacleTrustStore.shared.pin(computer)
        try route(legacyEnvelope(message("pair_result", device: computer, payload: ["ok": true]), src: computer))
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before)
    }

    func testRawHeadControlCannotRouteTrustControls() throws {
        pin()
        let before = TentacleTrustStore.shared.pin(computer)
        for type in ["pair_result", "trust_required", "trusted_devices"] {
            let inner = message(type, device: computer, payload: ["ok": false, "enforced": false])
            app.messageRouter?.handleRawMessage(try json(inner))
            app.onDelivered(json: String(decoding: try json(["from": "@head", "msg": inner]), as: UTF8.self))
        }
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before)
    }

    // MARK: Outbound pinning

    func testOutboundUsesPinnedKeyEvenBeforeConfirmationAndAfterRelayKeySwap() throws {
        let relayKey = try CryptoManager().generateKeyPair()
        let reported = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        for paired in [false, true] {
            pin(paired: paired)
            app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Computer", role: .tentacle, kind: .desktop, encryptionKey: reported, online: false)])
            app.pulseManager?.resetForIdentityChange()
            XCTAssertTrue(app.sendEncryptedMessage(message("send_input", session: nil, payload: ["text": "secret"]), routingTarget: computer))
            let payload = try XCTUnwrap(outbound().last)
            XCTAssertEqual(payload["v"] as? Int, 2)
            XCTAssertNil(payload["keys"])
            let plaintext = try XCTUnwrap(E2EV2.decrypt(try XCTUnwrap(payload["blob"] as? String), deviceId: computer, privateKey: recipient))
            XCTAssertTrue(plaintext.contains("secret"))
            XCTAssertNil(try? CryptoManager().decryptFromBlob(CryptoBlobPayload(blob: payload["blob"] as? String ?? "", keys: payload["keys"] as? [String: String] ?? [:]), deviceId: computer, privateKey: relayKey.privateKey))
        }
    }

    func testHeadRemoveAndReaddCannotReplaceTrustPin() throws {
        pin()
        let before = TentacleTrustStore.shared.pin(computer)
        app.messageRouter?.handleRawMessage(try json(["type": "device_removed", "deviceId": computer]))
        let relayKey = try CryptoManager().generateKeyPair()
        let relayPublic = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.messageRouter?.handleRawMessage(try json(["type": "device_joined", "device": ["id": computer, "name": "Readded", "role": "tentacle", "kind": "desktop", "online": false, "encryptionKey": relayPublic]]))
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before)
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", payload: ["text": "secret"]), routingTarget: computer))
        XCTAssertEqual(try outbound().last?["v"] as? Int, 2)
    }

    func testMixedBroadcastNeverGivesPinnedComputersRelayKeys() throws {
        pin()
        let relayKey = try CryptoManager().generateKeyPair()
        let reported = try CryptoManager().exportPublicKeySPKI(relayKey.publicKey)
        app.deviceStore.setDevices([
            DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: reported, online: false),
            DeviceSummary(id: other, name: "Legacy", role: .tentacle, kind: .desktop, encryptionKey: reported, online: false),
        ])
        XCTAssertTrue(app.sendEncryptedMessage(message("request_sessions")))
        let payloads = try outbound()
        XCTAssertEqual(payloads.count, 2)
        let trusted = try XCTUnwrap(payloads.first { $0["v"] as? Int == 2 })
        let legacy = try XCTUnwrap(payloads.first { $0["keys"] != nil })
        XCTAssertNotNil(try E2EV2.decrypt(try XCTUnwrap(trusted["blob"] as? String), deviceId: computer, privateKey: recipient))
        XCTAssertNil(try E2EV2.decrypt(try XCTUnwrap(trusted["blob"] as? String), deviceId: other, privateKey: Curve25519.KeyAgreement.PrivateKey()))
        XCTAssertEqual(Set((legacy["keys"] as? [String: String] ?? [:]).keys), [other])
    }

    func testLegacyKeyPinsCannotOverrideTrustPin() throws {
        pin()
        let first = try CryptoManager().generateKeyPair()
        let second = try CryptoManager().generateKeyPair()
        let firstPub = try CryptoManager().exportPublicKeySPKI(first.publicKey)
        let secondPub = try CryptoManager().exportPublicKeySPKI(second.publicKey)
        app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: firstPub, online: false)])
        app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Pinned", role: .tentacle, kind: .desktop, encryptionKey: secondPub, online: false)])
        XCTAssertTrue(app.deviceStore.keyMismatchDeviceIds.contains(computer))
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", payload: ["text": "secret"]), routingTarget: computer))
        let payload = try XCTUnwrap(outbound().last)
        XCTAssertEqual(payload["v"] as? Int, 2)
        XCTAssertNotNil(try E2EV2.decrypt(try XCTUnwrap(payload["blob"] as? String), deviceId: computer, privateKey: recipient))
    }

    func testPairingLinkKeyChangeRequiresConfirmationForPairedComputer() throws {
        pin()
        let before = TentacleTrustStore.shared.pin(computer)
        let changed = try link(identity: Curve25519.Signing.PrivateKey(), encryption: Curve25519.KeyAgreement.PrivateKey())
        XCTAssertTrue(app.pairingLinkChangesKey(changed))
        app.openPairingLink(changed)
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before)
        guard case .replaceComputerKey? = app.pendingPairingPrompt else { return XCTFail("Missing key-change prompt") }
        app.openPairingLink(changed, keyChangeConfirmed: true)
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer)?.identityKey, changed.trust?.identityKey)
    }

    func testOpenedLinkCannotReplacePendingOrFailedPinWithoutConfirmation() throws {
        for failed in [false, true] {
            pin(paired: false)
            if failed { TentacleTrustStore.shared.update(computer) { $0?.lastError = "trust_required" } }
            let before = TentacleTrustStore.shared.pin(computer)
            let changed = try link(identity: Curve25519.Signing.PrivateKey(), encryption: Curve25519.KeyAgreement.PrivateKey())
            app.openPairingLink(changed)
            XCTAssertEqual(TentacleTrustStore.shared.pin(computer), before, "A pin is authoritative even while pairing or refused")
            guard case .replaceComputerKey? = app.pendingPairingPrompt else { XCTFail("Missing key-change prompt"); continue }
        }
    }

    func testUnknownSessionDoesNotBroadcastConfidentialInput() throws {
        pin()
        XCTAssertFalse(app.sendEncryptedMessage(message("send_input", session: "unknown", payload: ["text": "secret"])))
        XCTAssertTrue(try outbound().isEmpty)
    }

    #if os(macOS)
    func testSameMacEnrollmentUsesLocalFilesNotRelayKeys() throws {
        let home = try XCTUnwrap(DeviceTrustTesting.localKrakiHome)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("keys"), withIntermediateDirectories: true)
        try Data(computer.utf8).write(to: home.appendingPathComponent("device-id"))
        try json(["identityKey": DeviceTrustWire.b64url(signer.publicKey.rawRepresentation), "encryptionKey": E2EV2.publicKey(recipient)]).write(to: home.appendingPathComponent("keys/public-identity.json"))
        app.deviceStore.devices[computer] = DeviceSummary(id: computer, name: "Local", role: .tentacle, kind: .desktop, encryptionKey: "relay-key", online: false)
        app.pinLocalTentacleIfNeeded()
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer)?.encryptionKey, E2EV2.publicKey(recipient))
        XCTAssertEqual(TentacleTrustStore.shared.pin(computer)?.via, "local")
        let file = home.appendingPathComponent("trust/local-enroll/\(selfId).json")
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let enrollment = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(enrollment["identityKey"] as? String, DeviceIdentityKeys.shared.identityPublicKey)
        let linkClient = LocalLinkClient(appState: app)
        XCTAssertFalse(linkClient.sendEncryptedPayload(["v": 2, "blob": "unused"], to: computer, connectionScoped: false, replayable: true))
        XCTAssertTrue(app.sendEncryptedMessage(message("send_input", payload: ["text": "secret"]), routingTarget: computer))
        XCTAssertEqual(try outbound().last?["v"] as? Int, 2, "Fallback from an unavailable local link must remain pinned")
    }
    #endif

    // MARK: Push previews (real NSE source is compiled into the iOS tests)

    private func push(key: Curve25519.Signing.PrivateKey, to: String? = nil, age: TimeInterval = 0) throws -> String {
        let body = String(decoding: try json(["nid": UUID().uuidString, "sessionId": sid, "type": "question", "title": "Pinned session", "summary": "forged preview"]), as: UTF8.self)
        let signed = try DeviceTrustWire.sign(body: body, from: computer, to: to ?? selfId, key: key, ts: Int64(Date().addingTimeInterval(-age).timeIntervalSince1970 * 1000))
        let blob = try E2EV2.encrypt(String(decoding: json(signed), as: UTF8.self), recipients: [(selfId, E2EV2.publicKey(try DeviceIdentityKeys.shared.agreementKey()))])
        return DeviceTrustPush.prefix + blob
    }

    func testV2PushRejectsWrongSignerStaleAndWrongRecipient() throws {
        pin()
        let agreement = try DeviceIdentityKeys.shared.agreementKey()
        XCTAssertNoThrow(try DeviceTrustPush.open(key: push(key: signer), selfId: selfId, agreementKey: agreement))
        for invalid in [try push(key: Curve25519.Signing.PrivateKey()), try push(key: signer, age: 25 * 3600), try push(key: signer, to: other)] {
            XCTAssertThrowsError(try DeviceTrustPush.open(key: invalid, selfId: selfId, agreementKey: agreement))
        }
    }

    #if os(iOS)
    private func notification(blob: String, key: String) throws -> UNNotificationContent {
        let content = UNMutableNotificationContent()
        content.title = "Kraki"
        content.body = "Needs attention"
        content.userInfo = ["kraki": ["blob": blob, "key": key]]
        let service = NotificationService()
        var output: UNNotificationContent?
        service.didReceive(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { output = $0 }
        return try XCTUnwrap(output)
    }

    func testNotificationServiceRejectsInvalidV2Previews() throws {
        pin()
        let defaults = DeviceTrustDefaults.shared
        let saved = defaults.object(forKey: "kraki.deviceId")
        defaults.set(selfId, forKey: "kraki.deviceId")
        defer { if let saved { defaults.set(saved, forKey: "kraki.deviceId") } else { defaults.removeObject(forKey: "kraki.deviceId") } }
        XCTAssertEqual(try notification(blob: "", key: push(key: signer)).body, "Question: forged preview")
        for invalid in [try push(key: Curve25519.Signing.PrivateKey()), try push(key: signer, age: 25 * 3600), try push(key: signer, to: other)] {
            XCTAssertEqual(try notification(blob: "", key: invalid).body, "Open Kraki to view the update.")
        }
    }

    func testNotificationServiceRejectsLegacyForgeryForPairedSession() throws {
        pin()
        try seedSession()
        let inner: [String: Any] = ["nid": UUID().uuidString, "sessionId": sid, "type": "question", "title": "Pinned session", "summary": "forged preview"]
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: legacyEnvelope(inner)) as? [String: Any])
        let key = try XCTUnwrap((envelope["keys"] as? [String: String])?[selfId])
        XCTAssertEqual(try notification(blob: try XCTUnwrap(envelope["blob"] as? String), key: key).body, "Open Kraki to view the update.", "The relay can construct RSA ciphertext but cannot sign as the paired computer")
    }
    #else
    func testMacRouterRejectsInvalidV2PushPreviews() async throws {
        pin()
        var posts = 0
        MacNotifications.shared.postHandlerForTesting = { _, _, _ in posts += 1 }
        for invalid in [try push(key: Curve25519.Signing.PrivateKey()), try push(key: signer, age: 25 * 3600), try push(key: signer, to: other)] {
            app.messageRouter?.handleRawMessage(try json(["type": "notification_preview", "payload": ["blob": "", "key": invalid]]))
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(posts, 0)
    }

    func testMacRejectsLegacyPreviewForKnownPairedSession() async throws {
        pin()
        try seedSession()
        var posts = 0
        MacNotifications.shared.postHandlerForTesting = { _, _, _ in posts += 1 }
        let inner: [String: Any] = ["nid": UUID().uuidString, "sessionId": sid, "type": "question", "summary": "forged preview"]
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: legacyEnvelope(inner)) as? [String: Any])
        let blob = try XCTUnwrap(envelope["blob"] as? String)
        let key = try XCTUnwrap((envelope["keys"] as? [String: String])?[selfId])
        app.messageRouter?.handleRawMessage(try json(["type": "notification_preview", "payload": ["blob": blob, "key": key]]))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(posts, 0)
    }

    func testMacRejectsLegacyPreviewForArchivedPairedSession() async throws {
        pin()
        try seedSession(archived: true)
        var posts = 0
        MacNotifications.shared.postHandlerForTesting = { _, _, _ in posts += 1 }
        let inner: [String: Any] = ["nid": UUID().uuidString, "sessionId": sid, "type": "question", "summary": "forged preview"]
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: legacyEnvelope(inner)) as? [String: Any])
        let blob = try XCTUnwrap(envelope["blob"] as? String)
        let key = try XCTUnwrap((envelope["keys"] as? [String: String])?[selfId])
        app.messageRouter?.handleRawMessage(try json(["type": "notification_preview", "payload": ["blob": blob, "key": key]]))
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(posts, 0, "Archived ownership must be checked before presenting legacy text")
    }
    #endif

    // MARK: Identity lifecycle and storage

    func testLogoutClearsPinsKeysAndRetiresOldRouter() throws {
        pin()
        try seedSession()
        let oldKey = try DeviceIdentityKeys.shared.signingKey().rawRepresentation
        let oldRouter = try XCTUnwrap(app.messageRouter)
        _ = app.sendEncryptedMessage(message("send_input", session: sid, payload: ["text": "secret"]))
        app.logout()
        XCTAssertTrue(TentacleTrustStore.shared.all.isEmpty)
        XCTAssertNil(DeviceIdentityKeys.shared.existingAgreementKey())
        XCTAssertNil(app.deviceId)
        XCTAssertTrue(try outbound().isEmpty)
        app.deviceId = "new-sign-in"
        oldRouter.handleDataMessage(try json(message("session_created", device: computer, session: sid)))
        XCTAssertTrue(app.sessionStore.sessions.isEmpty)
        XCTAssertNotEqual(try DeviceIdentityKeys.shared.signingKey().rawRepresentation, oldKey)
    }

    func testIdentityFilesArePrivateAndSurviveRelaunch() throws {
        let identity = DeviceIdentityKeys()
        let oldSigning = try identity.signingKey().rawRepresentation
        let oldAgreement = try identity.agreementKey().rawRepresentation
        for name in ["identity-ed25519", "e2e-x25519"] {
            let path = try XCTUnwrap(DeviceIdentityKeys.testDirectory).appendingPathComponent(name).path
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
        let relaunched = DeviceIdentityKeys()
        XCTAssertEqual(try relaunched.signingKey().rawRepresentation, oldSigning)
        XCTAssertEqual(try relaunched.agreementKey().rawRepresentation, oldAgreement)
        let reloadedStore = TentacleTrustStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        pin()
        let restoredStore = TentacleTrustStore(defaults: try XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertTrue(reloadedStore.all.isEmpty)
        XCTAssertEqual(restoredStore.pin(computer), TentacleTrustStore.shared.pin(computer))
    }

    #if os(iOS)
    func testIOSIdentityKeychainAccessibilityAndReinstallPersistence() throws {
        // Safe only on this lane's disposable simulator. No real-device keys.
        let testDirectory = DeviceIdentityKeys.testDirectory
        DeviceIdentityKeys.testDirectory = nil
        let installed = DeviceIdentityKeys()
        installed.reset()
        defer { installed.reset(); DeviceIdentityKeys.testDirectory = testDirectory }
        let before = try installed.signingKey().rawRepresentation
        _ = try installed.agreementKey()
        for name in ["identity-ed25519", "e2e-x25519"] {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "chat.kraki.device-trust", kSecAttrAccount as String: name, kSecReturnAttributes as String: true]
            var result: CFTypeRef?
            XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
            let attrs = try XCTUnwrap(result as? [String: Any])
            XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlock as String)
        }
        // Deleting app defaults (as on reinstall) doesn't delete Keychain keys.
        TentacleTrustStore.shared.reset()
        XCTAssertEqual(try DeviceIdentityKeys().signingKey().rawRepresentation, before)
    }
    #endif
}
