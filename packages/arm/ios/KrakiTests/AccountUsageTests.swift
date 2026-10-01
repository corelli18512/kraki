import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

@MainActor
final class AccountUsageTests: XCTestCase {
    private func makeApp() throws -> (AppState, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-usage-test-\(UUID().uuidString)", isDirectory: true)
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        return (AppState(testDatabase: database), root)
    }

    private func device(_ id: String, _ name: String, role: DeviceRole = .tentacle, online: Bool = true) -> DeviceSummary {
        DeviceSummary(id: id, name: name, role: role, kind: .desktop, publicKey: nil, encryptionKey: nil,
                      online: online, lastSeen: nil, createdAt: nil)
    }

    private func account(_ key: String, five: Double? = nil, weekly: Double? = nil) -> AccountUsage {
        var windows: [AccountUsageWindow] = []
        if let five { windows.append(AccountUsageWindow(id: "five_hour", kind: "five_hour", remainingPercent: five)) }
        if let weekly { windows.append(AccountUsageWindow(id: "seven_day", kind: "weekly", remainingPercent: weekly)) }
        return AccountUsage(accountKey: key, provider: "claude", windows: windows,
                            fetchedAt: ISO8601DateFormatter().string(from: Date()))
    }

    func testDeviceUsageMessageIsStoredPerDevice() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let router = MessageRouter(appState: app)
        let data = try JSONSerialization.data(withJSONObject: [
            "type": "device_usage", "deviceId": "mac-1", "seq": 1, "timestamp": "2026-09-28T00:00:00Z",
            "payload": ["updatedAt": "2026-09-28T00:00:00Z", "accounts": [[
                "accountKey": "codex:abc", "provider": "codex", "label": "co•••ai@gmail.com", "plan": "prolite",
                "fetchedAt": "2026-09-28T00:00:00.000Z",
                "windows": [["id": "primary_window", "kind": "weekly", "remainingPercent": 0, "resetsAt": "2026-10-01T00:00:00.000Z", "durationSeconds": 604800]],
            ]]],
        ])
        router.handleDataMessage(data)
        let accounts = try XCTUnwrap(app.deviceStore.deviceUsage["mac-1"]?.accounts)
        XCTAssertEqual(accounts.map(\.accountKey), ["codex:abc"])
        XCTAssertEqual(accounts[0].planTitle, "Pro Lite")
        XCTAssertEqual(accounts[0].ringWindows.map(\.kind), ["weekly"])
        XCTAssertEqual(accounts[0].ringWindows[0].remainingPercent, 0)
        XCTAssertNotNil(accounts[0].ringWindows[0].resetDate)
    }

    func testOnlineDevicesListTheCurrentSessionDeviceFirstAndSkipOfflineOnes() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "Alpha"), device("b", "Beta"), device("c", "Gamma", online: false),
                          device("phone", "iPhone", role: .app)])
        for id in ["a", "b", "c", "phone"] { store.setDeviceUsage(id, accounts: [account("k-\(id)", weekly: 50)]) }
        store.setDeviceUsage("a", accounts: [account("k-a", weekly: 50)])
        XCTAssertEqual(store.onlineUsageDevices(preferredDeviceId: nil).map(\.device.id), ["a", "b"])
        XCTAssertEqual(store.onlineUsageDevices(preferredDeviceId: "b").map(\.device.id), ["b", "a"])
        // A device that reported no accounts has nothing to show.
        store.setDeviceUsage("b", accounts: [])
        XCTAssertEqual(store.onlineUsageDevices(preferredDeviceId: "b").map(\.device.id), ["a"])
    }

    func testRingsAreFiveHourThenWeeklyAndRingStateColors() {
        let a = account("k", five: 98, weekly: 9)
        XCTAssertEqual(a.ringWindows.map(\.kind), ["five_hour", "weekly"])
        XCTAssertEqual(UsageRingState(98, stale: false), .ok)
        XCTAssertEqual(UsageRingState(40, stale: false), .mid)
        XCTAssertEqual(UsageRingState(9, stale: false), .low)
        XCTAssertEqual(UsageRingState(0, stale: false), .out)
        XCTAssertEqual(UsageRingState(80, stale: true), .stale)
        var failed = a
        failed.error = "unavailable"
        XCTAssertTrue(failed.isStale())
        XCTAssertFalse(a.isStale())
    }
}
