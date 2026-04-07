import XCTest
@testable import Kraki

final class TurnGrouperTests: XCTestCase {

    // MARK: - Helper

    private func makeMsg(
        type: String,
        seq: Int = 1,
        sessionId: String = "sess-1",
        payload: [String: AnyCodable] = [:]
    ) -> ChatMessage {
        ChatMessage(
            type: type, seq: seq, sessionId: sessionId,
            deviceId: "dev-1", timestamp: "2024-01-01T00:00:00Z",
            payload: payload
        )
    }

    private func makeTool(
        type: String = "tool_start",
        seq: Int = 1,
        toolCallId: String? = nil,
        toolName: String = "shell",
        args: [String: AnyCodable] = [:],
        result: String? = nil
    ) -> ChatMessage {
        var payload: [String: AnyCodable] = [
            "toolName": AnyCodable(toolName),
            "args": AnyCodable(args),
        ]
        if let toolCallId {
            payload["toolCallId"] = AnyCodable(toolCallId)
        }
        if let result {
            payload["result"] = AnyCodable(result)
        }
        return makeMsg(type: type, seq: seq, payload: payload)
    }

    // MARK: - Basic

    func testEmptyMessages() {
        let result = groupMessagesIntoTurns([])
        XCTAssertTrue(result.isEmpty)
    }

