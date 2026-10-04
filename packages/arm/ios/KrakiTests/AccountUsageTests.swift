import XCTest
import Observation
#if os(iOS)
import SwiftUI
import UIKit
#endif
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

    func testDeviceDetailPreservesItsOwnReadErrorInsteadOfUsingAHealthyReplica() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "Alpha"), device("b", "Beta")])
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        var failed = account("shared", weekly: 60, at: now.addingTimeInterval(-300))
        failed.error = "auth"
        let healthy = account("shared", weekly: 55, at: now)
        store.setDeviceUsage("a", accounts: [failed])
        store.setDeviceUsage("b", accounts: [healthy])

        let detail = try XCTUnwrap(store.usageForDevice("a").first)
        XCTAssertEqual(detail.account, failed)
        XCTAssertEqual(detail.account.readStatus(now: now), "Sign-in needed")
        XCTAssertEqual(detail.devices.map(\.id), ["a"])
        XCTAssertEqual(store.usageForDevice("b").first?.account, healthy)
        XCTAssertEqual(store.mergedUsage().first?.account, healthy, "global accounts still use the healthy replica")
        XCTAssertTrue(store.usageForDevice("missing").isEmpty)
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

    func testFreshnessMatchesDefaultAndConfiguredPollingCadences() {
        let fetched = Date(timeIntervalSince1970: 1_790_000_000)
        var a = account("k", weekly: 80, at: fetched)
        XCTAssertFalse(a.isStale(now: fetched.addingTimeInterval(11 * 60 + 1)))
        XCTAssertFalse(a.isStale(now: fetched.addingTimeInterval(16.5 * 60)))
        XCTAssertFalse(a.isStale(now: fetched.addingTimeInterval(2040)))
        XCTAssertTrue(a.isStale(now: fetched.addingTimeInterval(2041)))
        a.staleAfterSeconds = 15_900 // 120m polling, two worst-case intervals + grace
        XCTAssertFalse(a.isStale(now: fetched.addingTimeInterval(132 * 60)))
        XCTAssertTrue(a.isStale(now: fetched.addingTimeInterval(15_901)))
        for invalid in [Double.nan, .infinity, -1, 0] {
            a.staleAfterSeconds = invalid
            XCTAssertEqual(a.freshnessLifetime, 2040)
        }
        a.error = "auth"
        XCTAssertTrue(a.isStale(now: fetched))
    }

    func testFailureReasonAndLastSuccessfulReadAreNotQuotaResetOrFailedAttemptTimes() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        var a = account("k", weekly: 80, at: now.addingTimeInterval(-900))
        a.error = "auth"
        XCTAssertEqual(a.readStatus(now: now), "Sign-in needed")
        XCTAssertEqual(a.lastUpdatedText(now: now), "Updated 15m ago")
        a.error = "rate_limited"
        a.retryAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(300))
        XCTAssertEqual(a.readStatus(now: now), "Rate limited · retry in 5m")
        XCTAssertNil(a.windows.first?.resetDate, "Retry-After is not a quota reset")
        a.error = "private-provider-exception"
        XCTAssertEqual(a.readStatus(now: now), "Couldn't refresh")
        XCTAssertEqual(a.windows.first?.remainingPercent, 80)
        var neverRead = account("empty", at: now)
        neverRead.error = "auth" // legacy workers could stamp an unsuccessful attempt
        XCTAssertEqual(neverRead.lastUpdatedText(now: now), "Not updated yet")
    }

    func testRefreshTargetsCoverSharedAccountsWithoutQueryingEveryReplica() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "A"), device("b", "B"), device("empty", "Empty"),
                          device("only", "Only"), device("old", "Old"), device("off", "Off", online: false),
                          device("pending", "Pending"), device("phone", "Phone", role: .app)])
        for id in ["a", "b", "empty", "only", "off", "pending", "phone"] {
            store.setDeviceFeatures(id, features: ["account_usage", "account_usage_refresh"])
            if id != "pending" { store.markGreeted(id) }
        }
        store.markGreeted("old")
        store.setDeviceFeatures("old", features: ["account_usage"])
        let shared = account("shared", weekly: 50, at: Date(timeIntervalSince1970: 1_790_000_000))
        store.setDeviceUsage("a", accounts: [shared])
        store.setDeviceUsage("b", accounts: [shared])
        store.setDeviceUsage("only", accounts: [account("unique", weekly: 50)])
        XCTAssertEqual(store.usageRefreshTargets(), ["a", "empty", "only"])
        XCTAssertEqual(store.usageRefreshTargets(deviceIds: ["b"]), ["b"], "device-detail refresh is explicitly targeted")
        XCTAssertTrue(store.usageRefreshTargets(deviceIds: ["old", "off", "phone", "pending"]).isEmpty)
    }

    func testRefreshPrefersHealthyReplicasAndRecoversAfterRequestFailures() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        store.setDevices([device("a", "A"), device("b", "B")])
        for id in ["a", "b"] {
            store.markGreeted(id)
            store.setDeviceFeatures(id, features: ["account_usage_refresh"])
        }
        let good = account("shared", weekly: 70, at: now.addingTimeInterval(-900))
        store.setDeviceUsage("a", accounts: [good])
        store.setDeviceUsage("b", accounts: [good])
        XCTAssertEqual(store.usageRefreshTargets(), ["a"])
        var expired = good
        expired.error = "auth"
        store.setDeviceUsage("a", accounts: [expired])
        XCTAssertEqual(store.usageRefreshTargets(), ["b"], "do not pin shared quota to an expired login")
        XCTAssertEqual(store.usageRefreshTargets(deviceIds: ["a"]), ["a"], "explicit device choice is retained")
        store.setDeviceUsage("a", accounts: [good])
        store.beginUsageRefresh("a", requestId: "failed", now: now)
        store.finishUsageRefresh("a", requestId: "failed", error: "unavailable")
        XCTAssertEqual(store.usageRefreshTargets(), ["b"], "a failed RPC also allows failover")
        store.setDeviceUsage("a", accounts: [account("shared", weekly: 60, at: now.addingTimeInterval(1))])
        XCTAssertEqual(store.usageRefreshTargets(), ["a"], "later successful data restores eligibility")
    }

    func testMixedHealthCoverageStillSelectsAHealthyReplicaForEachAccount() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "A"), device("b", "B")])
        for id in ["a", "b"] {
            store.markGreeted(id)
            store.setDeviceFeatures(id, features: ["account_usage_refresh"])
        }
        let good = account("shared", weekly: 70)
        let unique = account("only-a", weekly: 50)
        var expired = good
        expired.error = "auth"
        store.setDeviceUsage("a", accounts: [unique, expired])
        store.setDeviceUsage("b", accounts: [good])
        XCTAssertEqual(store.usageRefreshTargets(), ["a", "b"], "A covers its unique account, not its expired copy of B's account")
        store.setDeviceUsage("a", accounts: [unique, good])
        XCTAssertEqual(store.usageRefreshTargets(), ["a"], "once healthy, one device covers both accounts")

        // All absent/healthy/expired combinations for two accounts on two
        // devices: whenever a healthy replica exists, at least one is selected.
        for pattern in 0..<81 {
            var digits = pattern
            var healthy: [String: Set<String>] = [:]
            for id in ["a", "b"] {
                var readings: [AccountUsage] = []
                for key in ["x", "y"] {
                    let state = digits % 3
                    digits /= 3
                    guard state != 0 else { continue }
                    var reading = account(key, weekly: 50)
                    if state == 2 { reading.error = "auth" } else { healthy[key, default: []].insert(id) }
                    readings.append(reading)
                }
                store.setDeviceUsage(id, accounts: readings)
            }
            let selected = Set(store.usageRefreshTargets())
            for (_, replicas) in healthy {
                XCTAssertFalse(selected.isDisjoint(with: replicas), "missed healthy replica in pattern \(pattern)")
            }
        }
    }

    #if os(iOS)
    func testDevicesPageRefreshesWhenConnectionAndGreetingArriveAfterAppearance() async throws {
        try requireForegroundUITests()
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        app.connectionStatus = .connecting
        app.deviceStore.setDevices([device("a", "A")])
        let appeared = expectation(description: "page appeared before connection")
        let requested = expectation(description: "refresh after connection and greeting")
        var sends = 0
        app.testOutboundMessageHandler = { message, _, _ in
            if message["type"] as? String == "refresh_account_usage" { sends += 1; requested.fulfill() }
            return true
        }
        let host = UIHostingController(rootView: NavigationStack { DeviceListView() }
            .environment(app).onAppear { appeared.fulfill() })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 874)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        await fulfillment(of: [appeared], timeout: 5)
        XCTAssertEqual(sends, 0)
        app.connectionStatus = .connected
        app.deviceStore.setDeviceFeatures("a", features: ["account_usage", "account_usage_refresh"])
        app.deviceStore.markGreeted("a")
        await fulfillment(of: [requested], timeout: 5)
        XCTAssertEqual(sends, 1)
    }
    #endif

    func testAutomaticRefreshUsesAgeAndRespectsAdvertisedBackoff() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let fresh = account("k", weekly: 70, at: now)
        store.setDeviceUsage("a", accounts: [fresh])
        XCTAssertFalse(store.canRefreshUsage("a", automatic: true, now: now.addingTimeInterval(59)))
        XCTAssertTrue(store.canRefreshUsage("a", automatic: true, now: now.addingTimeInterval(61)))
        var limited = fresh
        limited.error = "rate_limited"
        limited.retryAt = ISO8601DateFormatter().string(from: now.addingTimeInterval(300))
        store.setDeviceUsage("a", accounts: [limited])
        XCTAssertFalse(store.canRefreshUsage("a", automatic: true, now: now.addingTimeInterval(61)))
        XCTAssertTrue(store.canRefreshUsage("a", automatic: true, now: now.addingTimeInterval(301)))
    }

    func testRefreshCommandIsTargetedConnectionScopedCoalescedAndCorrelated() throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "A")])
        store.markGreeted("a")
        store.setDeviceFeatures("a", features: ["account_usage_refresh"])
        app.connectionStatus = .connected
        var messages: [[String: Any]] = []
        app.testOutboundMessageHandler = { message, _, scoped in
            XCTAssertTrue(scoped)
            messages.append(message)
            return true
        }
        let sender = try XCTUnwrap(app.commandSender)
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let cached = account("k", weekly: 70, at: now)
        store.setDeviceUsage("a", accounts: [cached])
        XCTAssertEqual(sender.refreshAccountUsage(now: now), 1)
        XCTAssertEqual(messages.first?["type"] as? String, "refresh_account_usage")
        XCTAssertEqual(messages.first?["targetDeviceId"] as? String, "a")
        let first = try XCTUnwrap(store.usageRefreshes["a"]?.requestId)
        XCTAssertEqual((messages.first?["payload"] as? [String: Any])?["requestId"] as? String, first)
        XCTAssertEqual(sender.refreshAccountUsage(now: now), 0)
        store.receiveDeviceUsage("a", payload: DeviceUsagePayload(accounts: [cached]))
        XCTAssertEqual(store.usageRefreshes["a"]?.finished, false, "a broadcast does not finish this request")
        let router = MessageRouter(appState: app)
        let payload = DeviceUsagePayload(accounts: [cached], requestId: first)
        router.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "device_usage", "deviceId": "a",
            "payload": try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)),
        ]))
        XCTAssertEqual(store.usageRefreshes["a"]?.finished, true, "even unchanged data acknowledges the request")
        XCTAssertEqual(sender.refreshAccountUsage(now: now.addingTimeInterval(59)), 0)
        XCTAssertEqual(sender.refreshAccountUsage(now: now.addingTimeInterval(61)), 1)
        let second = try XCTUnwrap(store.usageRefreshes["a"]?.requestId)
        XCTAssertNotEqual(first, second)
        store.receiveDeviceUsage("a", payload: DeviceUsagePayload(accounts: [], requestId: first))
        XCTAssertEqual(store.usageRefreshes["a"]?.finished, false, "late replies must not end the newer request")
        XCTAssertEqual(store.deviceUsage["a"]?.accounts, [cached], "nor overwrite newer data")
        store.receiveDeviceUsage("a", payload: DeviceUsagePayload(accounts: [], requestId: second, refreshError: "unavailable"))
        XCTAssertEqual(store.usageRefreshes["a"]?.error, "unavailable")
        XCTAssertEqual(store.deviceUsage["a"]?.accounts, [cached], "transport failures retain the last reading")
    }

    func testRefreshTimeoutIsBoundedAndDisconnectDoesNotReplayRequests() async throws {
        let (app, root) = try makeApp()
        defer { try? FileManager.default.removeItem(at: root) }
        let store = app.deviceStore
        store.setDevices([device("a", "A")])
        store.markGreeted("a")
        store.setDeviceFeatures("a", features: ["account_usage_refresh"])
        app.connectionStatus = .connected
        var sent = 0
        app.testOutboundMessageHandler = { _, _, _ in sent += 1; return true }
        let sender = try XCTUnwrap(app.commandSender)
        sender.usageRefreshTimeout = .milliseconds(1)
        XCTAssertEqual(sender.refreshAccountUsage(), 1)
        let timedOut = expectation(description: "request timeout publishes terminal state")
        withObservationTracking {
            _ = store.usageRefreshes["a"]
        } onChange: {
            timedOut.fulfill()
        }
        await fulfillment(of: [timedOut], timeout: 5)
        XCTAssertEqual(store.usageRefreshes["a"]?.finished, true)
        XCTAssertEqual(store.usageRefreshes["a"]?.error, "timeout")
        store.beginUsageRefresh("a", requestId: "connection-lost")
        app.connectionStatus = .disconnected
        XCTAssertEqual(store.usageRefreshes["a"]?.error, "connection")
        XCTAssertEqual(sender.refreshAccountUsage(), 0)
        app.connectionStatus = .connected
        XCTAssertEqual(sent, 1, "refresh is never replayed through the durable outbox")
        store.beginUsageRefresh("a", requestId: "peer-left")
        store.setOnline("a", false)
        XCTAssertEqual(store.usageRefreshes["a"]?.error, "offline")
        store.reset()
        XCTAssertTrue(store.usageRefreshes.isEmpty)
        XCTAssertTrue(store.deviceUsage.isEmpty)
        XCTAssertTrue(store.deviceFeatures.isEmpty)
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
