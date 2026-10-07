import XCTest
@testable import Kraki

// MARK: - Test Helpers

/// JSONSerialization with a force-try in test fixtures is intentional —
/// the inputs are static literals controlled by the test author, not
/// arbitrary user data. Any failure here means the test author wrote a
/// non-JSON-encodable dictionary, which should crash the test loudly
/// rather than mask itself as `nil`.
private func makeJSON(_ dict: [String: Any]) -> Data {
    do {
        return try JSONSerialization.data(withJSONObject: dict)
    } catch {
        fatalError("makeJSON: test fixture is not JSON-encodable: \(error)")
    }
}

private func makeEnvelopeJSON(
    type: String,
    seq: Int = 1,
    sessionId: String = "sess-1",
    deviceId: String = "dev-1",
    timestamp: String = "2024-01-01T00:00:00Z",
    payload: [String: Any] = [:]
) -> Data {
    makeJSON([
        "type": type,
        "seq": seq,
        "sessionId": sessionId,
        "deviceId": deviceId,
        "timestamp": timestamp,
        "payload": payload,
    ])
}

// MARK: - ChatMessage Tests

final class ChatMessageTests: XCTestCase {

    func testChatMessageId() {
        let msg = ChatMessage(
            type: "user_message", seq: 5, sessionId: "sess-1",
            deviceId: "dev-1", timestamp: "2024-01-01T00:00:00Z", payload: [:]
        )
        XCTAssertEqual(msg.id, "sess-1:5")
    }

    func testChatMessageIdNilSession() {
        let msg = ChatMessage(
            type: "agent_message", seq: 3, sessionId: nil,
            deviceId: nil, timestamp: nil, payload: [:]
        )
        XCTAssertEqual(msg.id, "none:3")
    }

    func testChatMessageConvenienceAccessors() {
        let msg = ChatMessage(
            type: "tool_complete", seq: 1, sessionId: "s", deviceId: "d",
            timestamp: "t",
            payload: [
                "content": AnyCodable("hello"),
                "toolName": AnyCodable("shell"),
                "toolCallId": AnyCodable("tc-1"),
                "result": AnyCodable("ok"),
                "id": AnyCodable("perm-1"),
                "description": AnyCodable("Run shell"),
                "requestId": AnyCodable("req-1"),
                "message": AnyCodable("error!"),
                "reason": AnyCodable("timeout"),
                "resolution": AnyCodable("approved"),
                "pinned": AnyCodable(true),
                "mode": AnyCodable("safe"),
                "model": AnyCodable("claude"),
                "title": AnyCodable("Title"),
                "autoTitle": AnyCodable("Auto"),
            ]
        )
        XCTAssertEqual(msg.content, "hello")
        XCTAssertEqual(msg.toolName, "shell")
        XCTAssertEqual(msg.toolCallId, "tc-1")
        XCTAssertEqual(msg.result, "ok")
        XCTAssertEqual(msg.permissionId, "perm-1")
        XCTAssertEqual(msg.questionId, "perm-1") // shares "id" key
        XCTAssertEqual(msg.description_, "Run shell")
        XCTAssertEqual(msg.toolDescription, "Run shell")
        XCTAssertEqual(msg.requestId, "req-1")
        XCTAssertEqual(msg.errorMessage, "error!")
        XCTAssertEqual(msg.reason, "timeout")
        XCTAssertEqual(msg.resolution, "approved")
        XCTAssertEqual(msg.pinned, true)
        XCTAssertEqual(msg.mode, "safe")
        XCTAssertEqual(msg.model, "claude")
        XCTAssertEqual(msg.title, "Title")
        XCTAssertEqual(msg.autoTitle, "Auto")
    }