    func testSingleUserMessage() {
        let msgs = [makeMsg(type: "user_message")]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "user_message")
        } else {
            XCTFail("Expected standalone")
        }
    }

    func testSingleAgentMessage() {
        let msgs = [makeMsg(type: "agent_message", payload: ["content": AnyCodable("hi")])]
        let result = groupMessagesIntoTurns(msgs)
        // No idle, so turn is still active
        XCTAssertEqual(result.count, 1)
        if case .turn(let turn) = result[0] {
            XCTAssertTrue(turn.isActive)
            XCTAssertEqual(turn.thinkingMessages.count, 1)
            XCTAssertNil(turn.finalMessage)
        } else {
            XCTFail("Expected turn")
        }
    }

    func testUserThenAgent() {
        let msgs = [
            makeMsg(type: "user_message", seq: 1),
            makeMsg(type: "agent_message", seq: 2, payload: ["content": AnyCodable("reply")]),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 2)

        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "user_message")
        } else { XCTFail("Expected standalone user") }

        if case .turn(let turn) = result[1] {
            XCTAssertFalse(turn.isActive)
            XCTAssertNotNil(turn.finalMessage)
            XCTAssertEqual(turn.finalMessage?.content, "reply")
            XCTAssertTrue(turn.thinkingMessages.isEmpty)
        } else { XCTFail("Expected turn") }
    }

    func testMultipleAgentMessages() {
        let msgs = [
            makeMsg(type: "agent_message", seq: 1, payload: ["content": AnyCodable("thinking…")]),
            makeMsg(type: "agent_message", seq: 2, payload: ["content": AnyCodable("final answer")]),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .turn(let turn) = result[0] {
            // Last agent_message becomes final, rest in thinking
            XCTAssertEqual(turn.finalMessage?.content, "final answer")
            XCTAssertEqual(turn.thinkingMessages.count, 1)
            XCTAssertEqual(turn.thinkingMessages[0].content, "thinking…")
        } else { XCTFail("Expected turn") }
    }

    // MARK: - Tool Merging

    func testToolStartAndComplete() {
        let msgs = [
            makeTool(type: "tool_start", seq: 1, toolCallId: "tc-1", toolName: "shell"),
            makeTool(type: "tool_complete", seq: 2, toolCallId: "tc-1", toolName: "shell", result: "done"),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .turn(let turn) = result[0] {
            // tool_start replaced by tool_complete (merged)
            XCTAssertEqual(turn.thinkingMessages.count, 1)
            XCTAssertEqual(turn.thinkingMessages[0].type, "tool_complete")
        } else { XCTFail("Expected turn") }
    }

    func testToolStartAndCompleteMergeArgs() {
        let msgs = [
            makeTool(type: "tool_start", seq: 1, toolCallId: "tc-1", toolName: "shell",
                args: ["command": AnyCodable("ls")]),
            makeTool(type: "tool_complete", seq: 2, toolCallId: "tc-1", toolName: "shell",
                args: ["output": AnyCodable("file.txt")], result: "ok"),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        if case .turn(let turn) = result[0] {
            let merged = turn.thinkingMessages[0]
            let args = merged.args
            XCTAssertEqual(args?["command"]?.stringValue, "ls")
            XCTAssertEqual(args?["output"]?.stringValue, "file.txt")
        } else { XCTFail("Expected turn") }
    }

    func testToolWithoutCallId() {
        let msgs = [
            makeTool(type: "tool_start", seq: 1, toolCallId: nil, toolName: "shell"),
            makeTool(type: "tool_complete", seq: 2, toolCallId: nil, toolName: "shell", result: "done"),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        if case .turn(let turn) = result[0] {
            // Without toolCallId, both remain in thinking (no merge)
            XCTAssertEqual(turn.thinkingMessages.count, 2)
        } else { XCTFail("Expected turn") }
    }

    // MARK: - Questions

    func testQuestionIsStandalone() {
        let msgs = [
            makeMsg(type: "agent_message", seq: 1),
            makeMsg(type: "question", seq: 2, payload: [
                "id": AnyCodable("q-1"),
                "question": AnyCodable("Continue?"),
            ]),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        // Should have: turn (agent_message), standalone (question)
        var foundTurn = false
        var foundQuestion = false
        for item in result {
            switch item {
            case .turn: foundTurn = true
            case .standalone(let msg):
                if msg.type == "question" { foundQuestion = true }
            }
        }
        XCTAssertTrue(foundTurn)
        XCTAssertTrue(foundQuestion)
    }

    func testQuestionStripsToolEvent() {
        let msgs = [
            makeTool(type: "tool_start", seq: 1, toolCallId: "tc-1"),
            makeMsg(type: "question", seq: 2, payload: [
                "id": AnyCodable("q-1"),
                "question": AnyCodable("Approve?"),
            ]),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        // tool_start should be stripped when question follows
        let standalone = result.compactMap { item -> ChatMessage? in
            if case .standalone(let msg) = item { return msg }
            return nil
        }
        XCTAssertTrue(standalone.contains(where: { $0.type == "question" }))
        // No turn with tool_start should remain (it was removed)
        let turns = result.compactMap { item -> Turn? in
            if case .turn(let t) = item { return t }
            return nil
        }
        for turn in turns {
            XCTAssertFalse(turn.thinkingMessages.contains(where: { $0.type == "tool_start" }))
        }
    }

    func testQuestionSkipsNextToolComplete() {
        let msgs = [
            makeTool(type: "tool_start", seq: 1, toolCallId: "tc-1"),
            makeMsg(type: "question", seq: 2, payload: [
                "id": AnyCodable("q-1"),
                "question": AnyCodable("Approve?"),
            ]),
            makeTool(type: "tool_complete", seq: 3, toolCallId: "tc-1", result: "done"),
            makeMsg(type: "agent_message", seq: 4, payload: ["content": AnyCodable("ok")]),
            makeMsg(type: "idle", seq: 5),
        ]
        let result = groupMessagesIntoTurns(msgs)
        // tool_complete after question should be skipped
        let allThinking = result.compactMap { item -> [ChatMessage]? in
            if case .turn(let t) = item { return t.thinkingMessages }
            return nil
        }.flatMap { $0 }
        XCTAssertFalse(allThinking.contains(where: { $0.seq == 3 && $0.type == "tool_complete" }))
    }

    // MARK: - State Signals

    func testIdleSignalsTurnComplete() {
        let msgs = [
            makeMsg(type: "agent_message", seq: 1, payload: ["content": AnyCodable("done")]),
            makeMsg(type: "idle", seq: 2),
        ]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .turn(let turn) = result[0] {
            XCTAssertFalse(turn.isActive)
            XCTAssertNotNil(turn.finalMessage)
        } else { XCTFail("Expected turn") }
    }

    func testActiveTreatedAsThinking() {
        let msgs = [
            makeMsg(type: "active", seq: 1),
            makeMsg(type: "agent_message", seq: 2, payload: ["content": AnyCodable("hi")]),
            makeMsg(type: "idle", seq: 3),
        ]
        let result = groupMessagesIntoTurns(msgs)
        if case .turn(let turn) = result[0] {
            // active should be in thinking
            XCTAssertTrue(turn.thinkingMessages.contains(where: { $0.type == "active" }))
            XCTAssertNotNil(turn.finalMessage)
        } else { XCTFail("Expected turn") }
    }

    func testErrorInTurn() {
        let msgs = [
            makeMsg(type: "error", seq: 1, payload: ["message": AnyCodable("failed")]),
            makeMsg(type: "idle", seq: 2),
        ]
        let result = groupMessagesIntoTurns(msgs)
        if case .turn(let turn) = result[0] {
            XCTAssertEqual(turn.thinkingMessages.count, 1)
            XCTAssertEqual(turn.thinkingMessages[0].type, "error")
        } else { XCTFail("Expected turn") }
    }

    // MARK: - Streaming

    func testStreamingContentAppendsToTurn() {
        let msgs = [
            makeMsg(type: "agent_message", seq: 1, payload: ["content": AnyCodable("thinking")]),
        ]
        let result = groupMessagesIntoTurns(msgs, streamingContent: "streaming text")
        XCTAssertEqual(result.count, 1)
        if case .turn(let turn) = result[0] {
            XCTAssertTrue(turn.isActive)
            // Should have the original + synthetic streaming message
            XCTAssertEqual(turn.thinkingMessages.count, 2)
            XCTAssertEqual(turn.thinkingMessages[1].content, "streaming text")
        } else { XCTFail("Expected turn") }
    }

    func testStreamingContentEmptyIgnored() {
        let msgs = [makeMsg(type: "agent_message", seq: 1)]
        let result = groupMessagesIntoTurns(msgs, streamingContent: "")
        if case .turn(let turn) = result[0] {
            XCTAssertEqual(turn.thinkingMessages.count, 1)
        } else { XCTFail("Expected turn") }
    }

    // MARK: - Multiple Turns

    func testMultipleTurns() {
        let msgs = [
            makeMsg(type: "user_message", seq: 1),
            makeMsg(type: "agent_message", seq: 2, payload: ["content": AnyCodable("reply1")]),
            makeMsg(type: "idle", seq: 3),
            makeMsg(type: "user_message", seq: 4),
            makeMsg(type: "agent_message", seq: 5, payload: ["content": AnyCodable("reply2")]),
            makeMsg(type: "idle", seq: 6),
        ]
        let result = groupMessagesIntoTurns(msgs)
        // user(standalone) + turn + user(standalone) + turn = 4
        XCTAssertEqual(result.count, 4)

        if case .standalone(let msg) = result[0] { XCTAssertEqual(msg.type, "user_message") }
        else { XCTFail() }
        if case .turn(let turn) = result[1] { XCTAssertEqual(turn.finalMessage?.content, "reply1") }
        else { XCTFail() }
        if case .standalone(let msg) = result[2] { XCTAssertEqual(msg.type, "user_message") }
        else { XCTFail() }
        if case .turn(let turn) = result[3] { XCTAssertEqual(turn.finalMessage?.content, "reply2") }
        else { XCTFail() }
    }

    // MARK: - System Messages

    func testSessionCreatedStandalone() {
        let msgs = [makeMsg(type: "session_created", seq: 1)]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "session_created")
        } else { XCTFail("Expected standalone") }
    }

    func testSessionEndedStandalone() {
        let msgs = [makeMsg(type: "session_ended", seq: 1)]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "session_ended")
        } else { XCTFail("Expected standalone") }
    }

    func testPendingInputStandalone() {
        let msgs = [makeMsg(type: "pending_input", seq: 0)]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "pending_input")
        } else { XCTFail("Expected standalone") }
    }

    // MARK: - Turn IDs

    func testTurnIds() {
        let msgs = [
            makeMsg(type: "agent_message", seq: 1),
            makeMsg(type: "idle", seq: 2),
            makeMsg(type: "agent_message", seq: 3),
            makeMsg(type: "idle", seq: 4),
        ]
        let result = groupMessagesIntoTurns(msgs)
        let turnIds = result.compactMap { item -> String? in
            if case .turn(let turn) = item { return turn.id }
            return nil
        }
        // Each turn should have a unique ID
        XCTAssertEqual(turnIds.count, 2)
        XCTAssertNotEqual(turnIds[0], turnIds[1])
    }

    // MARK: - Unknown type treated as standalone

    func testUnknownTypeStandalone() {
        let msgs = [makeMsg(type: "some_new_type", seq: 1)]
        let result = groupMessagesIntoTurns(msgs)
        XCTAssertEqual(result.count, 1)
        if case .standalone(let msg) = result[0] {
            XCTAssertEqual(msg.type, "some_new_type")
        } else { XCTFail("Expected standalone") }
    }
}
