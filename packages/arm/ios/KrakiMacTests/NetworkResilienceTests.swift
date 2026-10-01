import XCTest
@testable import Kraki_Dev

/// Network-resilience scenarios against an isolated local stack
/// (packages/tests/src/chaos/stack.ts) behind a fault-injection proxy.
/// Uses the production AppState networking (WebSocket, auth, Pulse,
/// CommandSender, MessageProvider) with a throwaway open-auth identity.
///
/// Skipped unless `scripts/chaos/run-native.sh` started the stack and wrote
/// /tmp/kraki-chaos/stack.json. Each scenario records metrics to
/// /tmp/kraki-chaos/results/<name>.json and asserts the targets in
/// docs/network-resilience-test-plan.md (G1–G10).
@MainActor
final class NetworkResilienceTests: XCTestCase {
    struct StackInfo: Decodable { let controlPort: Int; let appPort: Int; let app2Port: Int; let sessionId: String; let tentacleId: String }

    private var stack: StackInfo?
    private var app: AppState!
    private var sessionId = ""
    private var sent: [(text: String, clientId: String, at: Date)] = []
    /// Worst state each input ever showed (sending < unconfirmed < failed).
    private var worstState: [String: String] = [:]
    private var reconnectingSince: Date?
    private var reconnectingSpells: [TimeInterval] = []
    private var visibleReconnectingSeen = false
    private var lastSeenDelivery: Date?
    private var deliveryGaps: [Double] = []
    private var sampler: Task<Void, Never>?
    private var metrics: [String: Any] = [:]
    private var echoLatency: [String: TimeInterval] = [:]
    private let outboxURL = FileManager.default.temporaryDirectory
        .appendingPathComponent("kraki-net-outbox-\(UUID().uuidString).json")

    // MARK: - Setup

    override func setUp() async throws {
        let url = URL(fileURLWithPath: "/tmp/kraki-chaos/stack.json")
        guard let data = try? Data(contentsOf: url) else { throw XCTSkip("chaos stack not running") }
        stack = try JSONDecoder().decode(StackInfo.self, from: data)
        try await control("POST", "/heal")
        try await control("POST", "/agent/options", ["replyDelayMs": 150, "deltas": 4, "deltaIntervalMs": 80])
        sessionId = try await control("POST", "/session")["sessionId"] as? String ?? ""
        app = AppState.makeNetworkHarness(relayPort: stack!.appPort, outboxURL: outboxURL)
        try await waitUntil(20, "connected with session") {
            self.app.connectionStatus == .connected
                && self.app.sessionStore.sessions[self.sessionId] != nil
                && self.tentacleOnline
        }
        app.sessionSubscriptionController.setDesired(sessionId)
        _ = app.messageProvider?.openSession(sessionId)
        try await waitUntil(10, "subscription confirmed") { self.app.sessionSubscriptionController.liveReady }
        startSampler()
    }

    override func tearDown() async throws {
        sampler?.cancel()
        // Skipped (no stack running): nothing was started.
        guard stack != nil else { return }
        if !metrics.isEmpty { writeMetrics() }
        app?.disconnect()
        app = nil
        try? await control("POST", "/heal")
    }

    private var tentacleOnline: Bool {
        app.deviceStore.devices[stack!.tentacleId]?.online == true
    }

    // MARK: - Helpers

    @discardableResult
    private func control(_ method: String, _ path: String, _ body: [String: Any]? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(stack!.controlPort)\(path)")!)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func fault(_ link: String = "app", _ patch: [String: Any]) async throws {
        var body = patch; body["link"] = link
        try await control("POST", "/fault", body)
    }

