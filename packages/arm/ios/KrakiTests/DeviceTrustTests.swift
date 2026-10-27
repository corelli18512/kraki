import CoinfraCrypto
import CryptoKit
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Device trust (Core/Crypto/DeviceTrust.swift): byte compatibility with
/// packages/crypto (trust.ts, v2.ts) and the receive-side rules.
final class DeviceTrustTests: XCTestCase {
    private var store: TentacleTrustStore!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "DeviceTrustTests.\(UUID().uuidString)"
        store = TentacleTrustStore(defaults: UserDefaults(suiteName: suite) ?? .standard)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    // MARK: Interop with Node

    /// packages/crypto/src/__tests__/fixtures/trust-vectors.json
    private enum NodeVectors {
        static let identityPublic = "VI6kW5LKN2T2X_HPihByByPM7PvjpDCRK-dDSA3o18M"
        static let signed: [String: Any] = [
            "ks": 1, "from": "dev_app", "to": "dev_tentacle", "ts": Int64(1760000000123),
            "nonce": "AAECAwQFBgcICQoLDA0ODw",
            "body": #"{"type":"send_input","sessionId":"s1","payload":{"text":"héllo ✓ \"quoted\"\nline"}}"#,
            "sig": "PU_uNnSS75wCIOwX2MdxHzEGmdwZoRbXMqspY6LaGPRa3692GtuKPdzo_rSwOR7_Bze2HGjC6VEXlv0k9IMQAg",
        ]
        static let secret = "5JHuX0U7LWjbxz0KSFNFmA"
        static let proof = "ZYREy6js-mrojiRIIRePZ7tzKSYBi8y2_qFWOcWqN-o"
        static let safetyCode = "4254 2974 6431"
        /// Signed by the identity above for dev_alpha (E2EV2NodeVectors), ts below.
        static let pushKey = "v2.wB8BAQzeR10WquyBckCJEHUAAAFK8_BE803_SImwR_us8kUD6Ctl3II_gE-dqNZv-fOT3W2xafE7CTo4cdk5zsFcDe3aLHcMfD5d5YLHhvJYA01TSKQJdxfIG8C9Jmz1yS8NgAPlERdzIZW5kV9gs4VmOK_jiwRgl9XxBW6bcqkgdWOF1F8MQIxM5KJM4nrNd3ZHvjr0i6_dCihfBFE0DpLB-kKhtlxA1_ONz-vkKGtEq1SK6YwNssvv5NQgM2SwAe4znBJga7AzPrY-XrnrpwQ2EIu0hswmzPhf_hugspWXaxpEMaCp-sLHLrz7BAn6OX2Z471EX0xPgNImP1UEo1DDLWD1eRi2_wy7RPPv1eRGDAqHF_eeU8iJl8fQq6mDKJ6ihAtJ3Fm5E1xyAXkVF0yLULJdZzDgWrvNJ7z_RG39zABY8-p7W6ifoeBgJiclh8i7HBmc6A8TMnhoNcQ8AAEACWRldl9hbHBoYQAgf-PY3MVWzoNtwtmGF63o4AEkvEmDCIKsfFaJaK3ZWk4APCWm-WxTLnq_LeApQtQ9-JcY9qU8kZQtaHRVF-e43rhtaD-mD00v9PKO6dkgIocKrTsTSlEHh8D-J9zpMw"
        static let pushPreview = #"{"nid":"n1","type":"question","summary":"Proceed? ✓","sessionId":"s1","title":"Fix bug"}"#
        static let pushTs: Int64 = 1760000000999
    }

    func testSafetyCodeMatchesNode() {
        XCTAssertEqual(DeviceTrustWire.safetyCode(NodeVectors.identityPublic), NodeVectors.safetyCode)
        XCTAssertNil(DeviceTrustWire.safetyCode("short"))
    }

    func testOpensNodePushPreviewOnlyFromThePinnedComputer() throws {
        let alpha = E2EV2NodeVectors.recipients[0]
        let key = try CoinfraCrypto.importEncryptionPrivateKey(alpha.privateKey)
        let at = Date(timeIntervalSince1970: Double(NodeVectors.pushTs) / 1000 + 60)
        // Not pinned: refused.
        XCTAssertThrowsError(try DeviceTrustPush.open(key: NodeVectors.pushKey, selfId: alpha.id, agreementKey: key, store: store, now: at))
        store.update("dev_tentacle") { pin in
            pin = TentaclePin(identityKey: NodeVectors.identityPublic, encryptionKey: alpha.publicKey,
                              paired: true, secret: nil, via: "qr", pinnedAt: Date())
        }
        XCTAssertEqual(try DeviceTrustPush.open(key: NodeVectors.pushKey, selfId: alpha.id, agreementKey: key, store: store, now: at),
                       NodeVectors.pushPreview)
        // A replay a day later is refused.
        XCTAssertThrowsError(try DeviceTrustPush.open(key: NodeVectors.pushKey, selfId: alpha.id, agreementKey: key, store: store,
                                                      now: at.addingTimeInterval(25 * 3600)))
        // Pinned under another key (the relay's): refused.
        pin("dev_tentacle", key: Curve25519.Signing.PrivateKey())
        XCTAssertThrowsError(try DeviceTrustPush.open(key: NodeVectors.pushKey, selfId: alpha.id, agreementKey: key, store: store, now: at))
    }

