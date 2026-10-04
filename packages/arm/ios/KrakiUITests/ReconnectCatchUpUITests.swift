import XCTest

/// Reconnect / catch-up journeys against the local chaos stack
/// (packages/tests/src/chaos/stack.ts): real Head + real Tentacle with a
/// scripted agent, plus a second device ("the Mac") that talks in the session.
/// Runs only when TEST_RUNNER_KRAKI_CHAOS_CONTROL is set (driver script).
final class ReconnectCatchUpUITests: XCTestCase {
    private var control = 0
    private var sessionId = ""
    private var out = "/tmp/kraki-repro"
    private var app: XCUIApplication!
    private var marker = "好了"

    // MARK: Chaos control

    @discardableResult
    private func call(_ method: String, _ path: String, _ body: [String: Any] = [:]) -> [String: Any] {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(control)\(path)")!)
        req.httpMethod = method
        if method == "POST" { req.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        let done = DispatchSemaphore(value: 0)
        var result: [String: Any] = [:]
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { result = json }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        return result
    }

    private func log(_ line: String) {
        let stamped = "\(String(format: "%.2f", Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1000))) \(line)\n"
        print("REPRO \(line)")
        let url = URL(fileURLWithPath: "\(out)/\(name.replacingOccurrences(of: " ", with: "_")).log")
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(stamped.utf8)); try? h.close() }
        else { try? Data(stamped.utf8).write(to: url) }
    }

    private func shot(_ tag: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: "\(out)/\(name.filter { $0.isLetter || $0.isNumber })-\(tag).png"))
    }

    override func setUpWithError() throws {
        let env = ProcessInfo.processInfo.environment
        guard let port = env["KRAKI_CHAOS_CONTROL"].flatMap(Int.init) else { throw XCTSkip("chaos stack E2E only") }
        control = port
        out = env["KRAKI_REPRO_OUT"] ?? out
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        let info = call("GET", "/info")
        let appPort = info["appPort"] as? Int ?? 0
        // Fresh Session per journey with a short, fully landed history.
        call("POST", "/agent/options", ["replyDelayMs": 20, "tools": 0, "deltas": 1, "deltaIntervalMs": 10, "padWords": 0])
        sessionId = call("POST", "/session")["sessionId"] as? String ?? ""
        XCTAssertFalse(sessionId.isEmpty)
        call("POST", "/agent/burst", ["sessionId": sessionId, "count": 24, "prefix": "历史回复"])
        for _ in 0..<100 {
            let emitted = (call("GET", "/ledger?sessionId=\(sessionId)")["emitted"] as? [Any])?.count ?? 0
            if emitted >= 24 { break }
            usleep(200_000)
        }
        marker = "好了\(Int.random(in: 100...999))"
        continueAfterFailure = true
        addUIInterruptionMonitor(withDescription: "notifications") { alert in
            for label in ["Allow", "允许"] where alert.buttons[label].exists { alert.buttons[label].tap(); return true }
            return false
        }
        app = XCUIApplication()
        app.launchEnvironment["KRAKI_DEV_LOGIN"] = "1"
        app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = String(appPort)
        app.launchEnvironment["KRAKI_OPEN_SESSION_ID"] = sessionId
        app.launchEnvironment["KRAKI_E2E_ALLOW_PUSH_PROMPT"] = "1"
        app.launch()
        let devLogin = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Dev Login")).firstMatch
        if devLogin.waitForExistence(timeout: 6) { devLogin.tap() }
        // The first sign-in asks for notification permission (system alert).
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow", "允许"] {
            let allow = springboard.alerts.buttons[label]
            if allow.waitForExistence(timeout: 4) { allow.tap(); break }
        }
    }

    override func tearDown() {
        app?.terminate()
        super.tearDown()
    }

    // MARK: Screen probes

    private func has(_ fragment: String) -> Bool {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch.exists
            || app.textViews.containing(NSPredicate(format: "value CONTAINS %@", fragment)).firstMatch.exists
            || app.otherElements.containing(NSPredicate(format: "label CONTAINS %@", fragment)).firstMatch.exists
    }

    private var spinner: Bool { app.activityIndicators["Loading latest messages"].exists }

    private struct Frame { let t: Double; let spinner: Bool; let ok: Bool; let live: Bool; let final: Bool
        let anySpinner: Bool; let step: Bool; let title: String }

    /// Sample the screen until `seconds` elapse; return the timeline.
    private func observe(_ seconds: Double, tag: String) -> [Frame] {
        let start = Date()
        var frames: [Frame] = []
        var last = ""
        while Date().timeIntervalSince(start) < seconds {
            let title = ["Connecting…", "Syncing…", "Reconnecting…"].first { app.staticTexts[$0].exists || app.buttons[$0].exists } ?? "-"
            let f = Frame(t: Date().timeIntervalSince(start), spinner: spinner, ok: has(marker),
                          live: has("reply to \(marker)"), final: has("w40") && has("reply to \(marker)"),
                          anySpinner: app.activityIndicators.count > 0, step: has("step "), title: title)
            let sig = "spinner=\(f.spinner ? 1 : 0) ok=\(f.ok ? 1 : 0) step=\(f.step ? 1 : 0) live=\(f.live ? 1 : 0) final=\(f.final ? 1 : 0) anySpinner=\(f.anySpinner ? 1 : 0) title=\(f.title)"
            if sig != last {
                log("[\(tag)] +\(String(format: "%.1f", f.t))s \(sig)")
                shot("\(tag)-\(frames.count)")
                last = sig
            }
            frames.append(f)
            usleep(250_000)
        }
        return frames
    }

    private func waitInSession() {
        XCTAssertTrue(app.buttons["Send message"].waitForExistence(timeout: 40), "session page visible")
        sleep(2)
    }

    private func slowTurn() {
        call("POST", "/agent/options", ["replyDelayMs": 500, "tools": 8, "toolIntervalMs": 1500,
                                        "deltas": 20, "deltaIntervalMs": 600, "padWords": 40])
    }

    private func backToList() {
        let back = app.buttons["Back"]
        if back.exists { back.tap() } else { app.swipeRight() }
        sleep(1)
    }

    private func openSessionFromList() {
        // Newest Session sits first in the list.
        let row = app.cells.firstMatch
        if row.waitForExistence(timeout: 10) { row.tap() } else { log("NO ROW: \(app.debugDescription.prefix(3000))") }
    }

    private func summarize(_ frames: [Frame], tag: String) {
        let firstOK = frames.first { $0.ok }?.t
        let firstLive = frames.first { $0.live }?.t
        let spinnerUntil = frames.last { $0.spinner }?.t
        let okAfterSpinner = frames.contains { !$0.spinner && $0.t > (spinnerUntil ?? 0) && !$0.ok }
        let cardBeforeOK = frames.contains { ($0.step || $0.live) && !$0.ok }
        let listSpinner = frames.contains { $0.anySpinner && !$0.spinner && !$0.step }
        let reconnectWord = frames.contains { $0.title == "Reconnecting…" }
        log("[\(tag)] CHECK cardBeforeOK=\(cardBeforeOK) listSpinner=\(listSpinner) reconnectingText=\(reconnectWord)")
        log("[\(tag)] SUMMARY spinnerUntil=\(spinnerUntil.map { String(format: "%.1f", $0) } ?? "-") firstOK=\(firstOK.map { String(format: "%.1f", $0) } ?? "never") firstLive=\(firstLive.map { String(format: "%.1f", $0) } ?? "never") contentWithoutOK=\(okAfterSpinner)")
    }

    // MARK: Journeys

    /// Probe: dump the accessibility tree once so selectors can be checked.
    func test0Probe() {
        waitInSession()
        try? app.debugDescription.write(toFile: "\(out)/tree-session.txt", atomically: true, encoding: .utf8)
        backToList()
        try? app.debugDescription.write(toFile: "\(out)/tree-list.txt", atomically: true, encoding: .utf8)
    }

    /// Phone was showing the session, went to the background; the Mac replied
    /// "好了" and the turn is running; the phone comes back.
    func test1BackgroundInSessionThenMacReplies() {
        waitInSession()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(4)
        app.activate()
        let frames = observe(30, tag: "inSession")
        summarize(frames, tag: "inSession")
    }

    /// Same, but the phone was on the Session list and taps into the Session.
    func test2BackgroundOnListThenOpen() {
        waitInSession()
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(4)
        app.activate()
        sleep(1)
        openSessionFromList()
        let frames = observe(30, tag: "fromList")
        summarize(frames, tag: "fromList")
    }

    /// The user's real sequence: the Tentacle restarted (app update) while the
    /// phone was away, then the Mac replied, then the phone opened the Session.
    func test3TentacleRestartWhileAway() {
        waitInSession()
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(2)
        call("POST", "/restart/tentacle", ["downMs": 3000])
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(5)
        app.activate()
        sleep(1)
        openSessionFromList()
        let frames = observe(35, tag: "restart")
        summarize(frames, tag: "restart")
    }

    /// The phone's network drops (not backgrounded) while the Mac replies.
    func test4NetworkDropWhileViewing() {
        waitInSession()
        slowTurn()
        call("POST", "/fault", ["link": "app", "refuse": true])
        call("POST", "/reset", ["link": "app"])
        sleep(2)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(6)
        call("POST", "/heal", [:])
        let frames = observe(35, tag: "netDrop")
        summarize(frames, tag: "netDrop")
    }

    /// Real Sessions alternate user/agent turns and are long. Seed one through
    /// the second device so the history has real turns.
    private func seedConversation(turns: Int) {
        call("POST", "/agent/options", ["replyDelayMs": 10, "tools": 0, "deltas": 1, "deltaIntervalMs": 5, "padWords": 60])
        for i in 1...turns { call("POST", "/peer/input", ["text": "问题 \(i)", "sessionId": sessionId]) }
        for _ in 0..<300 {
            let emitted = (call("GET", "/ledger?sessionId=\(sessionId)")["emitted"] as? [Any])?.count ?? 0
            if emitted >= 24 + turns { break }
            usleep(200_000)
        }
    }

    /// The suspected iOS case: a long Session the user scrolled back through
    /// earlier (the in-memory window no longer ends at the newest message),
    /// then the phone goes away, the Mac replies, and the phone opens it again.
    func test6ScrolledHistoryThenAwayThenOpen() {
        seedConversation(turns: 70)
        waitInSession()
        sleep(3)
        for _ in 0..<25 { app.swipeDown(velocity: .fast) }
        sleep(2)
        log("scrolled up; top visible: \(has("问题 1 ") || has("历史回复 1/24"))")
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(5)
        app.activate()
        sleep(1)
        openSessionFromList()
        let frames = observe(30, tag: "scrolledThenAway")
        summarize(frames, tag: "scrolledThenAway")
    }

    /// Same, but the user stays inside the scrolled-back Session.
    func test7ScrolledInSessionThenAway() {
        seedConversation(turns: 70)
        waitInSession()
        sleep(3)
        for _ in 0..<25 { app.swipeDown(velocity: .fast) }
        sleep(2)
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(5)
        app.activate()
        sleep(2)
        // Jump to the bottom the way a user would.
        let down = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'latest' OR label CONTAINS[c] 'bottom'")).firstMatch
        log("down control: \(down.exists ? down.label : "none")")
        if down.exists { down.tap() } else { for _ in 0..<25 { app.swipeUp(velocity: .fast) } }
        let frames = observe(25, tag: "scrolledInSession")
        summarize(frames, tag: "scrolledInSession")
    }

    /// The user's log: the catch-up reply was sent but never arrived (the
    /// downlink stalled), the socket died ~10 s later and the phone reconnected.
    func test8CatchUpReplyLostThenReconnect() {
        seedConversation(turns: 40)
        waitInSession()
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(4)
        // Hold everything the Head sends to the phone from the moment it returns.
        call("POST", "/fault", ["link": "app", "blackhole": "down"])
        app.activate()
        sleep(1)
        openSessionFromList()
        var frames = observe(8, tag: "lost-stalled")
        call("POST", "/reset", ["link": "app"])
        call("POST", "/heal", [:])
        log("link reset + healed")
        frames += observe(25, tag: "lost-afterReconnect")
        summarize(frames, tag: "lost")
    }

    /// Slow cellular-like downlink: a large catch-up batch takes a long time.
    func test9SlowLinkCatchUp() {
        seedConversation(turns: 40)
        waitInSession()
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(4)
        call("POST", "/fault", ["link": "app", "bytesPerSec": 15_000, "latencyMs": 300])
        app.activate()
        sleep(1)
        openSessionFromList()
        let frames = observe(40, tag: "slow")
        call("POST", "/heal", [:])
        summarize(frames, tag: "slow")
    }

    /// Only the catch-up batch is lost; session list / subscription arrive.
    /// Does the page wait (spinner), and does it ever recover on its own?
    func test10OnlyCatchUpBatchLost() {
        seedConversation(turns: 40)
        waitInSession()
        backToList()
        slowTurn()
        XCUIDevice.shared.press(.home)
        sleep(3)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(4)
        call("POST", "/tentacle/drop-batches", ["count": 1])
        app.activate()
        sleep(1)
        openSessionFromList()
        let frames = observe(40, tag: "batchLost")
        summarize(frames, tag: "batchLost")
        let events = call("GET", "/events?n=40")
        log("events: \(events)")
        backToList()
        openSessionFromList()
        let again = observe(10, tag: "batchLost-reenter")
        summarize(again, tag: "batchLost-reenter")
    }

    /// Notification tap: the Mac's turn finished while the phone was away; the
    /// phone gets a push and the user taps it.
    func test5OpenFromNotification() {
        waitInSession()
        backToList()
        call("POST", "/agent/options", ["replyDelayMs": 300, "tools": 2, "toolIntervalMs": 400,
                                        "deltas": 4, "deltaIntervalMs": 200, "padWords": 40])
        XCUIDevice.shared.press(.home)
        sleep(2)
        call("POST", "/peer/input", ["text": marker, "sessionId": sessionId])
        sleep(8)
        try? sessionId.write(toFile: "\(out)/push-go", atomically: true, encoding: .utf8)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let banner = springboard.otherElements["Notification"].descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", "w40")).firstMatch
        let any = springboard.otherElements.matching(NSPredicate(format: "identifier == 'NotificationShortLookView' OR label CONTAINS 'Kraki'")).firstMatch
        if banner.waitForExistence(timeout: 15) { banner.tap() }
        else if any.waitForExistence(timeout: 5) { any.tap() }
        else { log("NO BANNER"); try? springboard.debugDescription.write(toFile: "\(out)/tree-springboard.txt", atomically: true, encoding: .utf8); app.activate() }
        let frames = observe(20, tag: "push")
        summarize(frames, tag: "push")
    }
}