    func testChatMessageIsRenderable() {
        let renderableTypes = [
            "user_message", "agent_message", "pending_input", "send_input",
            "permission", "tool_start", "tool_complete",
            "idle", "active", "error", "session_created", "session_ended",
            "session_deleted", "kill_session", "permission_resolved",
        ]
        for type in renderableTypes {
            let msg = ChatMessage(type: type, seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
            XCTAssertTrue(msg.isRenderable, "\(type) should be renderable")
        }

        // Questions ride agent_message / user_message; the old types are gone.
        let nonRenderable = ["agent_message_delta", "session_mode_set", "device_greeting", "unknown",
                             "question", "answer", "question_resolved"]
        for type in nonRenderable {
            let msg = ChatMessage(type: type, seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
            XCTAssertFalse(msg.isRenderable, "\(type) should not be renderable")
        }
    }

    func testChatMessageIsTransient() {
        let delta = ChatMessage(type: "agent_message_delta", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
        XCTAssertTrue(delta.isTransient)

        let modeSet = ChatMessage(type: "session_mode_set", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
        XCTAssertTrue(modeSet.isTransient)

        let user = ChatMessage(type: "user_message", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
        XCTAssertFalse(user.isTransient)
    }

    func testChatMessageAttachments() {
        let msg = ChatMessage(
            type: "agent_message", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil,
            payload: [
                "attachments": AnyCodable([
                    AnyCodable([
                        "type": AnyCodable("image"),
                        "mimeType": AnyCodable("image/png"),
                        "data": AnyCodable("base64data"),
                    ])
                ])
            ]
        )
        let attachments = msg.attachments
        XCTAssertNotNil(attachments)
        XCTAssertEqual(attachments?.count, 1)
        XCTAssertEqual(attachments?[0].type, "image")
        XCTAssertEqual(attachments?[0].mimeType, "image/png")
        XCTAssertEqual(attachments?[0].data, "base64data")
    }

    func testChatMessageUsage() {
        let msg = ChatMessage(
            type: "idle", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil,
            payload: [
                "usage": AnyCodable([
                    "inputTokens": AnyCodable(100),
                    "outputTokens": AnyCodable(200),
                    "cacheReadTokens": AnyCodable(50),
                    "cacheWriteTokens": AnyCodable(25),
                    "totalCost": AnyCodable(0.05),
                    "totalDurationMs": AnyCodable(1500.0),
                ])
            ]
        )
        let usage = msg.usage
        XCTAssertNotNil(usage)
        XCTAssertEqual(usage?.inputTokens, 100)
        XCTAssertEqual(usage?.outputTokens, 200)
        XCTAssertEqual(usage?.totalCost, 0.05)
    }

    func testChatMessageChoices() {
        let msg = ChatMessage(
            type: "question", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil,
            payload: [
                "choices": AnyCodable([AnyCodable("yes"), AnyCodable("no")])
            ]
        )
        XCTAssertEqual(msg.choices, ["yes", "no"])
    }

    func testChatMessageArgs() {
        let msg = ChatMessage(
            type: "tool_start", seq: 1, sessionId: nil, deviceId: nil, timestamp: nil,
            payload: [
                "args": AnyCodable(["command": AnyCodable("ls")])
            ]
        )
        let args = msg.args
        XCTAssertEqual(args?["command"]?.stringValue, "ls")
    }
}

// MARK: - ProducerMessageDecoder Tests

@MainActor
final class MessageProviderHeadTests: XCTestCase {
    func testSessionSpineContractMatchesTentaclePersistentTypes() {
        XCTAssertEqual(SessionSpineContract.persistentTypes, Set([
            "session_created",
            "agent_message",
            "interrupted_turn",
            "turn_status",
            "user_message",
            "system_message",
            "error",
            "session_ended",
            "idle",
        ]))
        for transient in ["active", "compacting", "agent_message_delta", "card_action",
                          "tool_start", "tool_complete", "agent_narration", "permission", "question"] {
            XCTAssertFalse(SessionSpineContract.contains(type: transient, seq: 99), transient)
        }
    }

    func testEnsureOlderLoadedAddsTenRowsToCompactIOSWindow() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-provider-older-page-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let sessionId = "sess-older-page"
        let messages = (1...80).map { seq in
            ChatMessage(
                type: seq.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "dev-1",
                timestamp: "2026-08-16T00:00:00Z",
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }
        try database.insert(sessionId, messages)

        let app = AppState(testDatabase: database)
        _ = app.messageStore.loadInitialWindow(sessionId)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).map(\.seq), Array(51...80))

        XCTAssertTrue(app.messageProvider?.ensureOlderLoaded(sessionId: sessionId) == true)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).map(\.seq), Array(41...80))
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.topSeq, 41)
    }

