import XCTest
@testable import Kraki

final class MessageStoreTests: XCTestCase {

    private var store: MessageStore!

    override func setUp() {
        super.setUp()
        store = MessageStore()
        // Reset clears any messages left over from prior runs in the
        // shared on-disk cache (ApplicationSupport/MessageCache/),
        // which would otherwise hydrate into the new store on first
        // access and bleed state across test cases.
        store.reset()
    }

    override func tearDown() {
        // Also clear on tearDown so no other test class accidentally
        // sees this suite's messages on disk during a parallel /
        // shuffled run.
        store?.reset()
        store?.flushCache()
        store = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeMsg(
        type: String = "agent_message",
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

    // MARK: - Append

    func testAppendMessage() {
        store.appendMessage("sess-1", makeMsg(seq: 1))
        XCTAssertEqual(store.getMessages("sess-1").count, 1)
    }

    func testAppendMessageDeduplicates() {
        store.appendMessage("sess-1", makeMsg(seq: 1, payload: ["content": AnyCodable("first")]))
        store.appendMessage("sess-1", makeMsg(seq: 1, payload: ["content": AnyCodable("replaced")]))
        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].content, "replaced")
    }

    func testAppendMessageSortsBySeq() {
        store.appendMessage("sess-1", makeMsg(seq: 3))
        store.appendMessage("sess-1", makeMsg(seq: 1))
        store.appendMessage("sess-1", makeMsg(seq: 2))
        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages.map(\.seq), [1, 2, 3])
    }

    // MARK: - Prepend

    func testPrependMessages() {
        store.appendMessage("sess-1", makeMsg(seq: 5))
        store.appendMessage("sess-1", makeMsg(seq: 6))

        let older = [makeMsg(seq: 2), makeMsg(seq: 3)]
        store.prependMessages("sess-1", older)

        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages.map(\.seq), [2, 3, 5, 6])
    }

    func testPrependMessagesDeduplicates() {
        store.appendMessage("sess-1", makeMsg(seq: 3))
        store.prependMessages("sess-1", [makeMsg(seq: 1), makeMsg(seq: 3)])
        let messages = store.getMessages("sess-1")
        // seq 3 already exists, so only seq 1 is added
        XCTAssertEqual(messages.map(\.seq), [1, 3])
    }

    // MARK: - Get

    func testGetMessages() {
        store.appendMessage("sess-1", makeMsg(seq: 1))
        store.appendMessage("sess-2", makeMsg(seq: 1, sessionId: "sess-2"))
        XCTAssertEqual(store.getMessages("sess-1").count, 1)
        XCTAssertEqual(store.getMessages("sess-2").count, 1)
        XCTAssertEqual(store.getMessages("sess-3").count, 0)
    }

    func testGetLastSeq() {
        XCTAssertEqual(store.getLastSeq("sess-1"), 0)
        store.appendMessage("sess-1", makeMsg(seq: 5))
        store.appendMessage("sess-1", makeMsg(seq: 3))
        XCTAssertEqual(store.getLastSeq("sess-1"), 5)
    }

    // MARK: - Delete

    func testDeleteSessionMessages() {
        store.appendMessage("sess-1", makeMsg(seq: 1))
        store.appendMessage("sess-1", makeMsg(seq: 2))
        store.addPermission(PendingPermission(
            id: "p1", sessionId: "sess-1", description: "test",
            toolName: "shell", args: nil, timestamp: Date()
        ))
        store.addQuestion(PendingQuestion(
            id: "q1", sessionId: "sess-1", question: "test",
            choices: nil, timestamp: Date()
        ))

        store.deleteSessionMessages("sess-1")

        XCTAssertEqual(store.getMessages("sess-1").count, 0)
        XCTAssertTrue(store.pendingPermissions.isEmpty)
        XCTAssertTrue(store.pendingQuestions.isEmpty)
    }

    func testDeleteDoesNotAffectOtherSessions() {
        store.appendMessage("sess-1", makeMsg(seq: 1))
        store.appendMessage("sess-2", makeMsg(seq: 1, sessionId: "sess-2"))
        store.addPermission(PendingPermission(
            id: "p1", sessionId: "sess-2", description: "test",
            toolName: nil, args: nil, timestamp: Date()
        ))

        store.deleteSessionMessages("sess-1")

        XCTAssertEqual(store.getMessages("sess-2").count, 1)
        XCTAssertEqual(store.pendingPermissions.count, 1)
    }

    // MARK: - Resolve Pending Input

    func testResolvePendingInput() {
        store.appendMessage("sess-1", makeMsg(type: "pending_input", seq: 0,
            payload: ["content": AnyCodable("draft message")]))

        store.resolvePendingInput("sess-1", seq: 5, content: "draft message")

        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].type, "user_message")
        XCTAssertEqual(messages[0].seq, 5)
    }

    func testResolvePendingInputBySeqOnly() {
        store.appendMessage("sess-1", makeMsg(type: "pending_input", seq: 0,
            payload: ["content": AnyCodable("hello")]))

        store.resolvePendingInput("sess-1", seq: 3)

        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages[0].type, "user_message")
        XCTAssertEqual(messages[0].seq, 3)
    }

    // MARK: - Resolve Permission/Question Messages

    func testResolvePermissionMessage() {
        store.appendMessage("sess-1", makeMsg(type: "permission", seq: 1,
            payload: ["id": AnyCodable("perm-1"), "toolName": AnyCodable("shell")]))

        store.resolvePermissionMessage("sess-1", permissionId: "perm-1", resolution: "approved")

        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages[0].resolution, "approved")
    }

    func testResolveQuestionMessage() {
        store.appendMessage("sess-1", makeMsg(type: "question", seq: 1,
            payload: ["id": AnyCodable("q-1"), "question": AnyCodable("Continue?")]))

        store.resolveQuestionMessage("sess-1", questionId: "q-1", answerText: "yes")

        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages[0].answer, "yes")
    }

    // MARK: - Permissions

    func testAddRemovePermission() {
        let perm = PendingPermission(
            id: "p1", sessionId: "sess-1", description: "Run shell",
            toolName: "shell", args: nil, timestamp: Date()
        )
        store.addPermission(perm)
        XCTAssertEqual(store.pendingPermissions.count, 1)
        XCTAssertEqual(store.pendingPermissions["p1"]?.sessionId, "sess-1")

        store.removePermission("p1")
        XCTAssertTrue(store.pendingPermissions.isEmpty)
    }

    func testPermissionsForSession() {
        store.addPermission(PendingPermission(
            id: "p1", sessionId: "sess-1", description: "a",
            toolName: nil, args: nil, timestamp: Date()
        ))
        store.addPermission(PendingPermission(
            id: "p2", sessionId: "sess-2", description: "b",
            toolName: nil, args: nil, timestamp: Date()
        ))
        store.addPermission(PendingPermission(
            id: "p3", sessionId: "sess-1", description: "c",
            toolName: nil, args: nil, timestamp: Date()
        ))

        let perms = store.permissionsForSession("sess-1")
        XCTAssertEqual(perms.count, 2)
        XCTAssertTrue(perms.allSatisfy { $0.sessionId == "sess-1" })
    }

    // MARK: - Questions

    func testAddRemoveQuestion() {
        let q = PendingQuestion(
            id: "q1", sessionId: "sess-1", question: "Continue?",
            choices: ["yes", "no"], timestamp: Date()
        )
        store.addQuestion(q)
        XCTAssertEqual(store.pendingQuestions.count, 1)

        store.removeQuestion("q1")
        XCTAssertTrue(store.pendingQuestions.isEmpty)
    }

    func testQuestionsForSession() {
        store.addQuestion(PendingQuestion(
            id: "q1", sessionId: "sess-1", question: "a",
            choices: nil, timestamp: Date()
        ))
        store.addQuestion(PendingQuestion(
            id: "q2", sessionId: "sess-2", question: "b",
            choices: nil, timestamp: Date()
        ))

        let questions = store.questionsForSession("sess-1")
        XCTAssertEqual(questions.count, 1)
        XCTAssertEqual(questions[0].id, "q1")
    }

    // MARK: - Convenience

    func testHasPendingInput() {
        XCTAssertFalse(store.hasPendingInput("sess-1"))

        store.appendMessage("sess-1", makeMsg(type: "pending_input", seq: 0))
        XCTAssertTrue(store.hasPendingInput("sess-1"))
    }

    func testLastAgentMessageContent() {
        XCTAssertNil(store.lastAgentMessageContent("sess-1"))

        store.appendMessage("sess-1", makeMsg(type: "agent_message", seq: 1,
            payload: ["content": AnyCodable("first")]))
        store.appendMessage("sess-1", makeMsg(type: "user_message", seq: 2))
        store.appendMessage("sess-1", makeMsg(type: "agent_message", seq: 3,
            payload: ["content": AnyCodable("last")]))

        XCTAssertEqual(store.lastAgentMessageContent("sess-1"), "last")
    }

    // MARK: - Clear Transient State

    func testClearTransientState() {
        store.appendMessage("sess-1", makeMsg(type: "pending_input", seq: 0))
        store.appendMessage("sess-1", makeMsg(type: "user_message", seq: 1))
        store.addPermission(PendingPermission(
            id: "p1", sessionId: "sess-1", description: "test",
            toolName: nil, args: nil, timestamp: Date()
        ))
        store.addQuestion(PendingQuestion(
            id: "q1", sessionId: "sess-1", question: "test",
            choices: nil, timestamp: Date()
        ))

        store.clearTransientState()

        XCTAssertTrue(store.pendingPermissions.isEmpty)
        XCTAssertTrue(store.pendingQuestions.isEmpty)
        // pending_input removed, user_message kept
        let messages = store.getMessages("sess-1")
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages[0].type, "user_message")
    }

    // MARK: - Reset

    func testReset() {
        store.appendMessage("sess-1", makeMsg(seq: 1))
        store.addPermission(PendingPermission(
            id: "p1", sessionId: "sess-1", description: "test",
            toolName: nil, args: nil, timestamp: Date()
        ))
        store.addQuestion(PendingQuestion(
            id: "q1", sessionId: "sess-1", question: "test",
            choices: nil, timestamp: Date()
        ))

        store.reset()

        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertTrue(store.pendingPermissions.isEmpty)
        XCTAssertTrue(store.pendingQuestions.isEmpty)
    }
}
