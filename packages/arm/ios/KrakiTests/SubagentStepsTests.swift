import XCTest
import SwiftUI
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Subagent structure of Steps (shared by iOS and Mac). Shapes follow the
/// tentacle trace: dispatch steps carry `subagent`, a subagent's own steps
/// carry `parentToolCallId`, background subagents complete twice.
final class SubagentStepsTests: XCTestCase {
    private var seq = 0

    private func step(_ type: String, _ id: String? = nil, parent: String? = nil, subagent: [String: Any]? = nil,
                      extra: [String: Any] = [:]) -> ChatMessage {
        seq += 1
        var payload: [String: AnyCodable] = ["toolName": AnyCodable("tool"), "headline": AnyCodable("")]
        if let id { payload["toolCallId"] = AnyCodable(id) }
        if let parent { payload["parentToolCallId"] = AnyCodable(parent) }
        if let subagent { payload["subagent"] = AnyCodable(subagent) }
        for (k, v) in extra { payload[k] = AnyCodable(v) }
        return ChatMessage(type: type, seq: seq, sessionId: "s", deviceId: nil, timestamp: nil, payload: payload)
    }

    private func narration(_ text: String, parent: String? = nil) -> ChatMessage {
        seq += 1
        var payload: [String: AnyCodable] = ["content": AnyCodable(text)]
        if let parent { payload["parentToolCallId"] = AnyCodable(parent) }
        return ChatMessage(type: "agent_narration", seq: seq, sessionId: "s", deviceId: nil, timestamp: nil, payload: payload)
    }

    private func permission(_ id: String, description: String = "", toolName: String = "", decision: String? = nil, reason: String? = nil) -> ChatMessage {
        seq += 1
        var payload: [String: AnyCodable] = ["id": AnyCodable(id), "description": AnyCodable(description), "toolName": AnyCodable(toolName)]
        if let decision { payload["decision"] = AnyCodable(decision) }
        if let reason { payload["reason"] = AnyCodable(reason) }
        return ChatMessage(type: "permission", seq: seq, sessionId: "s", deviceId: nil, timestamp: nil, payload: payload)
    }

    /// The tentacle records a permission when asked and again when decided
    /// (decision only). Steps showed two "Permission request" rows with no
    /// outcome; now one row: the request and how it ended.
    func testPermissionRequestAndDecisionShowAsOneStep() {
        let trace = [
            permission("p1", description: "Edit win.txt", toolName: "edit"),
            step("tool_start", "t1"),
            permission("p1", decision: "approve"),
            step("tool_complete", "t1"),
            permission("p2", description: "Delete win.txt", toolName: "bash"),
            permission("p2", decision: "deny", reason: "keep it"),
        ]
        let merged = SubagentSteps.merge(trace)
        let permissions = merged.filter { $0.type == "permission" }
        XCTAssertEqual(permissions.count, 2)
        XCTAssertEqual(PermissionStep.title(permissions[0]), "Edit win.txt")
        XCTAssertEqual(PermissionStep.outcome(permissions[0]), "Approved")
        XCTAssertEqual(PermissionStep.title(permissions[1]), "Delete win.txt")
        XCTAssertEqual(PermissionStep.outcome(permissions[1]), "Denied: keep it")
        XCTAssertEqual(merged.first?.type, "permission", "stays where it was asked")
        XCTAssertNil(PermissionStep.outcome(permission("p3", description: "Open")))
    }

    func testTopLevelShowsDispatchCardsAndHidesSubagentSteps() {
        let trace = [
            narration("Delegating."),
            step("tool_start", "A", subagent: ["name": "scout", "task": "Find codeword", "status": "running"]),
            narration("I will grep.", parent: "A"),
            step("tool_start", "g1", parent: "A"),
            step("tool_complete", "g1", parent: "A"),
            step("tool_complete", "A", subagent: ["name": "scout", "status": "completed", "tokens": 1200]),
        ]
        let merged = SubagentSteps.merge(trace)
        let top = SubagentSteps.steps(merged, under: nil)
        XCTAssertEqual(top.map(\.type), ["agent_narration", "tool_complete"])
        let card = top[1]
        XCTAssertTrue(SubagentSteps.isSubagentStep(merged, card))
        // Start info (task) is kept when the completion omits it.
        XCTAssertEqual(SubagentSteps.info(of: card), SubagentInfo(name: "scout", task: "Find codeword", status: .completed, tokens: 1200))
        XCTAssertEqual(SubagentSteps.steps(merged, under: "A").map(\.type), ["agent_narration", "tool_complete"])
        XCTAssertEqual(SubagentSteps.stepCount(merged, "A"), 1)
        XCTAssertEqual(SubagentSteps.cardMeta(merged, card), "1 step")
        XCTAssertEqual(SubagentSteps.pageFacts(merged, card), "Done · 1 step · 1.2k tokens")
    }