    func testEnsureOlderLoadedPagesByPersistentRowsAcrossLegacySeqGaps() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-provider-sparse-older-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let sessionId = "sess-sparse-older"
        let messages = (1...80).map { index in
            let seq = index * 7
            return ChatMessage(
                type: index.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "dev-1",
                timestamp: "2026-08-17T00:00:00Z",
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }
        try database.insert(sessionId, messages)

        let app = AppState(testDatabase: database)
        _ = app.messageStore.loadInitialWindow(sessionId)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).map(\.seq), stride(from: 357, through: 560, by: 7).map { $0 })

        XCTAssertTrue(app.messageProvider?.ensureOlderLoaded(sessionId: sessionId) == true)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).prefix(10).map(\.seq), stride(from: 287, through: 350, by: 7).map { $0 })
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.topSeq, 287)
    }

    func testEnsureOlderLoadedPagesAcrossLargeLegacySeqGaps() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-provider-large-legacy-gap-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let sessionId = "sess-large-legacy-gap"
        let messages = (1...80).map { index in
            let seq = index * 496
            return ChatMessage(
                type: index.isMultiple(of: 2) ? "agent_message" : "user_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "dev-1",
                timestamp: "2026-08-17T00:00:00Z",
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }
        try database.insert(sessionId, messages)

        let app = AppState(testDatabase: database)
        _ = app.messageStore.loadInitialWindow(sessionId)
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.topSeq, 25_296)

        XCTAssertTrue(app.messageProvider?.ensureOlderLoaded(sessionId: sessionId) == true)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).prefix(10).map(\.seq),
                       stride(from: 20_336, through: 24_800, by: 496).map { $0 })
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.topSeq, 20_336)
    }

    func testEnsureNewerLoadedAdvancesAcrossOffSpineSeqGaps() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-provider-newer-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let sessionId = "sess-newer"
        func makeMessage(_ seq: Int) -> ChatMessage {
            ChatMessage(
                type: seq == 1 ? "user_message" : "agent_message",
                seq: seq,
                sessionId: sessionId,
                deviceId: "dev-1",
                timestamp: "2026-08-06T00:00:00Z",
                payload: ["content": AnyCodable("message-\(seq)")]
            )
        }
        try database.insert(sessionId, [makeMessage(1), makeMessage(3)])

        let app = AppState(testDatabase: database)
        _ = app.messageStore.loadInitialWindow(sessionId)
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.bottomSeq, 3)

        // Replayed legacy persistent rows can remain sparse because retired
        // off-spine events consumed the historical seq values before filtering.
        try database.insert(sessionId, [makeMessage(5), makeMessage(7)])
        app.messageProvider?.setTentacleInfo(sessionId: sessionId, lastSeq: 7, deviceId: "dev-1")

        XCTAssertTrue(app.messageProvider?.ensureNewerLoaded(sessionId: sessionId) == true)
        XCTAssertEqual(app.messageStore.windowState(sessionId)?.bottomSeq, 7)
        XCTAssertEqual(app.messageStore.currentWindow(sessionId).map(\.seq), [1, 3, 5, 7])
    }

    func testHistoryBatchAdvancesSessionHeadAndUnreadProjection() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-provider-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let app = AppState(testDatabase: database)
        app.sessionStore.sessions["sess-1"] = SessionInfo(
            id: "sess-1",
            deviceId: "dev-1",
            deviceName: "Test Device",
            agent: "pi",
            model: "gpt-test",
            title: "Test Session",
            state: .idle,
            mode: .auto,
            lastSeq: 10,
            readSeq: 10,
            messageCount: 10,
            createdAt: Date(),
            pinned: false
        )

        let message = ChatMessage(
            type: "agent_message",
            seq: 11,
            sessionId: "sess-1",
            deviceId: "dev-1",
            timestamp: "2026-08-06T00:00:00Z",
            payload: ["content": AnyCodable("reply")]
        )
        app.messageProvider?.handleBatch(
            sessionId: "sess-1",
            messages: [message],
            lastSeq: 11,
            totalLastSeq: 11,
            containsHead: true
        )

        XCTAssertEqual(app.sessionStore.sessions["sess-1"]?.lastSeq, 11)
        XCTAssertTrue(app.sessionStore.isUnread("sess-1"))
        XCTAssertEqual(app.messageStore.dbLastSeq("sess-1"), 11)
    }

    func testRouterAdvancesOnlyPersistentSessionSequence() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-message-router-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let app = AppState(testDatabase: database)
        app.sessionStore.sessions["sess-1"] = SessionInfo(
            id: "sess-1",
            deviceId: "dev-1",
            deviceName: "Test Device",
            agent: "pi",
            title: "Test Session",
            state: .idle,
            mode: .auto,
            lastSeq: 10,
            readSeq: 10,
            messageCount: 10,
            createdAt: Date(),
            pinned: false
        )
        let router = MessageRouter(appState: app)

        func route(type: String, seq: Int) throws {
            let data = try JSONSerialization.data(withJSONObject: [
                "type": type,
                "sessionId": "sess-1",
                "deviceId": "dev-1",
                "seq": seq,
                "timestamp": "2026-08-06T00:00:00Z",
                "payload": type == "user_message" ? ["content": "hello"] : [:],
            ])
            router.handleDataMessage(data)
        }

        try route(type: "user_message", seq: 11)
        XCTAssertEqual(app.sessionStore.sessions["sess-1"]?.lastSeq, 11)
        XCTAssertEqual(app.sessionStore.sessions["sess-1"]?.readSeq, 11)
        XCTAssertFalse(app.sessionStore.isUnread("sess-1"))

        try route(type: "active", seq: 100_000)
        XCTAssertEqual(app.sessionStore.sessions["sess-1"]?.lastSeq, 11)
    }
}

