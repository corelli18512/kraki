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
        store = TentacleTrustStore(defaults: UserDefaults(suiteName: suite)!)
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

    func testNoPairedComputersMeansLegacyBehaviour() {
        let plain = #"{"type":"agent_message","deviceId":"dev_legacy"}"#
        XCTAssertEqual(check(plain, src: "dev_legacy"), plain)
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