    private func waitUntil(_ seconds: TimeInterval, _ what: String, _ check: @escaping () -> Bool) async throws {
        let end = Date().addingTimeInterval(seconds)
        while !check() {
            if Date() > end { throw NSError(domain: "timeout", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out: \(what)"]) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private func pause(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    /// User taps Send. Returns whether the composer accepted it.
    @discardableResult
    private func send(_ label: String) -> Bool {
        let text = "\(name.components(separatedBy: " ").last?.dropLast() ?? "t")-\(label)-\(UUID().uuidString.prefix(6))"
        let accepted = app.commandSender?.sendInput(sessionId: sessionId, text: text) ?? false
        let clientId = app.commandSender?.pendingInputs(sessionId)
            .first { $0.content == text }?.payload["clientId"]?.stringValue ?? "rejected-\(UUID().uuidString)"
        sent.append((text, clientId, Date()))
        if !accepted { worstState[clientId] = "rejected" }
        return accepted
    }

    private func startSampler() {
        sampler = Task { @MainActor [weak self] in
            let rank = ["sending": 0, "unconfirmed": 1, "failed": 2, "rejected": 3]
            while !Task.isCancelled {
                guard let self, let app = self.app else { return }
                if let sender = app.commandSender {
                    for message in sender.pendingInputs(self.sessionId) {
                        guard let id = message.payload["clientId"]?.stringValue else { continue }
                        let state = sender.pendingState(message).rawValue
                        if (rank[state] ?? 0) > (rank[self.worstState[id] ?? "sending"] ?? 0) { self.worstState[id] = state }
                    }
                }
                let pendingIds = Set(app.commandSender?.pendingInputs(self.sessionId)
                    .compactMap { $0.payload["clientId"]?.stringValue } ?? [])
                for item in self.sent where self.echoLatency[item.clientId] == nil
                    && !item.clientId.hasPrefix("rejected") && !pendingIds.contains(item.clientId) {
                    self.echoLatency[item.clientId] = Date().timeIntervalSince(item.at)
                }
                if app.showsReconnecting { self.visibleReconnectingSeen = true }
                if let d = app.pulseManager?.lastDeliveryAt, d != self.lastSeenDelivery {
                    if let prev = self.lastSeenDelivery { self.deliveryGaps.append(d.timeIntervalSince(prev)) }
                    self.lastSeenDelivery = d
                }
                if app.isReconnecting {
                    if self.reconnectingSince == nil { self.reconnectingSince = Date() }
                } else if let since = self.reconnectingSince {
                    self.reconnectingSpells.append(Date().timeIntervalSince(since)); self.reconnectingSince = nil
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    private var pendingCount: Int { app.commandSender?.pendingInputs(sessionId).count ?? 0 }

    /// Waits for every accepted input to be echoed, then reconciles with the agent ledger.
    private func settleAndCheckDelivery(within seconds: TimeInterval, file: StaticString = #filePath, line: UInt = #line) async throws {
        let start = Date()
        try? await waitUntil(seconds, "all echoes") { self.pendingCount == 0 }
        metrics["settleSeconds"] = Date().timeIntervalSince(start)
        // The agent handles one turn at a time; queued inputs reach it later.
        var received: [String: Int] = [:]
        let deadline = Date().addingTimeInterval(max(10, seconds - Date().timeIntervalSince(start)))
        repeat {
            let ledger = try await control("GET", "/ledger?sessionId=\(sessionId)")
            received = ledger["received"] as? [String: Int] ?? [:]
            if sent.allSatisfy({ received[$0.text] != nil }) { break }
            await pause(0.2)
        } while Date() < deadline
        await pause(1) // a late duplicate would land here
        received = (try await control("GET", "/ledger?sessionId=\(sessionId)"))["received"] as? [String: Int] ?? received
        let lost = sent.filter { received[$0.text] == nil }.map(\.text)
        let duplicated = received.filter { $0.value > 1 }.map(\.key)
        let userVisibleFailures = worstState.filter { $0.value != "sending" }
        metrics["sent"] = sent.count
        metrics["lost"] = lost.count
        metrics["duplicated"] = duplicated.count
        metrics["stillPending"] = pendingCount
        metrics["failureStates"] = userVisibleFailures
        metrics["reconnectingSpells"] = reconnectingSpells
        let latencies = echoLatency.values.sorted()
        if !latencies.isEmpty {
            metrics["echoP50"] = latencies[latencies.count / 2]
            metrics["echoMax"] = latencies.last!
            metrics["echoP95"] = latencies[min(latencies.count - 1, Int(Double(latencies.count) * 0.95))]
        }
        metrics["stats"] = try await control("GET", "/stats")
        metrics["recoveryReasons"] = app.wsClient?.recoveryReasons ?? []
        metrics["maxDeliveryGap"] = deliveryGaps.max() ?? 0
        metrics["deliveryGapsOver10s"] = deliveryGaps.filter { $0 > 10 }.map { Int($0) }
        XCTAssertEqual(lost, [], "G1: every sent input reaches the agent", file: file, line: line)
        XCTAssertEqual(duplicated, [], "G2: exactly once", file: file, line: line)
        XCTAssertEqual(pendingCount, 0, "G1/G4: all inputs confirmed within \(seconds)s", file: file, line: line)
        XCTAssertEqual(userVisibleFailures, [:], "G3: no unconfirmed/failed/rejected state shown", file: file, line: line)
    }

    private func agentMessages() -> [String] {
        app.messageDatabase.messagesAfter(sessionId, afterSeq: 0, limit: 10_000)
            .filter { $0.type == "agent_message" }.compactMap(\.content)
    }

    private func checkInbound(within seconds: TimeInterval, file: StaticString = #filePath, line: UInt = #line) async throws {
        let start = Date()
        var emitted: [String] = []
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            emitted = (try await control("GET", "/ledger?sessionId=\(sessionId)"))["emitted"] as? [String] ?? emitted
            if agentMessages().count >= emitted.count, !emitted.isEmpty { break }
            await pause(0.2)
        }
        metrics["inboundCatchUpSeconds"] = Date().timeIntervalSince(start)
        let got = agentMessages()
        metrics["inboundMissing"] = emitted.count - Set(got).intersection(emitted).count
        XCTAssertEqual(got, emitted, "G7: all agent messages, in order, no duplicates", file: file, line: line)
    }

    private func connections() async throws -> Int {
        ((try await control("GET", "/stats"))["app"] as? [String: Any])?["total"] as? Int ?? 0
    }

    private func writeMetrics() {
        let dir = URL(fileURLWithPath: "/tmp/kraki-chaos/results", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let key = name.components(separatedBy: " ").last?.dropLast() ?? "unknown"
        metrics["scenario"] = String(key)
        if let data = try? JSONSerialization.data(withJSONObject: metrics, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: dir.appendingPathComponent("\(key).json"))
        }
    }

    // MARK: - Scenarios

    /// Stability summaries recorded by the production tracker in this run.
    private func stabilityMetrics() {
        metrics["readies"] = app.stability.readies.map {
            ["kind": $0.kind.rawValue, "outcome": $0.outcome.rawValue, "authedMs": $0.authedMs ?? -1,
             "viewCurrentMs": $0.viewCurrentMs ?? -1, "backgroundMs": $0.backgroundMs ?? -1, "attempts": $0.attempts]
        }
        metrics["outages"] = app.stability.outages.map {
            ["reason": $0.reason, "outcome": $0.outcome.rawValue, "detectMs": $0.detectMs,
             "reconnectMs": $0.reconnectMs ?? -1, "impactMs": $0.impactMs ?? -1, "visibleMs": $0.visibleMs, "attempts": $0.attempts]
        }
    }

    func test_S0_healthyBaseline() async throws {
        let cold = try XCTUnwrap(app.stability.readies.first, "the first connection records a cold opening")
        XCTAssertEqual(cold.kind, .cold)
        XCTAssertEqual(cold.outcome, .ready)
        XCTAssertNotNil(cold.authedMs)
        XCTAssertLessThan(try XCTUnwrap(cold.viewCurrentMs), 5_000)
        for i in 0..<5 { send("m\(i)"); await pause(0.3) }
        try await settleAndCheckDelivery(within: 10)
        try await checkInbound(within: 10)
    }

    /// A1: connection reset (NAT/proxy restart), network back in 1 s.
    func test_A1_flashReset() async throws {
        let before = try await connections()
        send("before")
        try await control("POST", "/reset", ["link": "app"])
        send("during")
        await pause(1)
        send("after")
        try await settleAndCheckDelivery(within: 15)
        metrics["reconnects"] = try await connections() - before
        metrics["visibleReconnecting"] = visibleReconnectingSeen
        XCTAssertLessThanOrEqual(metrics["reconnects"] as? Int ?? 99, 1, "G6: one outage, one reconnect")
        XCTAssertFalse(visibleReconnectingSeen, "G8: a sub-second blip never shows Reconnecting")
        stabilityMetrics()
        let outage = try XCTUnwrap(app.stability.outages.first, "the reset is recorded as one outage")
        XCTAssertEqual(app.stability.outages.count, 1)
        XCTAssertEqual(outage.outcome, .recovered)
        XCTAssertEqual(outage.visibleMs, 0, "matches what the user saw")
        XCTAssertLessThan(try XCTUnwrap(outage.impactMs), 5_000)
    }

    /// A2: relay unreachable for 15 s / 45 s; messages typed during the outage.
    func test_A2_outage15s() async throws { try await outage(15) }
    func test_A2_outage45s() async throws { try await outage(45) }

    private func outage(_ seconds: TimeInterval) async throws {
        try await fault("app", ["refuse": true])
        try await control("POST", "/reset", ["link": "app"])
        for i in 0..<3 { send("offline\(i)"); await pause(seconds / 4) }
        await pause(seconds / 4)
        let healedAt = Date()
        try await control("POST", "/heal")
        try await waitUntil(30, "reconnected") { self.app.connectionStatus == .connected }
        metrics["reconnectSeconds"] = Date().timeIntervalSince(healedAt)
        try await settleAndCheckDelivery(within: 10)
        // The relay becoming reachable again is not an OS network change, so it
        // is found by the next probe: at most 4 s apart (+20 % jitter) during
        // the first two minutes of an outage.
        XCTAssertLessThanOrEqual(metrics["reconnectSeconds"] as? Double ?? 99, 5, "G4: reconnect within one probe interval after the relay returns")
    }

    /// A3: half-open — the path silently drops everything, nothing is closed.
    func test_A3_halfOpen() async throws {
        send("before")
        try await waitUntil(10, "before echoed") { self.pendingCount == 0 }
        try await fault("app", ["blackhole": "both"])
        let start = Date()
        send("during")
        // Heal only new connections: keep the old one black-holed.
        try await waitUntil(60, "half-open detected") { self.app.connectionStatus != .connected }
        metrics["deadLinkDetectSeconds"] = Date().timeIntervalSince(start)
        try await control("POST", "/reset", ["link": "app"])
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 20)
        XCTAssertLessThanOrEqual(metrics["deadLinkDetectSeconds"] as? Double ?? 99, 30, "G5")
        stabilityMetrics()
        let outage = try XCTUnwrap(app.stability.outages.first, "the half-open link is recorded")
        XCTAssertTrue(["ping_timeout", "transport_silent"].contains(outage.reason), outage.reason)
        XCTAssertEqual(outage.outcome, .recovered)
        XCTAssertGreaterThan(outage.detectMs, 10_000, "detection time is the silent stretch, not ~0")
        XCTAssertLessThan(outage.detectMs, 31_000)
        XCTAssertGreaterThan(try XCTUnwrap(outage.impactMs), outage.detectMs)
    }

    /// B1: the incident profile — 3 Mbps shared downlink, an older client pulls
    /// a 2 MB report whole while this app opens another; the user keeps chatting.
    func test_B1_incidentProfile() async throws {
        let before = try await connections()
        try await fault("app", ["bytesPerSec": 375_000])
        let legacy = try await control("POST", "/attachment", ["bytes": 2_000_000, "sessionId": sessionId])
        let opened = try await control("POST", "/attachment", ["bytes": 2_000_000, "sessionId": sessionId])
        try await control("POST", "/legacy-pull", ["id": legacy["id"] as? String ?? "", "sessionId": sessionId])
        let reportId = opened["id"] as? String ?? ""
        app.attachmentStore.requestIfNeeded(id: reportId, sessionId: sessionId, priority: .userOpened)
        for i in 0..<5 { send("chat\(i)"); await pause(3) }
        try await settleAndCheckDelivery(within: 30)
        do {
            try await waitUntil(60, "report loaded") {
                if case .ready = self.app.attachmentStore.state(for: reportId) { return true }
                return false
            }
        } catch {
            metrics["reportState"] = String(describing: app.attachmentStore.state(for: reportId))
            metrics["transportReady"] = app.attachmentStore.transportReady
            throw error
        }
        try await control("POST", "/legacy-close")
        metrics["reconnects"] = try await connections() - before - 1 // the legacy client's own connection
        XCTAssertEqual(metrics["reconnects"] as? Int, 0, "G6: no liveness kill while data flows")
        XCTAssertLessThanOrEqual(metrics["echoP95"] as? Double ?? 99, 5, "G4: chat echoes stay fast under attachment load")
    }

    /// B1b: a much narrower link (~320 kbit/s) kept saturated by agent output.
    func test_B1b_saturatedByAgentOutput() async throws {
        let before = try await connections()
        try await fault("app", ["bytesPerSec": 40_000])
        // Eight 150 KB replies (~3 MB on the wire) keep a 40 KB/s link full for
        // ~75 s; each frame takes ~9 s. Echoes legitimately queue behind them.
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 8, "bytes": 150_000, "prefix": "bulk"])
        let bytes: [Int64] = []
        var series: [String] = []
        let t0 = Date()
        let probe = Task { @MainActor in
            while !Task.isCancelled {
                let stats = try? await self.control("GET", "/stats")
                let down = ((stats?["app"] as? [String: Any])?["bytes"] as? [String: Any])?["down"] as? Int ?? -1
                let age = self.app.pulseManager?.lastDeliveryAt.map { Date().timeIntervalSince($0) } ?? -1
                series.append("\(Int(Date().timeIntervalSince(t0))):\(down / 1000)k:\(Int(age))")
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        defer { probe.cancel(); self.metrics["series"] = series.joined(separator: " ") }
        for i in 0..<4 { send("congested\(i)"); await pause(5) }
        _ = bytes
        try await settleAndCheckDelivery(within: 150)
        metrics["reconnects"] = try await connections() - before
        XCTAssertEqual(metrics["reconnects"] as? Int, 0, "G6: no liveness kill while data flows")
    }

    /// B2: 20 s round-trip latency spike (bufferbloat / mobile handover), no loss.
    func test_B2_latencySpike() async throws {
        let before = try await connections()
        try await fault("app", ["latencyMs": 10_000]) // 20 s round trip
        send("spike")
        await pause(23)
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 40)
        metrics["reconnects"] = try await connections() - before
        XCTAssertEqual(metrics["reconnects"] as? Int, 0, "G6: a slow but live link is not killed")
    }

    /// C2: the connection dies right after the input is written.
    func test_C2_resetRightAfterSend() async throws {
        for i in 0..<3 {
            send("race\(i)")
            try await control("POST", "/reset", ["link": "app"])
            await pause(2)
        }
        try await settleAndCheckDelivery(within: 20)
    }

    /// C5: send immediately while (re)connecting.
    func test_C5_sendWhileReconnecting() async throws {
        try await fault("app", ["refuse": true])
        try await control("POST", "/reset", ["link": "app"])
        try await waitUntil(10, "disconnected") { self.app.connectionStatus != .connected }
        metrics["acceptedWhileOffline"] = send("offline")
        try await control("POST", "/heal")
        try await waitUntil(30, "reconnected") { self.app.connectionStatus == .connected }
        metrics["acceptedJustReconnected"] = send("justReconnected")
        try await settleAndCheckDelivery(within: 20)
    }

    /// C6: the app process dies before the input is confirmed, then relaunches.
    func test_C6_relaunchWithUnconfirmedInput() async throws {
        try await fault("app", ["blackhole": "both"])
        send("beforeKill")
        await pause(1)
        app.disconnect()
        app = nil
        try await control("POST", "/reset", ["link": "app"])
        try await control("POST", "/heal")
        // Relaunch with the same durable outbox (a new process, same install).
        app = AppState.makeNetworkHarness(relayPort: stack!.appPort, outboxURL: outboxURL)
        try await waitUntil(20, "connected") { self.app.connectionStatus == .connected && self.tentacleOnline }
        app.sessionSubscriptionController.setDesired(sessionId)
        try await settleAndCheckDelivery(within: 30)
    }

    /// D2: agent keeps working while the app is offline for 30 s.
    func test_D2_inboundDuringOutage() async throws {
        try await fault("app", ["refuse": true])
        try await control("POST", "/reset", ["link": "app"])
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 10, "prefix": "while-away"])
        await pause(30)
        try await control("POST", "/heal")
        try await waitUntil(30, "reconnected") { self.app.connectionStatus == .connected }
        try await checkInbound(within: 10)
    }

    /// E1: Head restarts (deploy) while inputs are in flight.
    func test_E1_headRestart() async throws {
        send("beforeRestart")
        try await control("POST", "/restart/head", ["downMs": 3_000])
        send("duringRestart")
        try await settleAndCheckDelivery(within: 45)
    }

    /// E3: the Tentacle process restarts while the app stays connected (the
    /// built-in Tentacle is replaced by every Mac app update). Live events for
    /// the open Session and for a background Session must keep reaching the app.
    func test_E3_tentacleRestartKeepsLiveEvents() async throws {
        let background = try await control("POST", "/session")["sessionId"] as? String ?? ""
        try await waitUntil(10, "background session listed") { self.app.sessionStore.sessions[background] != nil }
        try await control("POST", "/restart/tentacle", ["downMs": 2_000])
        try await waitUntil(20, "tentacle back") { self.tentacleOnline }
        await pause(2)
        send("afterRestart")
        try await control("POST", "/agent/burst", ["sessionId": background, "count": 1, "prefix": "bg-live"])
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 1, "prefix": "fg-live"])
        var bgPreview: String?
        try? await waitUntil(10, "background preview") {
            bgPreview = self.app.sessionStore.sessionPreviews[background]?.text
            return bgPreview?.contains("bg-live") == true
        }
        metrics["bgPreview"] = bgPreview ?? "nil"
        metrics["fgPreview"] = app.sessionStore.sessionPreviews[sessionId]?.text ?? "nil"
        XCTAssertTrue(bgPreview?.contains("bg-live") == true, "background card updates live after a Tentacle restart")
        XCTAssertTrue(app.sessionStore.sessionPreviews[sessionId]?.text.contains("fg-live") == true
            || agentMessages().contains { $0.contains("fg-live") }, "open session receives live output")
        try await settleAndCheckDelivery(within: 15)
    }

    /// E2: the Tentacle's link drops for 30 s; the user keeps typing.
    func test_E2_tentacleOffline30s() async throws {
        try await fault("tentacle", ["refuse": true])
        try await control("POST", "/reset", ["link": "tentacle"])
        for i in 0..<3 { send("agentAway\(i)"); await pause(8) }
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 45)
    }

