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
                "question": AnyCodable("yes?"),
                "description": AnyCodable("Run shell"),
                "requestId": AnyCodable("req-1"),
                "message": AnyCodable("error!"),
                "reason": AnyCodable("timeout"),
                "resolution": AnyCodable("approved"),
                "answer": AnyCodable("yes"),
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
        XCTAssertEqual(msg.question, "yes?")
        XCTAssertEqual(msg.description_, "Run shell")
        XCTAssertEqual(msg.toolDescription, "Run shell")
        XCTAssertEqual(msg.requestId, "req-1")
        XCTAssertEqual(msg.errorMessage, "error!")
        XCTAssertEqual(msg.reason, "timeout")
        XCTAssertEqual(msg.resolution, "approved")
        XCTAssertEqual(msg.answer, "yes")
        XCTAssertEqual(msg.pinned, true)
        XCTAssertEqual(msg.mode, "safe")
        XCTAssertEqual(msg.model, "claude")
        XCTAssertEqual(msg.title, "Title")
        XCTAssertEqual(msg.autoTitle, "Auto")
    }

    func testChatMessageIsRenderable() {
        let renderableTypes = [
            "user_message", "agent_message", "pending_input", "send_input",
            "permission", "question", "tool_start", "tool_complete",
            "idle", "active", "error", "session_created", "session_ended",
            "session_deleted", "kill_session", "answer",
            "permission_resolved", "question_resolved",
        ]
        for type in renderableTypes {
            let msg = ChatMessage(type: type, seq: 1, sessionId: nil, deviceId: nil, timestamp: nil, payload: [:])
            XCTAssertTrue(msg.isRenderable, "\(type) should be renderable")
        }

        let nonRenderable = ["agent_message_delta", "session_mode_set", "device_greeting", "unknown"]
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

    func testDecodeQuestion() {
        let data = makeEnvelopeJSON(type: "question", payload: [
            "id": "q-1",
            "question": "Continue?",
            "choices": ["yes", "no"],
        ])
        let msg = ProducerMessageDecoder.decode(data)
        XCTAssertEqual(msg?.type, "question")
        XCTAssertEqual(msg?.question, "Continue?")
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

// MARK: - ConsumerMessageBuilder Tests

final class ConsumerMessageBuilderTests: XCTestCase {

    private func assertEnvelope(
        _ msg: [String: Any],
        type: String,
        sessionId: String? = "sess-1",
        deviceId: String = "dev-1",
        file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(msg["type"] as? String, type, file: file, line: line)
        XCTAssertEqual(msg["deviceId"] as? String, deviceId, file: file, line: line)
        if let sessionId {
            XCTAssertEqual(msg["sessionId"] as? String, sessionId, file: file, line: line)
        }
        XCTAssertNotNil(msg["timestamp"] as? String, file: file, line: line)
        XCTAssertNotNil(msg["seq"], file: file, line: line)
        XCTAssertNotNil(msg["payload"], file: file, line: line)
    }

    func testBuildSendInput() {
        let msg = ConsumerMessageBuilder.sendInput(sessionId: "sess-1", deviceId: "dev-1", text: "hello")
        assertEnvelope(msg, type: "send_input")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["text"] as? String, "hello")
    }

    func testBuildSendInputWithAttachments() {
        let attachment = ImageAttachment(type: "image", mimeType: "image/png", data: "b64")
        let msg = ConsumerMessageBuilder.sendInput(sessionId: "sess-1", deviceId: "dev-1", text: "look", attachments: [attachment])
        let payload = msg["payload"] as? [String: Any]
        let attachments = payload?["attachments"] as? [[String: Any]]
        XCTAssertEqual(attachments?.count, 1)
        XCTAssertEqual(attachments?[0]["mimeType"] as? String, "image/png")
    }

    func testBuildSteerInput() {
        let msg = ConsumerMessageBuilder.sendInput(
            sessionId: "sess-1", deviceId: "dev-1", text: "change direction", delivery: "steer"
        )
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["delivery"] as? String, "steer")
    }

    func testBuildApprove() {
        let msg = ConsumerMessageBuilder.approve(sessionId: "sess-1", deviceId: "dev-1", permissionId: "perm-1")
        assertEnvelope(msg, type: "approve")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["permissionId"] as? String, "perm-1")
    }

    func testBuildDeny() {
        let msg = ConsumerMessageBuilder.deny(sessionId: "sess-1", deviceId: "dev-1", permissionId: "perm-1")
        assertEnvelope(msg, type: "deny")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["permissionId"] as? String, "perm-1")
    }

    func testBuildAlwaysAllow() {
        let msg = ConsumerMessageBuilder.alwaysAllow(sessionId: "sess-1", deviceId: "dev-1", permissionId: "perm-1", toolKind: "shell")
        assertEnvelope(msg, type: "always_allow")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["permissionId"] as? String, "perm-1")
        XCTAssertEqual(payload?["toolKind"] as? String, "shell")
    }

    func testBuildAnswer() {
        let msg = ConsumerMessageBuilder.answer(sessionId: "sess-1", deviceId: "dev-1", questionId: "q-1", answer: "yes")
        assertEnvelope(msg, type: "answer")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["questionId"] as? String, "q-1")
        XCTAssertEqual(payload?["answer"] as? String, "yes")
    }

    func testBuildKillSession() {
        let msg = ConsumerMessageBuilder.killSession(sessionId: "sess-1", deviceId: "dev-1")
        assertEnvelope(msg, type: "kill_session")
    }

    func testBuildCreateSession() {
        let msg = ConsumerMessageBuilder.createSession(
            deviceId: "dev-1", requestId: "req-1", targetDeviceId: "dev-2",
            model: "claude-3", prompt: "hello"
        )
        assertEnvelope(msg, type: "create_session", sessionId: nil, deviceId: "dev-1")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["requestId"] as? String, "req-1")
        XCTAssertEqual(payload?["targetDeviceId"] as? String, "dev-2")
        XCTAssertEqual(payload?["model"] as? String, "claude-3")
        XCTAssertEqual(payload?["prompt"] as? String, "hello")
    }

    func testBuildSetSessionMode() {
        let msg = ConsumerMessageBuilder.setSessionMode(sessionId: "sess-1", deviceId: "dev-1", mode: .execute)
        assertEnvelope(msg, type: "set_session_mode")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["mode"] as? String, "execute")
    }

    func testBuildMarkRead() {
        let msg = ConsumerMessageBuilder.markRead(sessionId: "sess-1", deviceId: "dev-1", seq: 10)
        assertEnvelope(msg, type: "mark_read")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["seq"] as? Int, 10)
    }

    func testBuildRequestReplay() {
        let msg = ConsumerMessageBuilder.requestReplay(sessionId: "sess-1", deviceId: "dev-1", afterSeq: 5, limit: 50)
        assertEnvelope(msg, type: "request_session_replay")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["sessionId"] as? String, "sess-1")
        XCTAssertEqual(payload?["afterSeq"] as? Int, 5)
        XCTAssertEqual(payload?["limit"] as? Int, 50)
    }

    func testBuildPinSession() {
        let msg = ConsumerMessageBuilder.pinSession(sessionId: "sess-1", deviceId: "dev-1", pinned: true)
        assertEnvelope(msg, type: "pin_session")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["pinned"] as? Bool, true)
    }

    func testBuildRenameSession() {
        let msg = ConsumerMessageBuilder.renameSession(sessionId: "sess-1", deviceId: "dev-1", title: "New Name")
        assertEnvelope(msg, type: "rename_session")
        let payload = msg["payload"] as? [String: Any]
        XCTAssertEqual(payload?["title"] as? String, "New Name")
    }
}

