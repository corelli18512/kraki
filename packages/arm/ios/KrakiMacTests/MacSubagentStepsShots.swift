#if os(macOS) && DEBUG
import SwiftUI
import XCTest
@testable import Kraki_Dev

/// Renders the Mac Steps sheet with subagents — the turn's Steps (cards) and a
/// subagent's own page — from a trace shaped like a live Claude Code run with
/// two background subagents. PNGs go to KRAKI_SNAPSHOT_DIR.
@MainActor
final class MacSubagentStepsShots: XCTestCase {
    private var seq = 100

    private func entry(_ type: String, _ payload: [String: Any]) -> ChatMessage {
        seq += 1
        return ChatMessage(type: type, seq: seq, sessionId: "s", deviceId: nil, timestamp: nil,
                           payload: payload.mapValues { AnyCodable($0) })
    }

    func testRenderSubagentSteps() throws {
        guard let dir = ProcessInfo.processInfo.environment["KRAKI_SNAPSHOT_DIR"] else {
            throw XCTSkip("set KRAKI_SNAPSHOT_DIR to render")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        app.testOutboundMessageHandler = { _, _, _ in true }
        let report = "SUBAGENT REPORT: **src/deep/config.ts** — purple-otter-42"
        app.attachmentStore.ingestChunk(id: "rep-A", index: 0, total: 1, mimeType: "text/plain",
                                        data: Data(report.utf8).base64EncodedString(), error: nil)
        let ref: [String: Any] = ["type": "content_ref", "id": "rep-A", "mimeType": "text/plain", "size": report.utf8.count]
        let trace = [
            entry("agent_narration", ["content": "Delegating."]),
            entry("tool_start", ["toolName": "Agent", "headline": "Find codeword", "toolCallId": "A",
                                 "subagent": ["name": "general-purpose", "task": "Find codeword", "status": "running"]]),
            entry("tool_start", ["toolName": "Agent", "headline": "Count ts files", "toolCallId": "B",
                                 "subagent": ["name": "general-purpose", "task": "Count ts files", "status": "running"]]),
            entry("agent_narration", ["content": "I will grep.", "parentToolCallId": "A"]),
            entry("tool_start", ["toolName": "Bash", "headline": "$ grep -rn CODEWORD .", "toolCallId": "g", "parentToolCallId": "A"]),
            entry("tool_start", ["toolName": "Bash", "headline": "$ find . -name '*.ts' | wc -l", "toolCallId": "f", "parentToolCallId": "B"]),
            entry("agent_narration", ["content": "Waiting for the subagents."]),
            entry("tool_complete", ["toolName": "Bash", "headline": "$ grep -rn CODEWORD .", "toolCallId": "g", "parentToolCallId": "A"]),
            entry("tool_complete", ["toolName": "Agent", "headline": "Find codeword", "toolCallId": "A", "resultRef": ref,
                                    "subagent": ["name": "general-purpose", "task": "Find codeword", "status": "completed",
                                                 "tokens": 1003, "toolCount": 1, "durationMs": 9000]]),
        ]
        let bubble = 500
        try app.messageDatabase.insert("s", [ChatMessage(type: "agent_message", seq: bubble, sessionId: "s", deviceId: nil,
                                                          timestamp: nil, payload: ["content": AnyCodable("done")])])
        app.messageStore.setTurnSteps("s", bubbleSeq: bubble, trace)
        XCTAssertNotNil(app.messageStore.turnSteps("s", bubbleSeq: bubble))

        func render(_ name: String, path: [String]) throws {
            let view = MacStepsView(sessionId: "s", targetSeq: bubble, agent: "claude", store: app.messageStore,
                                    initialSubagentPath: path)
                .environment(app)
            let host = NSHostingView(rootView: view)
            let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 420, height: 480),
                                  styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = host
            window.orderFrontRegardless()
            for _ in 0..<30 { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: dir).appendingPathComponent("mac-\(name).png"))
            window.close()
        }
        try render("steps", path: [])
        try render("subagent-done", path: ["A"])
        try render("subagent-running", path: ["B"])
    }
}
#endif