    /// A4: one direction silently drops (asymmetric routing / broken NAT).
    func test_A4_downlinkOnlyBlackhole() async throws { try await oneWay("down") }
    func test_A4_uplinkOnlyBlackhole() async throws { try await oneWay("up") }

    private func oneWay(_ direction: String) async throws {
        try await fault("app", ["blackhole": direction])
        let start = Date()
        send("oneway")
        try await waitUntil(60, "one-way loss detected") { self.app.connectionStatus != .connected }
        metrics["deadLinkDetectSeconds"] = Date().timeIntervalSince(start)
        try await control("POST", "/reset", ["link": "app"])
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 20)
        XCTAssertLessThanOrEqual(metrics["deadLinkDetectSeconds"] as? Double ?? 99, 30, "G5")
    }

    /// A5: TCP connects but the WebSocket upgrade/auth never completes.
    func test_A5_handshakeStall() async throws {
        try await fault("app", ["stallHandshake": true])
        try await control("POST", "/reset", ["link": "app"])
        send("stalled")
        await pause(40)
        let stalledConnections = try await connections()
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 40)
        metrics["connectionsDuringStall"] = stalledConnections
        let live = ((try await control("GET", "/stats"))["app"] as? [String: Any])?["live"] as? Int ?? 99
        XCTAssertLessThanOrEqual(live, 2, "stalled attempts are abandoned, not accumulated")
    }

    /// A8/G9: a 3-minute outage keeps retrying but backs off (bounded cost).
    func test_A8_longOutageBackoff() async throws {
        try await fault("app", ["refuse": true])
        try await control("POST", "/reset", ["link": "app"])
        send("longOutage")
        await pause(180)
        // Count this client's attempts (a single attempt can open several
        // TCP connections, so proxy-side counts overstate it).
        let attempts = app.wsClient?.reconnectScheduledAt ?? []
        let lastMinute = attempts.filter { Date().timeIntervalSince($0) <= 60 }.count
        metrics["attemptsTotal"] = attempts.count
        metrics["attemptsLastMinute"] = lastMinute
        metrics["proxyRefusals"] = (try await timelineEvents()).filter {
            ($0["link"] as? String) == "app" && ($0["event"] as? String) == "refused"
        }.count
        let healedAt = Date()
        try await control("POST", "/heal")
        try await waitUntil(40, "reconnected") { self.app.connectionStatus == .connected }
        metrics["reconnectSeconds"] = Date().timeIntervalSince(healedAt)
        try await settleAndCheckDelivery(within: 20)
        XCTAssertLessThanOrEqual(lastMinute, 6, "G9: after 2 minutes, retry at most every ~15 s")
        XCTAssertLessThanOrEqual(metrics["reconnectSeconds"] as? Double ?? 99, 20)
    }

    private func timelineEvents() async throws -> [[String: Any]] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(stack!.controlPort)/timeline")!)
        req.timeoutInterval = 30
        let (data, _) = try await URLSession.shared.data(for: req)
        return (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
    }

    /// D1: the link drops while the agent is streaming a reply.
    func test_D1_outageMidStream() async throws {
        try await control("POST", "/agent/options", ["replyDelayMs": 100, "deltas": 30, "deltaIntervalMs": 200])
        send("stream")
        await pause(2)
        try await fault("app", ["refuse": true])
        try await control("POST", "/reset", ["link": "app"])
        await pause(12)
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 30)
        try await checkInbound(within: 15)
    }

    /// E2b: the Tentacle is away longer than the Relay keeps queued messages.
    func test_E2b_tentacleOffline6min() async throws {
        try await fault("tentacle", ["refuse": true])
        try await control("POST", "/reset", ["link": "tentacle"])
        send("longAway")
        await pause(370)
        try await control("POST", "/heal")
        try await settleAndCheckDelivery(within: 60)
    }

    /// F: seeded random faults on both links under a steady workload.
    /// /tmp/kraki-chaos/chaos.json {"seed": N, "iterations": M} overrides.
    func test_F_randomChaos() async throws {
        let config = (try? JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "/tmp/kraki-chaos/chaos.json")))) as? [String: Any]
        var rng = SeededRandom(seed: UInt64(config?["seed"] as? Int ?? 20260928))
        let iterations = config?["iterations"] as? Int ?? 3
        metrics["seed"] = config?["seed"] as? Int ?? 20260928
        metrics["iterations"] = iterations
        for _ in 0..<iterations {
            let link = rng.next() % 4 == 0 ? "tentacle" : "app"
            switch rng.next() % 6 {
            case 0: try await control("POST", "/reset", ["link": link])
            case 1: try await fault(link, ["refuse": true]); try await control("POST", "/reset", ["link": link])
            case 2: try await fault(link, ["blackhole": ["both", "up", "down"][Int(rng.next() % 3)]])
            case 3: try await fault(link, ["latencyMs": Int(rng.next() % 8_000), "jitterMs": Int(rng.next() % 2_000)])
            case 4: try await fault(link, ["bytesPerSec": 20_000 + Int(rng.next() % 200_000)])
            default: break
            }
            let duration = 3 + Double(rng.next() % 40)
            let end = Date().addingTimeInterval(duration)
            var i = 0
            while Date() < end {
                if rng.next() % 3 == 0 { send("chaos\(sent.count)") }
                if rng.next() % 5 == 0 {
                    try? await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 1, "prefix": "chaos-out-\(sent.count)-\(i)"])
                }
                i += 1
                await pause(1.5)
            }
            if [2].contains(rng.next() % 3) == false { try await control("POST", "/reset", ["link": link]) }
            try await control("POST", "/heal")
            await pause(Double(rng.next() % 5))
        }
        try await settleAndCheckDelivery(within: 90)
        try await checkInbound(within: 30)
    }

    // MARK: - G: single large messages on a slow link

    /// G1: one ~1 MB agent message on a 0.32 Mbit/s downlink (~45 s on the
    /// wire). Native WebSockets show no progress inside one frame, so a whole
    /// message looks like a dead link and is replaced forever; fragments keep
    /// delivering. The user keeps chatting meanwhile.
    func test_G1_largeDownlinkMessage() async throws {
        let before = try await connections()
        try await fault("app", ["bytesPerSec": 40_000])
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 1, "bytes": 1_000_000, "prefix": "huge"])
        await pause(3)
        send("duringHuge")
        try await checkInbound(within: 120)
        try await settleAndCheckDelivery(within: 60)
        metrics["reconnects"] = try await connections() - before
        XCTAssertEqual(metrics["reconnects"] as? Int, 0, "G6: a slow large message is not a dead link")
        XCTAssertEqual(app.wsClient?.recoveryReasons ?? [], [])
    }

    /// G2: the user sends a ~700 KB image on a 0.32 Mbit/s uplink (and its
    /// echo comes back down). Our own ping waits behind the upload.
    func test_G2_largeUplinkMessage() async throws {
        let before = try await connections()
        try await fault("app", ["bytesPerSec": 40_000])
        let image = Data((0..<700_000).map { UInt8(truncatingIfNeeded: $0 &* 2_654_435_761 >> 13) })
        let text = "image-\(UUID().uuidString.prefix(6))"
        let accepted = app.commandSender?.sendInput(
            sessionId: sessionId, text: text,
            attachments: [ImageAttachment(type: "image", mimeType: "image/png", data: image.base64EncodedString())]
        ) ?? false
        XCTAssertTrue(accepted)
        let clientId = app.commandSender?.pendingInputs(sessionId).first { $0.content == text }?
            .payload["clientId"]?.stringValue ?? "?"
        sent.append((text, clientId, Date()))
        try await settleAndCheckDelivery(within: 150)
        metrics["reconnects"] = try await connections() - before
        XCTAssertEqual(metrics["reconnects"] as? Int, 0, "G6: an upload in progress is not a dead link")
        XCTAssertEqual(app.wsClient?.recoveryReasons ?? [], [])
    }

    // MARK: - D3: background / foreground (iOS lifecycle)

    /// The user sends, then immediately leaves the app (lock/switch). The app
    /// closes its socket in the background; the agent keeps replying. On
    /// return: quick reconnect, no "Reconnecting" flash, everything caught up,
    /// the input delivered exactly once.
    func test_D3_backgroundThenForeground() async throws {
        send("beforeBackground")
        app.handleBackground()
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 4, "prefix": "while-backgrounded"])
        await pause(20)
        var flashed = false
        let foregroundAt = Date()
        app.handleForegroundRehydrate()
        try await waitUntil(15, "reconnected") {
            if self.app.showsReconnecting { flashed = true }
            return self.app.connectionStatus == .connected
        }
        metrics["reconnectSeconds"] = Date().timeIntervalSince(foregroundAt)
        await pause(3)
        flashed = flashed || app.showsReconnecting
        metrics["reconnectingShownAfterForeground"] = flashed
        try await settleAndCheckDelivery(within: 20)
        try await checkInbound(within: 10)
        XCTAssertLessThanOrEqual(metrics["reconnectSeconds"] as? Double ?? 99, 3, "G4: foreground reconnect is immediate")
        XCTAssertFalse(flashed, "G8: returning to the app must not flash Reconnecting for a normal quick reconnect")
        stabilityMetrics()
        let warm = try XCTUnwrap(app.stability.readies.last)
        XCTAssertEqual(warm.kind, .warm)
        XCTAssertEqual(warm.outcome, .ready)
        XCTAssertEqual(try XCTUnwrap(warm.backgroundMs), 20_000, accuracy: 3_000)
        XCTAssertLessThan(try XCTUnwrap(warm.viewCurrentMs), 3_000)
        XCTAssertTrue(app.stability.outages.isEmpty, "a background close is not an outage")
    }

    // MARK: - D4: several devices

    private func secondDevice() async throws -> AppState {
        let outbox = FileManager.default.temporaryDirectory.appendingPathComponent("kraki-net-outbox-b-\(UUID().uuidString).json")
        let b = AppState.makeNetworkHarness(relayPort: stack!.app2Port, outboxURL: outbox)
        try await waitUntil(20, "second device connected") {
            b.connectionStatus == .connected && b.sessionStore.sessions[self.sessionId] != nil
                && b.deviceStore.devices[self.stack!.tentacleId]?.online == true
        }
        b.sessionSubscriptionController.setDesired(sessionId)
        _ = b.messageProvider?.openSession(sessionId)
        try await waitUntil(10, "second device subscribed") { b.sessionSubscriptionController.liveReady }
        return b
    }

    private func spine(_ device: AppState) -> [ChatMessage] {
        device.messageDatabase.messagesAfter(sessionId, afterSeq: 0, limit: 10_000)
    }

    /// Device B loses its link for 30 s while A keeps chatting with the agent:
    /// A is unaffected; B catches up everything (A's messages and replies).
    func test_D4_oneDeviceOfflineOtherUnaffected() async throws {
        let b = try await secondDevice()
        defer { b.disconnect() }
        let before = try await connections()
        try await fault("app2", ["refuse": true])
        try await control("POST", "/reset", ["link": "app2"])
        for i in 0..<3 { send("fromA\(i)"); await pause(6) }
        try await control("POST", "/agent/burst", ["sessionId": sessionId, "count": 2, "prefix": "while-b-away"])
        await pause(8)
        try await settleAndCheckDelivery(within: 20)
        metrics["reconnectsA"] = try await connections() - before
        XCTAssertEqual(metrics["reconnectsA"] as? Int, 0, "A is not disturbed by B's outage")
        XCTAssertLessThanOrEqual(metrics["echoP95"] as? Double ?? 99, 5)

        let healedAt = Date()
        try await control("POST", "/heal", ["link": "app2"])
        let emitted = (try await control("GET", "/ledger?sessionId=\(sessionId)"))["emitted"] as? [String] ?? []
        let texts = sent.map(\.text)
        try await waitUntil(30, "B caught up") {
            let rows = self.spine(b)
            let agent = rows.filter { $0.type == "agent_message" }.compactMap(\.content)
            let users = Set(rows.filter { $0.type == "user_message" }.compactMap(\.content))
            return agent == emitted && texts.allSatisfy(users.contains)
        }
        metrics["bCatchUpSeconds"] = Date().timeIntervalSince(healedAt)
        let rows = spine(b)
        XCTAssertEqual(Set(rows.map(\.seq)).count, rows.count, "G7: no duplicate rows on B")
        XCTAssertLessThanOrEqual(metrics["bCatchUpSeconds"] as? Double ?? 99, 10, "G4: B catches up quickly")
    }

    /// Both devices type while A's link keeps flapping: every input from both
    /// is delivered exactly once and both see the same conversation.
    func test_D4_bothSendWhileOneFlaps() async throws {
        let b = try await secondDevice()
        defer { b.disconnect() }
        var bTexts: [String] = []
        for i in 0..<6 {
            send("A\(i)")
            let text = "B\(i)-\(UUID().uuidString.prefix(6))"
            XCTAssertTrue(b.commandSender?.sendInput(sessionId: sessionId, text: text) ?? false)
            bTexts.append(text)
            if i % 2 == 0 { try await control("POST", "/reset", ["link": "app"]) }
            await pause(2.5)
        }
        try await settleAndCheckDelivery(within: 40)
        try await waitUntil(40, "B inputs confirmed") { (b.commandSender?.pendingInputs(self.sessionId).count ?? 1) == 0 }
        let received = (try await control("GET", "/ledger?sessionId=\(sessionId)"))["received"] as? [String: Int] ?? [:]
        XCTAssertEqual(bTexts.filter { received[$0] != 1 }, [], "G1/G2: every input from B exactly once")
        try await waitUntil(20, "both converge") {
            self.spine(self.app).map(\.seq) == self.spine(b).map(\.seq) && !self.spine(b).isEmpty
        }
    }
}

/// SplitMix64: deterministic across runs so failures reproduce from the seed.
struct SeededRandom {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
