import CoinfraCrypto
import CryptoKit
import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// E2E v2 (X25519): cross-implementation interop and the app's handshake /
/// inbound handling. No Keychain is touched (fixed key override).
@MainActor
final class E2EV2Tests: XCTestCase {
    private let myKey = Curve25519.KeyAgreement.PrivateKey()

    override func setUp() {
        super.setUp()
        KeychainManager.debugE2EKeyOverride = myKey
    }

    override func tearDown() {
        KeychainManager.debugE2EKeyOverride = nil
        super.tearDown()
    }

    // MARK: Interop

    /// Tentacle-side (node:crypto) envelopes open here. Node opens the
    /// @coinfra/crypto TS and Swift vectors in packages/crypto tests, and the
    /// CoinfraCrypto Swift package opens the TS ones, so all three agree.
    /// E2EV2NodeVectors.swift is generated from packages/crypto/dist (encryptV2).
    func testOpensNodeVectors() throws {
        for blob in E2EV2NodeVectors.blobs {
            for r in E2EV2NodeVectors.recipients {
                let key = try CoinfraCrypto.importEncryptionPrivateKey(r.privateKey)
                XCTAssertEqual(E2EV2.publicKey(key), r.publicKey)
                XCTAssertEqual(try E2EV2.decrypt(blob.blob, deviceId: r.id, privateKey: key), blob.plaintext)
            }
            XCTAssertNil(try E2EV2.decrypt(blob.blob, deviceId: "someone_else", privateKey: myKey))
        }
    }

    // MARK: Inbound

    private func makeApp() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.deviceId = "dev_me"
        return app
    }

    func testInboundV2PayloadDecrypts() throws {
        let app = makeApp()
        let handler = EncryptionHandler(crypto: CryptoManager(), keychain: KeychainManager(), appState: app)
        let inner = #"{"type":"agent_message","sessionId":"s1","payload":{"content":"hi"}}"#
        let blob = try E2EV2.encrypt(inner, recipients: [("dev_me", E2EV2.publicKey(myKey))])
        let envelope = try JSONSerialization.data(withJSONObject: ["v": 2, "blob": blob])
        let result = try handler.decryptInbound(envelope)
        XCTAssertEqual(String(data: result.message, encoding: .utf8), inner)
        XCTAssertEqual(result.sessionId, "s1")

        let other = try E2EV2.encrypt(inner, recipients: [("dev_other", E2EV2.publicKey(Curve25519.KeyAgreement.PrivateKey()))])
        XCTAssertThrowsError(try handler.decryptInbound(try JSONSerialization.data(withJSONObject: ["v": 2, "blob": other]))) {
            guard case EncryptionError.notAddressedToUs = $0 else { return XCTFail("\($0)") }
        }
    }

    // MARK: Handshake

    private func greet(_ router: MessageRouter, features: [String], key: String?) throws {
        var payload: [String: Any] = ["name": "Mac", "features": features]
        if let key { payload["e2eKeys"] = ["x25519": key] }
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "device_greeting", "deviceId": "dev_t", "seq": 1, "timestamp": "2026-10-01T00:00:00Z",
            "payload": payload,
        ]))
    }

    /// The greeting's key and `e2e_v2` decide v2; this app always announces
    /// its own key and `e2e_v2` in client_features.
    func testGreetingKeyAndClientFeaturesAnnouncement() throws {
        let app = makeApp()
        var sent: [[String: Any]] = []
        app.testOutboundMessageHandler = { message, _, _ in sent.append(message); return true }
        let router = MessageRouter(appState: app)
        let tentacleKey = E2EV2.publicKey(Curve25519.KeyAgreement.PrivateKey())

        try greet(router, features: ["fragments"], key: tentacleKey)
        XCTAssertNil(app.deviceStore.e2eV2Key(for: "dev_t"), "key without e2e_v2: stay RSA")
        let declared = try XCTUnwrap(sent.last { $0["type"] as? String == "client_features" }?["payload"] as? [String: Any])
        XCTAssertEqual(declared["features"] as? [String], ["fragments", "e2e_v2"])
        XCTAssertEqual((declared["e2eKeys"] as? [String: String])?["x25519"], E2EV2.publicKey(myKey))

        try greet(router, features: ["fragments", "e2e_v2"], key: tentacleKey)
        XCTAssertEqual(app.deviceStore.e2eV2Key(for: "dev_t"), tentacleKey)

        // A later greeting without a key keeps the announced one.
        try greet(router, features: ["fragments", "e2e_v2"], key: nil)
        XCTAssertEqual(app.deviceStore.e2eV2Key(for: "dev_t"), tentacleKey)

        // A Tentacle that stops advertising e2e_v2 gets RSA again.
        try greet(router, features: ["fragments"], key: tentacleKey)
        XCTAssertNil(app.deviceStore.e2eV2Key(for: "dev_t"))
    }
}
