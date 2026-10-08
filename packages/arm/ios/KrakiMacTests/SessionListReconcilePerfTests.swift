import XCTest
@testable import Kraki_Dev

/// Manual perf probe (KRAKI_RUN_PERF_TESTS=1). Diag 2026-09-27→10-02:
/// `session_list.reconcile` cost 60–77 ms on iOS and 50–215 ms on Mac on the
/// main thread, on every reconnect / foreground, with ~56 sessions.
/// Applies a realistic 56-session list through the production router.
@MainActor
final class SessionListReconcilePerfTests: XCTestCase {
    static let device = "perf-tentacle"

    static func digest(_ i: Int, lastSeq: Int) -> [String: Any] {
        [
            "id": "perf-session-\(i)", "agent": "pi", "model": "deepseek-flash", "title": "Session \(i)",
            "state": i % 9 == 0 ? "active" : "idle", "mode": "auto", "lastSeq": lastSeq, "readSeq": lastSeq - (i % 3),
            "messageCount": lastSeq, "createdAt": "2026-09-01T00:00:00.000Z", "pinned": i < 3,
            "lastActivityAt": "2026-10-0\(1 + i % 7)T10:00:00.000Z",
            "preview": ["text": String(repeating: "preview text ", count: 8), "type": "agent_message",
                        "timestamp": "2026-10-0\(1 + i % 7)T10:00:00.000Z"],
            "usage": ["inputTokens": 1000, "outputTokens": 500, "cacheReadTokens": 100, "cacheWriteTokens": 10,
                      "totalCost": 0.01, "totalDurationMs": 1000, "contextTokens": 12_000],
        ]
    }

    static func list(_ n: Int, bump: Int = 0) throws -> Data {
        let sessions = (0..<n).map { digest($0, lastSeq: 40 + ($0 == 0 ? bump : 0)) }
        return try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": device, "seq": 1,
            "timestamp": ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(bump))),
            "payload": ["sessions": sessions, "archivedCount": 0, "autoArchiveDays": 14],
        ])
    }

    func testReconcile56Sessions() throws {
        try requireNativePerformanceTests()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("perf-sl-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let db = try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite"))
        for i in 0..<56 {
            let msgs = (1...40).map { seq in
                ChatMessage(type: seq % 2 == 1 ? "user_message" : "agent_message", seq: seq, sessionId: "perf-session-\(i)",
                            deviceId: Self.device, timestamp: "2026-09-01T00:00:00.000Z",
                            payload: ["content": AnyCodable(String(repeating: "x", count: 400))])
            }
            try db.insert("perf-session-\(i)", msgs)
        }
        let app = AppState(testDatabase: db)
        app.deviceStore.devices[Self.device] = DeviceSummary(
            id: Self.device, name: "perf", role: .tentacle, kind: .desktop, publicKey: nil,
            encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil)
        app.testOutboundMessageHandler = { _, _, _ in true }
        let router = try XCTUnwrap(app.messageRouter)
        var samples: [Double] = []
        for round in 0..<12 {
            let data = try Self.list(56, bump: round)
            let t0 = CFAbsoluteTimeGetCurrent()
            router.handleDataMessage(data)
            samples.append((CFAbsoluteTimeGetCurrent() - t0) * 1000)
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        let steady = samples.dropFirst().sorted()
        let line = String(format: "PERF session_list 56: first=%.1fms steady p50=%.1fms max=%.1fms",
                          samples[0], steady[steady.count / 2], steady.last ?? 0)
        print(line)
        try? line.write(toFile: "/tmp/kraki-perf-session-list.txt", atomically: true, encoding: .utf8)
    }
}