// MARK: - IncomingMessageType Tests

final class IncomingMessageTypeTests: XCTestCase {

    func testDetectUnicast() {
        let result = IncomingMessageType.detect(from: ["type": "unicast"])
        if case .unicast = result {} else { XCTFail("Expected unicast") }
    }

    func testDetectBroadcast() {
        let result = IncomingMessageType.detect(from: ["type": "broadcast"])
        if case .broadcast = result {} else { XCTFail("Expected broadcast") }
    }

    func testDetectAuthOk() {
        let result = IncomingMessageType.detect(from: ["type": "auth_ok"])
        if case .control(let t) = result { XCTAssertEqual(t, "auth_ok") }
        else { XCTFail("Expected control") }
    }

    func testDetectAuthError() {
        let result = IncomingMessageType.detect(from: ["type": "auth_error"])
        if case .control(let t) = result { XCTAssertEqual(t, "auth_error") }
        else { XCTFail("Expected control") }
    }

    func testDetectDeviceJoined() {
        let result = IncomingMessageType.detect(from: ["type": "device_joined"])
        if case .control(let t) = result { XCTAssertEqual(t, "device_joined") }
        else { XCTFail("Expected control") }
    }

    func testDetectServerError() {
        let result = IncomingMessageType.detect(from: ["type": "server_error"])
        if case .control(let t) = result { XCTAssertEqual(t, "server_error") }
        else { XCTFail("Expected control") }
    }

    func testDetectPong() {
        let result = IncomingMessageType.detect(from: ["type": "pong"])
        if case .control(let t) = result { XCTAssertEqual(t, "pong") }
        else { XCTFail("Expected control") }
    }

    func testDetectUnknown() {
        let result = IncomingMessageType.detect(from: ["type": "some_future_type"])
        if case .unknown = result {} else { XCTFail("Expected unknown") }
    }

