import XCTest
import SwiftUI
import AppKit
@testable import Kraki_Dev

/// Manual profiling scenario (KRAKI_RUN_PERF_TESTS=1), driven by
/// scripts/perf/profile-mac.sh with `xctrace record --attach <pid>`.
/// Production MainWindowView (sidebar + chat) with 56 sessions × 40 messages.
@MainActor
final class MacMainThreadProfileScenarioTests: XCTestCase {
    static let device = "profile-tentacle"
    static let scope = "profile-scenario"
    private var root: URL!
    private var app: AppState!
    private var window: NSWindow!
    private var round = 0

    private func drain(_ ms: Int) { RunLoop.main.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
    private static let para = "这是一段比较典型的回答内容，包含 **加粗**、`inline code` 和一个[链接](https://example.com)。\n\n"
    private static let code = "```swift\nfunc load() async throws {\n    let (data, _) = try await session.data(for: req)\n    try decode(data)\n}\n```\n\n"

    private func digest(_ i: Int, bump: Int) -> [String: Any] {
        let ts = String(format: "2026-10-%02dT%02d:%02d:00.000Z", 1 + i % 7, i % 24, i == bump % 56 ? bump % 60 : 0)
        return ["id": "s\(i)", "agent": "pi", "model": "deepseek-flash", "title": "会话 \(i) 标题比较长一点",
                "state": i % 9 == 0 ? "active" : "idle", "mode": "auto", "lastSeq": 40, "readSeq": 40 - (i % 3),
                "messageCount": 40, "createdAt": "2026-09-01T00:00:00.000Z", "pinned": i < 3, "lastActivityAt": ts,
                "preview": ["text": "最后一条消息的预览 " + String(repeating: "文字", count: 20), "type": "agent_message", "timestamp": ts],
                "usage": ["inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 100, "cacheWriteTokens": 10,
                          "totalCost": 0.01, "totalDurationMs": 1000, "contextTokens": 12_000]]
    }

    /// A reconnect: one session changed since the last list (as in reality).
    private func applySessionList() throws {
        round += 1
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": Self.device, "seq": 1,
            "timestamp": ISO8601.withFractional.string(from: Date()),
            "payload": ["sessions": (0..<56).map { digest($0, bump: round) }, "archivedCount": 0, "autoArchiveDays": 14]]))
    }

    override func setUpWithError() throws {
        try requireNativePerformanceTests()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("mac-profile-\(UUID().uuidString)")
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        for i in 0..<56 {
            try db.insert("s\(i)", (1...40).map { seq in
                ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: "s\(i)",
                            deviceId: Self.device, timestamp: "2026-10-08T10:00:00.000Z",
                            payload: ["content": AnyCodable(seq % 2 == 1 ? "帮我看看 \(seq)" : String(repeating: Self.para, count: 3) + Self.code)])
            })
        }
        app = AppState(testDatabase: db)
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.deviceStore.addDevice(DeviceSummary(id: Self.device, name: "Mac", role: .tentacle, kind: .desktop,
                                                publicKey: nil, encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        try applySessionList()
        let view = MainWindowView(selectionNotificationScope: Self.scope)
            .environment(app).environment(TentacleCLIManager())
        window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 1200, height: 800),
                          styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.level = .floating
        window.orderFrontRegardless()
        drain(1_500)
        try? "\(getpid())".write(toFile: "/tmp/kraki-profile-ready", atomically: true, encoding: .utf8)
        let deadline = Date().addingTimeInterval(90)
        while !FileManager.default.fileExists(atPath: "/tmp/kraki-profile-go"), Date() < deadline { drain(100) }
        try? FileManager.default.removeItem(atPath: "/tmp/kraki-profile-go")
        try? FileManager.default.removeItem(atPath: "/tmp/kraki-profile-ready")
    }

    override func tearDown() {
        window?.orderOut(nil); window?.contentView = nil; window = nil; app = nil
        if let root { try? FileManager.default.removeItem(at: root) }
        super.tearDown()
    }

    private func select(_ i: Int) {
        NotificationCenter.default.post(name: .macSelectSession, object: nil,
                                        userInfo: ["sessionId": "s\(i)", "scope": Self.scope])
    }

    func testPhaseOpenSessions() throws {
        for n in 0..<24 { select(n * 5 % 56); drain(800) }
    }

    func testPhaseSessionList() throws {
        select(5); drain(800)
        for _ in 0..<30 { try applySessionList(); drain(400) }
    }

    func testPhaseStreaming() throws {
        select(7); drain(1_000)
        let sub = try XCTUnwrap(app.sessionSubscriptionController)
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_subscription_set", "deviceId": Self.device, "payload": ["accepted": true, "sessionId": "s7"]]))
        drain(100)
        XCTAssertTrue(sub.acceptsLive("s7"))
        app.messageStore.beginCardTurn("s7")
        let source = (String(repeating: Self.para, count: 6) + Self.code) as NSString
        for k in 0..<400 {
            let chunk = source.substring(with: NSRange(location: (k * 7) % (source.length - 8), length: 7))
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
                "type": "agent_message_delta", "sessionId": "s7", "deviceId": Self.device,
                "payload": ["content": chunk, "reset": false]]))
            drain(33)
        }
        XCTAssertGreaterThan(app.messageStore.cards["s7"]?.text.count ?? 0, 1_000)
    }
}