@MainActor
final class DeviceGreetingFeaturesTests: XCTestCase {
    /// Soak finding (seed 2003): the Tentacle's broadcast greeting after its
    /// own reconnect had no `features`; treating that as "none" stopped
    /// automatic re-sends of unconfirmed inputs.
    func testGreetingWithoutFeaturesKeepsKnownFeatures() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("kraki-greeting-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = try MessageDatabase(databaseURL: root.appendingPathComponent("messages.sqlite"))
        let app = AppState(testDatabase: database)
        let router = MessageRouter(appState: app)

        func greet(_ deviceId: String, features: [String]?) throws {
            var payload: [String: Any] = ["name": "Mac"]
            if let features { payload["features"] = features }
            let data = try JSONSerialization.data(withJSONObject: [
                "type": "device_greeting", "deviceId": deviceId, "seq": 0,
                "timestamp": "2026-09-29T00:00:00Z", "payload": payload,
            ])
            router.handleDataMessage(data)
        }

        try greet("dev-t", features: ["idempotent_input", "fragments"])
        XCTAssertEqual(app.deviceStore.deviceFeatures["dev-t"], ["idempotent_input", "fragments"])
        try greet("dev-t", features: nil)
        XCTAssertEqual(app.deviceStore.deviceFeatures["dev-t"], ["idempotent_input", "fragments"],
                       "a greeting without features must not erase them")
        try greet("dev-t", features: [])
        XCTAssertEqual(app.deviceStore.deviceFeatures["dev-t"], [], "an explicit list still replaces them")
        try greet("dev-old", features: nil)
        XCTAssertEqual(app.deviceStore.deviceFeatures["dev-old"], [], "never advertised → an older Tentacle")
    }
}

final class ProducerMessageDecoderTests: XCTestCase {

    func testDecodeAgentMessage() {
        let data = makeEnvelopeJSON(type: "agent_message", payload: ["content": "Hello!"])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertNotNil(msg)
        XCTAssertEqual(msg?.type, "agent_message")
        XCTAssertEqual(msg?.content, "Hello!")
        XCTAssertEqual(msg?.sessionId, "sess-1")
        XCTAssertEqual(msg?.seq, 1)
    }

