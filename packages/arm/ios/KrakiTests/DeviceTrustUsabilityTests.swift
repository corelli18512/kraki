import XCTest
import SwiftUI
import CryptoKit
#if os(macOS)
import AppKit
@testable import Kraki_Dev
#else
import UIKit
import UserNotifications
@testable import Kraki
#endif

/// Production networking + production trust views, with only QR acquisition
/// bypassed. All credentials, keys and local-computer discovery are isolated.
@MainActor
final class DeviceTrustUsabilityTests: XCTestCase {
    struct Stack: Decodable { let controlPort: Int; let appPort: Int; let tentacleId: String; let sessionId: String }
    private var stack: Stack!
    private var app: AppState!
    private var directory: URL!
    private var suite: String!
    #if os(iOS)
    private var window: UIWindow?
    #endif

    override func setUp() async throws {
        #if os(macOS)
        let url = URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")
        #else
        guard let url = Bundle(for: Self.self).url(forResource: "trust-stack", withExtension: "json") else {
            throw XCTSkip("run scripts/chaos/run-trust.sh with KRAKI_TRUST_PLATFORM=ios")
        }
        #endif
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("local trust stack required") }
        stack = try JSONDecoder().decode(Stack.self, from: data)
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("trust-usability-\(UUID())")
        DeviceIdentityKeys.testDirectory = directory
        DeviceIdentityKeys.shared.reset()
        suite = "TrustUsability.\(UUID())"
        TentacleTrustStore.shared.useDefaults(try XCTUnwrap(UserDefaults(suiteName: suite)))
        DeviceTrustTesting.localKrakiHome = directory.appendingPathComponent("no-computer")
        DeviceTrustModel.shared.reset()
        try await control("/heal")
        try await control("/trust/policy", ["enforce": true])
        try await Task.sleep(for: .seconds(2.5))
        app = AppState.makeNetworkHarness(relayPort: stack.appPort)
        try await wait("connected") { self.app.connectionStatus == .connected && self.app.deviceStore.devices[self.stack.tentacleId]?.online == true }
    }

    override func tearDown() async throws {
        #if os(iOS)
        window?.isHidden = true
        window = nil
        #endif
        app?.disconnect()
        app = nil
        guard directory != nil else { return }
        DeviceIdentityKeys.shared.reset()
        DeviceIdentityKeys.testDirectory = nil
        DeviceTrustTesting.localKrakiHome = nil
        TentacleTrustStore.shared.reset()
        DeviceTrustModel.shared.reset()
        UserDefaults().removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(at: directory)
        try? await control("/heal")
    }

    @discardableResult
    private func control(_ path: String, _ body: [String: Any] = [:], get: Bool = false) async throws -> [String: Any] {
        var req = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(stack.controlPort)\(path)")))
        req.httpMethod = get ? "GET" : "POST"
        if !get { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func wait(_ label: String, seconds: Double = 20, _ condition: @escaping () -> Bool) async throws {
        let until = Date().addingTimeInterval(seconds)
        while !condition() {
            guard Date() < until else { throw NSError(domain: "TrustUsability", code: 1, userInfo: [NSLocalizedDescriptionKey: label]) }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    private func link(ageMs: Int = 0) async throws -> PairingLink {
        let result = try await control("/trust/pairing-link", ["ageMs": ageMs])
        return try XCTUnwrap(PairingLink(string: try XCTUnwrap(result["url"] as? String)))
    }

    private func pair() async throws {
        app.pairWithComputer(try await link())
        try await wait("paired") { self.app.trustState(for: self.stack.tentacleId) == .paired }
        try await wait("trusted list") { self.app.deviceTrust.info[self.stack.tentacleId] != nil }
    }

    private func roundTrip() async throws {
        try await wait("session") { self.app.sessionStore.sessions[self.stack.sessionId] != nil }
        let text = "usability-\(UUID())"
        XCTAssertTrue(app.commandSender?.sendInput(sessionId: stack.sessionId, text: text) ?? false)
        for _ in 0..<80 {
            let ledger = try await control("/ledger", get: true)["received"] as? [String: Int] ?? [:]
            if ledger[text] == 1 { return }
            try await Task.sleep(for: .milliseconds(200))
        }
        XCTFail("paired input missing from real agent ledger")
    }

    func testFreshComputerAndTrustScreens() async throws {
        try await wait("needs pairing") { self.app.trustState(for: self.stack.tentacleId) == .needsPairing }
        XCTAssertNil(app.sessionStore.sessions[stack.sessionId])
        try await capture("before-pairing")
        try await pair()
        try await roundTrip()
        try await capture("paired-security")
        app.deviceTrust.feedback = .paired(name: "Chaos Tentacle")
        try await capture("success-toast")
        #if os(macOS)
        let device = try XCTUnwrap(app.deviceStore.devices[stack.tentacleId])
        try await render(PastePairingLinkSheet(computer: device).environment(app), name: "paste-link", height: 260)
        let payload = TentacleCLIManager.PairingPayload(url: "https://example.invalid/fixture", token: "fixture", relay: "ws://127.0.0.1:1", expiresAt: Date().addingTimeInterval(300))
        try await render(PairingSheet(preview: payload).environment(app).environment(TentacleCLIManager()), name: "connect-phone-waiting", height: 430)
        #endif
    }

    func testUpgradeCompatiblePairThenEnforce() async throws {
        try await control("/trust/policy", ["enforce": false])
        app.disconnect()
        try await Task.sleep(for: .seconds(2.5))
        app.devConnect(port: stack.appPort)
        try await wait("legacy session") { self.app.sessionStore.sessions[self.stack.sessionId] != nil }
        try await pair()
        XCTAssertEqual(app.deviceTrust.info[stack.tentacleId]?.enforced, false)
        try await capture("compatible-security")
        app.setOnlyPairedDevices(true, on: stack.tentacleId)
        try await wait("enforcement ack") { TentacleTrustStore.shared.pairedPin(self.stack.tentacleId)?.enforced == true }
        let rogue = "upgrade-rogue-\(UUID())"
        try await control("/trust/rogue-input", ["text": rogue])
        try await Task.sleep(for: .seconds(1))
        let ledger = try await control("/ledger", get: true)["received"] as? [String: Int] ?? [:]
        XCTAssertNil(ledger[rogue])
        try await roundTrip()
    }

    func testSecondComputerAndSecondAppRevocationAndReusedQR() async throws {
        try await pair()
        let original = TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey
        let second = try await control("/trust/second-computer")
        let secondId = try XCTUnwrap(second["tentacleId"] as? String)
        try await wait("second computer visible") { self.app.deviceStore.devices[secondId]?.online == true }
        // Its signed trust_required arrives just after its presence.
        try await wait("second computer asks to pair") { self.app.trustState(for: secondId) == .needsPairing }
        app.pairWithComputer(try XCTUnwrap(PairingLink(string: try XCTUnwrap(second["url"] as? String))))
        try await wait("second computer paired") { self.app.trustState(for: secondId) == .paired }
        XCTAssertEqual(TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey, original)
        let qr = try await control("/trust/pairing-link")
        let secondApp = try await control("/trust/second-app", ["url": try XCTUnwrap(qr["url"] as? String)])
        let secondAppId = try XCTUnwrap(secondApp["deviceId"] as? String)
        let accepted = try XCTUnwrap(secondApp["result"] as? [String: Any])
        XCTAssertEqual((accepted["payload"] as? [String: Any])?["ok"] as? Bool, true)
        try await wait("second app trusted list") { self.app.deviceTrust.info[self.stack.tentacleId]?.devices.contains { $0.id == secondAppId } == true }
        let text = "second-app-before-\(UUID())"
        try await control("/trust/second-app-input", ["text": text])
        var before: [String: Int] = [:]
        for _ in 0..<60 where before[text] == nil {
            try await Task.sleep(for: .milliseconds(200))
            before = try await control("/ledger", get: true)["received"] as? [String: Int] ?? [:]
        }
        XCTAssertEqual(before[text], 1)
        try await capture("two-trusted-apps")
        app.revokeTrustedDevice(secondAppId, on: stack.tentacleId)
        try await wait("other app revoked") { self.app.deviceTrust.info[self.stack.tentacleId]?.devices.contains { $0.id == secondAppId } == false }
        let refused = "second-app-after-\(UUID())"
        try await control("/trust/second-app-input", ["text": refused])
        try await Task.sleep(for: .seconds(1))
        let after = try await control("/ledger", get: true)["received"] as? [String: Int] ?? [:]
        XCTAssertNil(after[refused])
        let reused = try await control("/trust/second-app", ["url": try XCTUnwrap(qr["url"] as? String)])
        let result = try XCTUnwrap(reused["result"] as? [String: Any])
        XCTAssertEqual((result["payload"] as? [String: Any])?["reason"] as? String, "bad_proof")
        try await roundTrip()
    }

    func testExpiredCodeAndKeyChangePrompt() async throws {
        app.pairWithComputer(try await link(ageMs: 301_000))
        try await wait("expired rejected") { self.app.trustState(for: self.stack.tentacleId) == .failed("bad_proof") }
        try await capture("expired-code")
        try await pair()
        let fresh = try await link()
        let trust = try XCTUnwrap(fresh.trust)
        var components = try XCTUnwrap(URLComponents(string: "https://example.invalid/"))
        components.queryItems = [URLQueryItem(name: "token", value: fresh.token), URLQueryItem(name: "relay", value: fresh.relay),
                                 URLQueryItem(name: "tid", value: trust.tentacleId), URLQueryItem(name: "ik", value: trust.identityKey),
                                 URLQueryItem(name: "xk", value: trust.encryptionKey), URLQueryItem(name: "ps", value: trust.secret)]
        components.queryItems = components.queryItems?.map { item in
            item.name == "ik" ? URLQueryItem(name: "ik", value: DeviceTrustWire.b64url(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)) : item
        }
        let changed = try XCTUnwrap(PairingLink(url: try XCTUnwrap(components.url)))
        XCTAssertTrue(app.pairingLinkChangesKey(changed))
        let old = TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey
        app.openPairingLink(changed, relayConfirmed: true)
        guard case .replaceComputerKey = app.pendingPairingPrompt else { return XCTFail("key-change confirmation missing") }
        XCTAssertEqual(TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey, old)
        // Verifies the real prompt model, not a reinstalled computer or dialog rendering.
    }

    func testTentacleRestartAndAppReconnectKeepPairingThenLogoutRequiresPairing() async throws {
        try await pair()
        let identity = DeviceIdentityKeys.shared.identityPublicKey
        let pin = TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey
        try await control("/restart/tentacle")
        app.disconnect()
        app.devConnect(port: stack.appPort)
        try await wait("reconnected") { self.app.connectionStatus == .connected }
        XCTAssertEqual(DeviceIdentityKeys.shared.identityPublicKey, identity)
        XCTAssertEqual(TentacleTrustStore.shared.pairedPin(stack.tentacleId)?.identityKey, pin)
        try await roundTrip()
        app.logout()
        XCTAssertTrue(TentacleTrustStore.shared.all.isEmpty)
        XCTAssertNotEqual(DeviceIdentityKeys.shared.identityPublicKey, identity)
        app.devConnect(port: stack.appPort)
        try await wait("logout new login") { self.app.connectionStatus == .connected && self.app.trustState(for: self.stack.tentacleId) == .needsPairing }
        XCTAssertNil(app.sessionStore.sessions[stack.sessionId])
        try await pair()
        try await roundTrip()
    }

    func testOfflinePairingRemainsPendingAfterToastDisappears() async throws {
        let qr = try await link()
        try await control("/fault", ["link": "tentacle", "refuse": true])
        try await control("/reset", ["link": "tentacle"])
        try await wait("computer offline") { self.app.deviceStore.devices[self.stack.tentacleId]?.online == false }
        app.pairWithComputer(qr)
        try await capture("offline-pairing")
        XCTAssertEqual(app.trustState(for: stack.tentacleId), .pairing)
        try await Task.sleep(for: .seconds(21))
        // Still offline → still pending (the retry only fires for online computers).
        if app.deviceStore.devices[stack.tentacleId]?.online == false {
            XCTAssertEqual(app.trustState(for: stack.tentacleId), .pairing, "no timeout/retry explanation")
        }
        try await capture("offline-pairing-after-21s")
        try await control("/heal")
        try await wait("pairs after computer returns") { self.app.trustState(for: self.stack.tentacleId) == .paired }
    }

    #if os(iOS)
    func testTentaclePreviewThroughNotificationService() async throws {
        try await pair()
        let preview = try await control("/trust/preview")
        let keys = try XCTUnwrap(preview["keys"] as? [String: String])
        let key = try XCTUnwrap(keys[try XCTUnwrap(app.deviceId)])
        XCTAssertTrue(key.hasPrefix("v2."))
        // NSE reads the same app-group device id as the installed app. Only this simulator.
        DeviceTrustDefaults.shared.set(app.deviceId, forKey: "kraki.deviceId")
        defer { DeviceTrustDefaults.shared.removeObject(forKey: "kraki.deviceId") }
        let content = UNMutableNotificationContent()
        content.userInfo = ["kraki": ["blob": preview["blob"] as? String ?? "", "key": key]]
        let request = UNNotificationRequest(identifier: "usability", content: content, trigger: nil)
        var output: UNNotificationContent?
        NotificationService().didReceive(request) { output = $0 }
        XCTAssertTrue(output?.body.contains("Allow the usability test?") == true, output?.body ?? "missing NSE result")
        XCTAssertEqual(output?.userInfo["sessionId"] as? String, stack.sessionId)
        XCTAssertEqual(output?.threadIdentifier, stack.sessionId)
    }
    #endif

    func testAllBadgeStates() async throws {
        let states: [ComputerTrustState] = [.paired, .pairing, .failed("bad_proof"), .needsPairing, .notPaired, .unsupported]
        try await screenshot(VStack(alignment: .leading, spacing: 24) {
            Text("Production trust badge states").font(.headline)
            ForEach(Array(states.enumerated()), id: \.offset) { _, state in TrustStatusBadge(state: state) }
        }.padding().environment(app), name: "badge-states", height: 380)
    }

    private func capture(_ name: String) async throws {
        let device = try XCTUnwrap(app.deviceStore.devices[stack.tentacleId])
        let view = VStack(spacing: 12) {
            Text("Computer: \(device.name)").font(.headline)
            HStack { Text(device.online ? "Online" : "Offline"); TrustStatusBadge(state: app.trustState(for: device.id)) }
            PairingNeededBanner { _ in }
            Form { Section("Security") { ComputerSecurityRows(device: device, onPair: {}) } }
                .formStyle(.grouped)
            PairingFeedbackToast()
        }.padding().environment(app)
        try await screenshot(view, name: name, height: 750)
    }

    private func screenshot<V: View>(_ view: V, name: String, height: CGFloat) async throws {
        #if os(macOS)
        try await render(view, name: name, height: height)
        #else
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return XCTFail("test scene unavailable") }
        window?.isHidden = true
        let host = UIHostingController(rootView: view)
        let newWindow = UIWindow(windowScene: scene)
        newWindow.rootViewController = host
        newWindow.frame = scene.coordinateSpace.bounds
        newWindow.isHidden = false // simulator-only; never activate a desktop application
        window = newWindow
        try await Task.sleep(for: .seconds(1))
        try await control("/trust/screenshot", ["name": "ios-\(name)"])
        #endif
    }

    #if os(macOS)
    private func render<V: View>(_ view: V, name: String, height: CGFloat) async throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, .light).background(Color.white))
        host.frame = NSRect(x: 0, y: 0, width: 560, height: height)
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(500))
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let root = URL(fileURLWithPath: "/tmp/kraki-trust-review/shots", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try png.write(to: root.appendingPathComponent("mac-\(name).png"))
    }
    #endif
}