    func testTrustRequiredHintFromAnUnpinnedComputerOnly() throws {
        let computer = Curve25519.Signing.PrivateKey()
        let hint = try signed(["type": "trust_required", "deviceId": "dev_new"], from: "dev_new", key: computer)
        let out = try XCTUnwrap(check(hint, src: "dev_new"))
        XCTAssertTrue(out.contains("trust_required"))
        // Anything else from an unpinned signer is refused.
        XCTAssertNil(check(try signed(["type": "session_list", "deviceId": "dev_new"], from: "dev_new", key: computer), src: "dev_new"))
        // A paired computer's trust_required must carry its pinned signature.
        pin("dev_t", key: Curve25519.Signing.PrivateKey())
        XCTAssertNil(check(try signed(["type": "trust_required", "deviceId": "dev_t"], from: "dev_t", key: computer), src: "dev_t"))
    }

    func testVerifiesNodeSignature() throws {
        let m = try XCTUnwrap(DeviceTrustWire.parseSigned(NodeVectors.signed))
        XCTAssertTrue(DeviceTrustWire.verify(m, publicKey: NodeVectors.identityPublic))
        var tampered = NodeVectors.signed
        tampered["body"] = #"{"type":"send_input","sessionId":"s1","payload":{"text":"rm -rf ~"}}"#
        XCTAssertFalse(DeviceTrustWire.verify(try XCTUnwrap(DeviceTrustWire.parseSigned(tampered)), publicKey: NodeVectors.identityPublic))
    }

    func testPairingProofMatchesNode() {
        XCTAssertEqual(DeviceTrustWire.pairingProof(
            secret: NodeVectors.secret, tentacleId: "dev_tentacle", appId: "dev_app",
            identityKey: NodeVectors.identityPublic, encryptionKey: "L2nMbr7SmWq1ZKhZ0GYJ3fSc9g0JzE8VgCjOFXzQ_Gs",
            rsaKey: "MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA", ts: 1760000000456
        ), NodeVectors.proof)
    }

    /// Tentacle-side (node:crypto) X25519 envelopes open here.
    func testOpensNodeX25519Vectors() throws {
        for blob in E2EV2NodeVectors.blobs {
            for r in E2EV2NodeVectors.recipients {
                let key = try CoinfraCrypto.importEncryptionPrivateKey(r.privateKey)
                XCTAssertEqual(E2EV2.publicKey(key), r.publicKey)
                XCTAssertEqual(try E2EV2.decrypt(blob.blob, deviceId: r.id, privateKey: key), blob.plaintext)
            }
            XCTAssertNil(try E2EV2.decrypt(blob.blob, deviceId: "someone_else", privateKey: Curve25519.KeyAgreement.PrivateKey()))
        }
    }

    // MARK: Signing