    func testBackgroundSubagentStaysRunningThenTakesItsLaterCompletion() {
        var trace = [
            step("tool_start", "A", subagent: ["name": "general-purpose", "status": "running"]),
            step("tool_start", "b1", parent: "A"),
        ]
        var merged = SubagentSteps.merge(trace)
        XCTAssertEqual(SubagentSteps.status(of: SubagentSteps.steps(merged, under: nil)[0]), .running)
        XCTAssertEqual(SubagentSteps.cardMeta(merged, merged[0]), "Running · 1 step")
        trace.append(step("tool_complete", "b1", parent: "A"))
        trace.append(step("tool_complete", "A", subagent: ["name": "general-purpose", "status": "running"]))
        trace.append(step("tool_complete", "A", subagent: ["name": "general-purpose", "status": "completed", "durationMs": 9000]))
        merged = SubagentSteps.merge(trace)
        let top = SubagentSteps.steps(merged, under: nil)
        XCTAssertEqual(top.count, 1, "a second completion replaces the first in place")
        XCTAssertEqual(SubagentSteps.status(of: top[0]), .completed)
        XCTAssertEqual(SubagentSteps.cardMeta(merged, top[0]), "1 step · 9s")
    }

    func testNestedSubagentsAndGroupDispatch() {
        // pi parallel: the tool call is a group; each child is a synthetic dispatch.
        let trace = [
            step("tool_start", "P", subagent: ["name": "parallel", "task": "2 subagents"]),
            step("tool_start", "P#0", parent: "P", subagent: ["name": "scout"]),
            step("tool_start", "P#0:x", parent: "P#0"),
            step("tool_complete", "P#0:x", parent: "P#0"),
            step("tool_complete", "P#0", parent: "P", subagent: ["name": "scout", "status": "completed"]),
            step("tool_complete", "P", subagent: ["name": "parallel", "status": "completed"]),
        ]
        let merged = SubagentSteps.merge(trace)
        XCTAssertEqual(SubagentSteps.cardMeta(merged, merged[0]), "1 subagent", "a group counts subagents, not steps")
        XCTAssertEqual(SubagentSteps.steps(merged, under: nil).compactMap(\.toolCallId), ["P"])
        XCTAssertEqual(SubagentSteps.steps(merged, under: "P").compactMap(\.toolCallId), ["P#0"])
        XCTAssertTrue(SubagentSteps.isSubagentStep(merged, SubagentSteps.steps(merged, under: "P")[0]))
        XCTAssertEqual(SubagentSteps.steps(merged, under: "P#0").compactMap(\.toolCallId), ["P#0:x"])
    }

    func testPlainToolsAndOrphansAreUnchanged() {
        let trace = [
            step("tool_start", "t1"),
            step("tool_complete", "t1", extra: ["success": false]),
            step("tool_start", "o1", parent: "missing"),
        ]
        let merged = SubagentSteps.merge(trace)
        let top = SubagentSteps.steps(merged, under: nil)
        XCTAssertEqual(top.compactMap(\.toolCallId), ["t1", "o1"], "a step whose subagent is not in this trace stays visible")
        XCTAssertFalse(SubagentSteps.isSubagentStep(merged, top[0]))
        XCTAssertEqual(SubagentSteps.status(of: top[0]), .failed)
    }

    func testStoppedTurnMarksRunningDispatchStopped() {
        let trace = [
            step("tool_start", "A", subagent: ["name": "worker", "status": "running"]),
            step("tool_complete", "A", subagent: ["name": "worker", "status": "stopped"], extra: ["success": false, "termination": "cancelled"]),
        ]
        let merged = SubagentSteps.merge(trace)
        XCTAssertEqual(SubagentSteps.status(of: merged[0]), .stopped)
        XCTAssertEqual(SubagentSteps.pageFacts(merged, merged[0]), "Stopped")
    }
}

extension SubagentStepsTests {
    func testReportTextRendersBulletsAndHeadings() {
        let text = String(SubagentPageView<EmptyView>.reportText("## Result\n- **File:** a.ts\n- Code: x").characters)
        XCTAssertEqual(text, "Result\n• File: a.ts\n• Code: x")
    }
}