    func testDecodeUserMessage() {
        let data = makeEnvelopeJSON(type: "user_message", payload: ["content": "Hi"])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "user_message")
        XCTAssertEqual(msg?.content, "Hi")
    }

    func testDecodePermission() {
        let data = makeEnvelopeJSON(type: "permission", payload: [
            "id": "perm-1",
            "description": "Run shell",
            "toolName": "shell",
            "args": ["command": "ls"],
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "permission")
        XCTAssertEqual(msg?.permissionId, "perm-1")
        XCTAssertEqual(msg?.toolName, "shell")
    }

    func testDecodeSpineQuestion() {
        let data = makeEnvelopeJSON(type: "agent_message", payload: [
            "content": "Two options.",
            "question": ["id": "q-1", "text": "Continue?", "choices": ["yes", "no"]],
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.questionSpec, ChatMessage.QuestionSpec(id: "q-1", text: "Continue?", choices: ["yes", "no"]))
        XCTAssertNil(msg?.questionPresentation, "presentation is client-derived, never decoded")
    }

    func testQuestionPresentationIsNeverEncoded() throws {
        var msg = ChatMessage(type: "agent_message", seq: 3, sessionId: "s", deviceId: nil, timestamp: nil,
                              payload: ["question": AnyCodable(["id": "q", "text": "?"])])
        msg.questionPresentation = QuestionPresentation(state: .open)
        let json = String(data: try JSONEncoder().encode(msg), encoding: .utf8) ?? ""
        XCTAssertFalse(json.contains("open"), json)
        XCTAssertNil(try JSONDecoder().decode(ChatMessage.self, from: Data(json.utf8)).questionPresentation)
    }

    func testDecodeToolStart() {
        let data = makeEnvelopeJSON(type: "tool_start", payload: [
            "toolName": "shell",
            "args": ["command": "echo hello"],
            "toolCallId": "tc-1",
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "tool_start")
        XCTAssertEqual(msg?.toolName, "shell")
        XCTAssertEqual(msg?.toolCallId, "tc-1")
    }

    func testDecodeToolComplete() {
        let data = makeEnvelopeJSON(type: "tool_complete", payload: [
            "toolName": "shell",
            "args": ["command": "echo hello"],
            "result": "hello",
            "toolCallId": "tc-1",
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "tool_complete")
        XCTAssertEqual(msg?.result, "hello")
    }

    func testDecodeIdle() {
        let data = makeEnvelopeJSON(type: "idle", payload: [:])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "idle")
    }

    func testDecodeError() {
        let data = makeEnvelopeJSON(type: "error", payload: ["message": "Something broke"])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "error")
        XCTAssertEqual(msg?.errorMessage, "Something broke")
    }

    func testDecodeSessionCreated() {
        let data = makeEnvelopeJSON(type: "session_created", payload: [
            "agent": "claude",
            "model": "claude-3",
            "requestId": "req-1",
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "session_created")
        XCTAssertEqual(msg?.requestId, "req-1")
    }

    func testDecodeSessionEnded() {
        let data = makeEnvelopeJSON(type: "session_ended", payload: ["reason": "user"])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "session_ended")
        XCTAssertEqual(msg?.reason, "user")
    }

    func testDecodeUnknownType() {
        let data = makeEnvelopeJSON(type: "some_future_type", payload: ["foo": "bar"])
        let msg = ProducerMessageDecoder.decode(data)
        // ProducerMessageDecoder.decode does raw JSON parsing, so unknown types still decode
        XCTAssertNotNil(msg)
        XCTAssertEqual(msg?.type, "some_future_type")
    }

    func testDecodeBatchMessages() {
        let batch: [[String: Any]] = [
            ["type": "user_message", "seq": 1, "sessionId": "s1", "deviceId": "d1",
             "timestamp": "t1", "payload": ["content": "hi"]],
            ["type": "agent_message", "seq": 2, "sessionId": "s1", "deviceId": "d1",
             "timestamp": "t2", "payload": ["content": "hello"]],
        ]
        let messages = ProducerMessageDecoder.decodeBatchMessages(batch)
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].type, "user_message")
        XCTAssertEqual(messages[1].type, "agent_message")
    }

    func testDecodeInvalidJSON() {
        let data = "not json".data(using: .utf8)!
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertNil(msg)
    }

    func testDecodeMissingType() {
        let data = makeJSON(["seq": 1, "sessionId": "s"])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertNil(msg)
    }
}

// MARK: - ChatMessage presentation

final class ChatMessagePresentationTests: XCTestCase {

    func testImageOnlyMessageWithoutItsImageIsShownAsUnavailable() {
        func message(_ payload: [String: AnyCodable]) -> ChatMessage {
            ChatMessage(type: "user_message", seq: 6, sessionId: "s", deviceId: nil, timestamp: nil, payload: payload)
        }
        let lost = message(["content": AnyCodable("[image]")])
        XCTAssertTrue(lost.imageUnavailable)
        let kept = message(["content": AnyCodable("[image]"),
                            "attachments": AnyCodable([["type": "image", "mimeType": "image/png", "data": "AA=="]])])
        XCTAssertFalse(kept.imageUnavailable)
        XCTAssertFalse(message(["content": AnyCodable("hello")]).imageUnavailable)
        let content = TKBubbleContent.make(message: lost, sessionId: "s", agent: "pi")
        XCTAssertEqual(content.body?.string, "Image unavailable", "the message stays visible")
    }
}
