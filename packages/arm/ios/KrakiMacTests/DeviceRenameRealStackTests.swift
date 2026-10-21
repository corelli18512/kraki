import XCTest
@testable import Kraki_Dev

/// Renaming a device end to end with the production Swift networking: two
/// native apps on the isolated local stack (packages/tests/src/chaos/stack.ts:
/// real head, real tentacle, open-auth throwaway identity), each on its own
/// relay link so one can be cut while the other keeps working.
///
/// Skipped unless `scripts/chaos/run-native.sh` started the stack:
///   bash scripts/chaos/run-native.sh -only-testing:KrakiMacTests/DeviceRenameRealStackTests
@MainActor
final class DeviceRenameRealStackTests: XCTestCase {
    struct StackInfo: Decodable { let controlPort: Int; let appPort: Int; let app2Port: Int; let sessionId: String; let tentacleId: String }

    private var stack: StackInfo!
    private var apps: [AppState] = []

    override func setUp() async throws {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")) else {
            throw XCTSkip("chaos stack not running")
        }
        stack = try JSONDecoder().decode(StackInfo.self, from: data)
        try await control("POST", "/heal")
    }

    override func tearDown() async throws {
        guard stack != nil else { return }
        // Leave the stack's computer with its own name for other scenarios.
        if let a = apps.first, a.connectionStatus == .connected,
           a.deviceStore.devices[stack.tentacleId]?.defaultName != nil {
            a.commandSender?.renameDevice(deviceId: stack.tentacleId, name: "")
            try? await waitUntil(10, "name cleared") { a.deviceStore.devices[self.stack.tentacleId]?.defaultName == nil }
        }
        for app in apps { app.disconnect() }
        apps = []
        try? await control("POST", "/heal")
    }

    // MARK: - Helpers

    @discardableResult
    private func control(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        guard let url = URL(string: "http://127.0.0.1:\(stack.controlPort)\(path)") else { throw URLError(.badURL) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out: \(what)"]) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    /// A native app connected to the stack on `port`, with the computer and
    /// its seeded session in view.
    private func connectApp(_ port: Int) async throws -> AppState {
        let outbox = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-rename-outbox-\(UUID().uuidString).json")
        let app = AppState.makeNetworkHarness(relayPort: port, outboxURL: outbox)
        apps.append(app)
        try await waitUntil(20, "app on :\(port) connected") {
            app.connectionStatus == .connected && app.deviceId != nil
                && app.deviceStore.devices[self.stack.tentacleId]?.online == true
                && app.sessionStore.sessions[self.stack.sessionId] != nil
        }
        return app
    }

    private func name(_ app: AppState, _ id: String) -> String? { app.deviceStore.devices[id]?.name }

    // MARK: - Scenarios

    func testRenameReachesTheOtherAppLiveAndBothDirections() async throws {
        let a = try await connectApp(stack.appPort)
        let b = try await connectApp(stack.app2Port)
        let computer = stack.tentacleId
        let own = try XCTUnwrap(name(a, computer))
        let aId = try XCTUnwrap(a.deviceId)
        try await waitUntil(10, "B sees A") { b.deviceStore.devices[aId] != nil }

        // A renames the computer: A (its acknowledgement) and B hear it live,
        // and B's session list relabels the computer's session.
        a.commandSender?.renameDevice(deviceId: computer, name: "Native box")
        try await waitUntil(10, "both apps show the new name") {
            self.name(a, computer) == "Native box" && self.name(b, computer) == "Native box"
        }
        XCTAssertEqual(b.deviceStore.devices[computer]?.defaultName, own)
        try await waitUntil(5, "B's session relabelled") { b.sessionStore.sessions[self.stack.sessionId]?.deviceName == "Native box" }

        // B renames A itself (an app device, like naming your phone).
        b.commandSender?.renameDevice(deviceId: aId, name: "Corelli's iPhone")
        try await waitUntil(10, "A hears its own new name") {
            self.name(a, aId) == "Corelli's iPhone" && self.name(b, aId) == "Corelli's iPhone"
        }

        // Clearing from B goes back to the computer's own name on both.
        b.commandSender?.renameDevice(deviceId: computer, name: "")
        try await waitUntil(10, "both apps show the computer's own name") {
            self.name(a, computer) == own && self.name(b, computer) == own
                && a.deviceStore.devices[computer]?.defaultName == nil
        }
        b.commandSender?.renameDevice(deviceId: aId, name: "")
        try await waitUntil(10, "A's own name back") { a.deviceStore.devices[aId]?.defaultName == nil }
    }

    func testAnAppThatWasOfflineGetsTheNameWhenItReconnects() async throws {
        let a = try await connectApp(stack.appPort)
        let b = try await connectApp(stack.app2Port)
        let computer = stack.tentacleId

        // B loses its link; A renames meanwhile.
        try await control("POST", "/fault", ["link": "app2", "refuse": true])
        try await control("POST", "/reset", ["link": "app2"])
        try await waitUntil(15, "B offline") { b.connectionStatus != .connected }
        a.commandSender?.renameDevice(deviceId: computer, name: "Renamed while away")
        try await waitUntil(10, "A shows it") { self.name(a, computer) == "Renamed while away" }
        XCTAssertNotEqual(name(b, computer), "Renamed while away")

        // B comes back: the relay's device list carries the name.
        try await control("POST", "/heal", ["link": "app2"])
        try await waitUntil(30, "B reconnected with the name") {
            b.connectionStatus == .connected && self.name(b, computer) == "Renamed while away"
        }
        // …and its session list labels the computer's session with it.
        try await waitUntil(5, "B's session relabelled") {
            b.sessionStore.sessions[self.stack.sessionId]?.deviceName == "Renamed while away"
        }
    }
}
