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

    private func account(_ key: String, five: Double? = nil, weekly: Double? = nil, provider: String = "claude",
                         agents: [String]? = nil, at date: Date = Date()) -> AccountUsage {
        var windows: [AccountUsageWindow] = []
        if let five { windows.append(AccountUsageWindow(id: "five_hour", kind: "five_hour", remainingPercent: five)) }
        if let weekly { windows.append(AccountUsageWindow(id: "seven_day", kind: "weekly", remainingPercent: weekly)) }
        return AccountUsage(accountKey: key, provider: provider, windows: windows,
                            fetchedAt: ISO8601DateFormatter().string(from: date), agents: agents)
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

    func testOneAccountSharedByDevicesIsOneEntryWithTheFreshestReading() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "Alpha"), device("b", "Beta"), device("c", "Gamma", online: false),
                          device("phone", "iPhone", role: .app)])
        let now = Date()
        store.setDeviceUsage("a", accounts: [account("shared", weekly: 60, at: now.addingTimeInterval(-300)), account("only-a", weekly: 10)])
        store.setDeviceUsage("b", accounts: [account("shared", weekly: 55, at: now)])
        store.setDeviceUsage("c", accounts: [account("shared", weekly: 90, at: now.addingTimeInterval(-3600))])
        store.setDeviceUsage("phone", accounts: [account("ignored", weekly: 1)])
        let merged = store.mergedUsage()
        XCTAssertEqual(Set(merged.map(\.id)), ["shared", "only-a"])
        let shared = try XCTUnwrap(merged.first { $0.id == "shared" })
        XCTAssertEqual(shared.account.windows.first?.remainingPercent, 55, "freshest reading wins")
        XCTAssertEqual(shared.devices.map(\.id), ["a", "b", "c"], "online devices first, offline last")
        XCTAssertFalse(shared.allOffline)
    }

    func testTheSessionsAccountIsMatchedByDeviceAgentAndModel() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "Alpha")])
        store.setDeviceUsage("a", accounts: [
            account("claude-pi", weekly: 50, provider: "claude", agents: ["pi"]),
            account("gpt-pi-codex", weekly: 50, provider: "codex", agents: ["codex", "pi"]),
            account("claude-code", weekly: 50, provider: "claude", agents: ["claude"]),
        ])
        XCTAssertEqual(store.accountKey(forSessionOn: "a", agent: "pi", model: "anthropic/claude-opus-5"), "claude-pi")
        XCTAssertEqual(store.accountKey(forSessionOn: "a", agent: "pi", model: "openai-codex/gpt-6-sol"), "gpt-pi-codex")
        XCTAssertEqual(store.accountKey(forSessionOn: "a", agent: "claude", model: "claude-opus-5"), "claude-code")
        XCTAssertEqual(store.accountKey(forSessionOn: "a", agent: "codex", model: nil), "gpt-pi-codex")
        XCTAssertNil(store.accountKey(forSessionOn: "a", agent: "pi", model: nil), "ambiguous: two Pi accounts")
        XCTAssertNil(store.accountKey(forSessionOn: "a", agent: "copilot", model: "gpt-5"))
        XCTAssertNil(store.accountKey(forSessionOn: "zzz", agent: "pi", model: "anthropic/x"))
    }

    func testOnlyGreetedTentaclesWithoutTheFeatureNeedAnUpdate() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("old", "Old Mac"), device("new", "New Mac"), device("quiet", "Quiet Mac"),
                          device("pending", "Pending Mac"), device("off", "Off Mac", online: false)])
        for id in ["old", "new", "quiet", "off"] { store.markGreeted(id) }
        store.setDeviceFeatures("old", features: ["idempotent_input"])
        store.setDeviceFeatures("new", features: ["idempotent_input", "account_usage"])
        store.setDeviceFeatures("pending", features: ["idempotent_input"])
        store.setDeviceFeatures("off", features: ["idempotent_input"])
        // "quiet" sent no features at all: unknown, so not called out.
        XCTAssertEqual(store.devicesNeedingUsageUpdate().map(\.id), ["old"])
        // A device that did report usage is never called outdated.
        store.setDeviceUsage("old", accounts: [])
        XCTAssertTrue(store.devicesNeedingUsageUpdate().isEmpty)
    }

    func testShortLabelKeepsTheMaskedLocalPart() {
        var a = account("k", weekly: 50)
        a.label = "co•••ai@gmail.com"
        XCTAssertEqual(a.shortLabel, "co•••ai")
        a.label = nil
        XCTAssertEqual(a.shortLabel, "Claude")
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