    func testDetectNoType() {
        let result = IncomingMessageType.detect(from: ["foo": "bar"])
        if case .unknown = result {} else { XCTFail("Expected unknown") }
    }
}

// MARK: - AuthMethod Tests

final class AuthMethodTests: XCTestCase {

    private func roundTrip(_ method: AuthMethod) throws -> AuthMethod {
        let data = try JSONEncoder().encode(method)
        return try JSONDecoder().decode(AuthMethod.self, from: data)
    }

    func testPairingEncodeDecode() throws {
        let method = AuthMethod.pairing(token: "abc123")
        let decoded = try roundTrip(method)
        if case .pairing(let token) = decoded {
            XCTAssertEqual(token, "abc123")
        } else {
            XCTFail("Expected pairing")
        }
    }

    func testChallengeEncodeDecode() throws {
        let method = AuthMethod.challenge(deviceId: "dev-1")
        let decoded = try roundTrip(method)
        if case .challenge(let deviceId) = decoded {
            XCTAssertEqual(deviceId, "dev-1")
        } else {
            XCTFail("Expected challenge")
        }
    }

    func testGithubOAuthEncodeDecode() throws {
        let method = AuthMethod.githubOAuth(code: "gh-code")
        let decoded = try roundTrip(method)
        if case .githubOAuth(let code) = decoded {
            XCTAssertEqual(code, "gh-code")
        } else {
            XCTFail("Expected githubOAuth")
        }
    }

    func testOpenEncodeDecode() throws {
        let method = AuthMethod.open(sharedKey: "key123")
        let decoded = try roundTrip(method)
        if case .open(let key) = decoded {
            XCTAssertEqual(key, "key123")
        } else {
            XCTFail("Expected open")
        }
    }

    func testOpenWithNilKey() throws {
        let method = AuthMethod.open(sharedKey: nil)
        let decoded = try roundTrip(method)
        if case .open(let key) = decoded {
            XCTAssertNil(key)
        } else {
            XCTFail("Expected open")
        }
    }
}

// MARK: - ProducerMessage Codable Tests

final class ProducerMessageCodableTests: XCTestCase {

    func testProducerEnvelopeRoundtrip() throws {
        let envelope = ProducerEnvelope(
            deviceId: "dev-1",
            seq: 5,
            timestamp: "2024-01-01T00:00:00Z",
            sessionId: "sess-1",
            message: .agentMessage(AgentMessagePayload(content: "Hello"))
        )
        let data = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(ProducerEnvelope.self, from: data)
        XCTAssertEqual(decoded.deviceId, "dev-1")
        XCTAssertEqual(decoded.seq, 5)
        XCTAssertEqual(decoded.sessionId, "sess-1")
        XCTAssertEqual(decoded.message.typeString, "agent_message")
    }

    func testCompactingEnvelopeRoundtrip() throws {
        let start = ProducerEnvelope(
            deviceId: "dev-1",
            seq: 6,
            timestamp: "2024-01-01T00:00:00Z",
            sessionId: "sess-1",
            message: .compacting(CompactingPayload(
                phase: "start", reason: "threshold", nextState: nil
            ))
        )
        let startDecoded = try JSONDecoder().decode(
            ProducerEnvelope.self,
            from: JSONEncoder().encode(start)
        )
        guard case .compacting(let startPayload) = startDecoded.message else {
            return XCTFail("Expected compacting start")
        }
        XCTAssertEqual(startPayload.phase, "start")
        XCTAssertEqual(startPayload.reason, "threshold")
        XCTAssertNil(startPayload.nextState)

        let end = ProducerEnvelope(
            deviceId: "dev-1",
            seq: 7,
            timestamp: "2024-01-01T00:00:01Z",
            sessionId: "sess-1",
            message: .compacting(CompactingPayload(
                phase: "end", reason: nil, nextState: .idle
            ))
        )
        let endDecoded = try JSONDecoder().decode(
            ProducerEnvelope.self,
            from: JSONEncoder().encode(end)
        )
        guard case .compacting(let endPayload) = endDecoded.message else {
            return XCTFail("Expected compacting end")
        }
        XCTAssertEqual(endPayload.phase, "end")
        XCTAssertEqual(endPayload.nextState, .idle)
    }

    func testConsumerEnvelopeRoundtrip() throws {
        let envelope = ConsumerEnvelope(
            deviceId: "dev-1",
            seq: 3,
            timestamp: "2024-01-01T00:00:00Z",
            sessionId: "sess-1",
            message: .sendInput(SendInputPayload(text: "hello"))
        )
        let data = try JSONEncoder().encode(envelope)
        let decoded = try JSONDecoder().decode(ConsumerEnvelope.self, from: data)
        XCTAssertEqual(decoded.deviceId, "dev-1")
        XCTAssertEqual(decoded.seq, 3)
        XCTAssertEqual(decoded.message.typeString, "send_input")
    }
}