    func testSignVerifyRoundTrip() throws {
        let key = Curve25519.Signing.PrivateKey()
        let pub = DeviceTrustWire.b64url(key.publicKey.rawRepresentation)
        let object = try DeviceTrustWire.sign(body: #"{"type":"x"}"#, from: "a", to: "b", key: key)
        let data = try JSONSerialization.data(withJSONObject: object)
        let parsed = try XCTUnwrap(DeviceTrustWire.parseSigned(try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])))
        XCTAssertTrue(DeviceTrustWire.verify(parsed, publicKey: pub))
        XCTAssertFalse(DeviceTrustWire.verify(parsed, publicKey: DeviceTrustWire.b64url(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)))
    }

    // MARK: Receive-side rules

    private func pin(_ id: String, key: Curve25519.Signing.PrivateKey, paired: Bool = true) {
        store.update(id) { pin in
            pin = TentaclePin(identityKey: DeviceTrustWire.b64url(key.publicKey.rawRepresentation),
                              encryptionKey: DeviceTrustWire.b64url(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation),
                              paired: paired, secret: nil, via: "qr", pinnedAt: Date())
        }
    }

    private func signed(_ inner: [String: Any], from: String, to: String = "me", key: Curve25519.Signing.PrivateKey) throws -> String {
        let body = String(decoding: try JSONSerialization.data(withJSONObject: inner), as: UTF8.self)
        let object = try DeviceTrustWire.sign(body: body, from: from, to: to, key: key)
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    private func check(_ plaintext: String, src: String?) -> String? {
        switch DeviceTrustInbound.check(plaintext: plaintext, src: src, selfId: "me", store: store) {
        case .message(let data): return String(decoding: data, as: UTF8.self)
        case .rejected: return nil
        }
    }

    /// Head auth_challenge nonces are 32 random bytes in lowercase hex; the
    /// same RSA key signs local-link proofs, so nothing else is signed.
    func testOnlyHeadAuthNoncesAreSigned() {
        XCTAssertTrue(AuthManager.isHeadAuthNonce(String(repeating: "a1", count: 32)))
        XCTAssertTrue(AuthManager.isHeadAuthNonce("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"))
        for other in [
            "kraki-local-link/v1/app\nabc\ndev_t\ndev_app",
            "kraki-diag-v1\nPOST\n/api/diag/v1/batch\ndev_app\n1760000000000\nreq\n" + String(repeating: "ab", count: 32),
            String(repeating: "A1", count: 32),
            String(repeating: "a1", count: 31),
            String(repeating: "a1", count: 32) + "\n",
            String(repeating: "é", count: 64),
            "",
        ] {
            XCTAssertFalse(AuthManager.isHeadAuthNonce(other), other)
        }
    }

    /// Computer→app replay: an exact repeat of an accepted signed message is
    /// dropped; a late one (Pulse store-and-forward) still arrives.
    func testReplayGuardDropsExactRepeatsButNotLateMessages() throws {
        let computer = Curve25519.Signing.PrivateKey()
        pin("dev_t", key: computer)
        let guardian = DeviceTrustReplayGuard()
        func checked(_ plaintext: String) -> String? {
            switch DeviceTrustInbound.check(plaintext: plaintext, src: "dev_t", selfId: "me", store: store, replayGuard: guardian) {
            case .message(let data): return String(decoding: data, as: UTF8.self)
            case .rejected: return nil
            }
        }
        let msg: [String: Any] = ["type": "permission", "deviceId": "dev_t", "sessionId": "s"]
        let once = try signed(msg, from: "dev_t", key: computer)
        XCTAssertNotNil(checked(once))
        XCTAssertNil(checked(once), "exact repeat is a replay")
        // Same content, new signature: a new message.
        XCTAssertNotNil(checked(try signed(msg, from: "dev_t", key: computer)))
        // Signed hours ago (app was offline): still accepted.
        let body = String(decoding: try JSONSerialization.data(withJSONObject: msg), as: UTF8.self)
        let old = try DeviceTrustWire.sign(body: body, from: "dev_t", to: "me", key: computer,
                                           ts: Int64(Date().addingTimeInterval(-6 * 3600).timeIntervalSince1970 * 1000))
        XCTAssertNotNil(checked(String(decoding: try JSONSerialization.data(withJSONObject: old), as: UTF8.self)))
        // A forged repeat (bad signature) never reaches the guard.
        XCTAssertNil(checked(try signed(msg, from: "dev_t", key: Curve25519.Signing.PrivateKey())))
    }

    func testReplayGuardForgetsOldestBeyondCapacity() {
        let guardian = DeviceTrustReplayGuard()
        XCTAssertTrue(guardian.accept(from: "t", nonce: "first"))
        for i in 0..<DeviceTrustReplayGuard.capacity { XCTAssertTrue(guardian.accept(from: "t", nonce: "n\(i)")) }
        XCTAssertTrue(guardian.accept(from: "t", nonce: "first"), "oldest forgotten")
        XCTAssertFalse(guardian.accept(from: "t", nonce: "n\(DeviceTrustReplayGuard.capacity - 1)"))
        XCTAssertTrue(guardian.accept(from: "other", nonce: "first"), "keyed by signer")
    }

    func testAcceptsOnlyThePinnedSigner() throws {
        let computer = Curve25519.Signing.PrivateKey()
        pin("dev_t", key: computer)
        let msg: [String: Any] = ["type": "agent_message", "deviceId": "dev_t", "sessionId": "s"]
        XCTAssertNotNil(check(try signed(msg, from: "dev_t", key: computer), src: "dev_t"))
        // The relay's own key, a re-stamped sender, another recipient.
        XCTAssertNil(check(try signed(msg, from: "dev_t", key: Curve25519.Signing.PrivateKey()), src: "dev_t"))
        XCTAssertNil(check(try signed(msg, from: "dev_t", key: computer), src: "dev_other"))
        XCTAssertNil(check(try signed(msg, from: "dev_t", to: "someone", key: computer), src: "dev_t"))
        XCTAssertNotNil(check(try signed(msg, from: "dev_t", to: DeviceTrustWire.anyRecipient, key: computer), src: "dev_t"))
        // Signed by a computer we never pinned.
        XCTAssertNil(check(try signed(msg, from: "dev_unknown", key: Curve25519.Signing.PrivateKey()), src: "dev_unknown"))
    }

    func testUnsignedFromAPairedComputerIsForged() throws {
        pin("dev_t", key: Curve25519.Signing.PrivateKey())
        let forged = #"{"type":"agent_message","deviceId":"dev_t","sessionId":"s"}"#
        XCTAssertNil(check(forged, src: "dev_t"))
        XCTAssertNil(check(forged, src: "dev_legacy"))
        // A legacy (unpaired) computer still works, marked for the session check.
        let legacy = try XCTUnwrap(check(#"{"type":"agent_message","deviceId":"dev_legacy","sessionId":"s"}"#, src: "dev_legacy"))
        XCTAssertTrue(legacy.contains(DeviceTrustInbound.unsignedKey))
    }

    func testNoPinnedComputersMeansLegacyBehaviour() throws {
        let out = try XCTUnwrap(check(#"{"type":"agent_message","deviceId":"dev_legacy"}"#, src: "dev_legacy"))
        XCTAssertTrue(out.contains("dev_legacy"))
        XCTAssertTrue(out.contains(DeviceTrustInbound.unsignedKey))
    }

    /// REV-01: protection starts at pinning, before the computer confirms.
    func testPendingPinRejectsUnsignedImpersonation() {
        pin("dev_t", key: Curve25519.Signing.PrivateKey(), paired: false)
        XCTAssertNil(check(#"{"type":"pair_result","deviceId":"dev_t","payload":{"ok":true}}"#, src: "dev_t"))
        XCTAssertNil(check(#"{"type":"agent_message","deviceId":"dev_t","sessionId":"s"}"#, src: "dev_other"))
        // Unattributed unsigned traffic can't be told apart from the pinned computer.
        XCTAssertNil(check(#"{"type":"session_list","payload":{"sessions":[]}}"#, src: nil))
    }

    /// Signed messages carry their verified signer; unsigned ones never do.
    func testSignerMarkerCannotBeForged() throws {
        let computer = Curve25519.Signing.PrivateKey()
        pin("dev_t", key: computer)
        let signedOut = try XCTUnwrap(check(try signed(["type": "pair_result", "deviceId": "dev_t"], from: "dev_t", key: computer), src: "dev_t"))
        XCTAssertTrue(signedOut.contains(DeviceTrustInbound.signedByKey))
        let forged = "{\"type\":\"pair_result\",\"deviceId\":\"dev_x\",\"\(DeviceTrustInbound.signedByKey)\":\"dev_x\"}"
        let out = try XCTUnwrap(check(forged, src: "dev_x"))
        XCTAssertFalse(out.contains(DeviceTrustInbound.signedByKey))
    }

    /// REV-02: sessions referenced anywhere in a message are checked.
    func testReferencedSessionIdsCoverNestedPlaces() {
        let preview = #"{"sessionId":"s_prev"}"#
        let dict: [String: Any] = [
            "sessionId": "s_top",
            "payload": ["sessionId": "s_payload", "sessions": [["id": "s_list"]], "preview": preview],
        ]
        XCTAssertEqual(Set(MessageRouter.referencedSessionIds(dict)), ["s_top", "s_payload", "s_list", "s_prev"])
    }

    // MARK: Pairing link

    func testPairingLinkCarriesTrust() throws {
        let ik = DeviceTrustWire.b64url(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
        let xk = DeviceTrustWire.b64url(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        let url = try XCTUnwrap(URL(string: "https://app.kraki.chat/?relay=wss://relay.kraki.chat&token=t&tid=dev_t&ik=\(ik)&xk=\(xk)&ps=5JHuX0U7LWjbxz0KSFNFmA"))
        let link = try XCTUnwrap(PairingLink(url: url))
        XCTAssertEqual(link.trust?.tentacleId, "dev_t")
        XCTAssertEqual(link.trust?.identityKey, ik)
        XCTAssertNil(PairingLink(url: try XCTUnwrap(URL(string: "https://app.kraki.chat/?token=t&tid=dev_t&ik=short&xk=\(xk)&ps=x")))?.trust)
    }
}
