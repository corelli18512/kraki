import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// Triage #11/#23: a message the computer refused without storing it (its
/// disk is full, device trust refused it) is named by its clientId on an
/// `error`. A bare `error` is never a chat row (TurnSpineProjection): the
/// bubble shows "Not delivered" (Retry / Delete) instead of a clock, and the
/// toast says why in the app's own words.
@MainActor
final class ComputerRefusedInputTests: XCTestCase {
    private func makeApp() -> AppState {
        let app = AppState.makeUnitTestHost()
        app.testOutboundMessageHandler = { _, _, _ in true }
        app.sessionStore.upsertSession(SessionInfo(
            id: "s", deviceId: "d", deviceName: "D", agent: "claude", title: "Chat",
            state: .idle, mode: .auto, lastSeq: 2, readSeq: 2, messageCount: 2,
            createdAt: Date(), pinned: false))
        return app
    }

    private func refuse(_ app: AppState, _ fields: [String: Any]) throws {
        var payload: [String: Any] = ["message": "Kraki on this computer could not save your message because its disk is full."]
        payload.merge(fields) { $1 }
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "error", "sessionId": "s", "deviceId": "d", "seq": 3, "payload": payload,
        ]))
    }

    private func states(_ sender: CommandSender) -> [String: CommandSender.PendingState] {
        Dictionary(uniqueKeysWithValues: sender.pendingInputs("s").compactMap { message in
            message.clientId.map { ($0, sender.pendingState(message)) }
        })
    }

    func testRefusedMessageShowsNotDeliveredAndWhy() throws {
        let app = makeApp()
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: "s", text: "hello"))
        XCTAssertTrue(sender.sendInput(sessionId: "s", text: "second"))
        let ids = sender.pendingInputs("s").compactMap(\.clientId)
        XCTAssertEqual(ids.count, 2)

        try refuse(app, ["clientId": ids[0], "code": "input_disk_full"])
        XCTAssertEqual(states(sender), [ids[0]: .failed, ids[1]: .sending])
        XCTAssertEqual(app.lastError,
                       "Kraki on your computer couldn't save this message because its disk is full. Free some space, then retry.")

        try refuse(app, ["clientId": ids[1], "code": "trust_rejected_clock"])
        XCTAssertEqual(states(sender)[ids[1]], .failed)
        XCTAssertEqual(app.lastError,
                       "Your computer refused this message because this device's clock is ahead of the computer's. Check the date and time on both, then retry.")

        // Retry sends it again with the same clientId.
        XCTAssertTrue(sender.retryPending(sessionId: "s", clientId: ids[0]))
        XCTAssertEqual(states(sender)[ids[0]], .sending)
    }

    func testOnlyThisAppsWaitingMessageIsMarkedAndUnknownCodesGetGenericCopy() throws {
        let app = makeApp()
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: "s", text: "hello"))
        let id = try XCTUnwrap(sender.pendingInputs("s").first?.clientId)

        try refuse(app, ["clientId": "another-apps-message", "code": "input_disk_full"])
        try refuse(app, ["code": "trust_rejected_stale"])
        XCTAssertEqual(states(sender)[id], .sending)
        XCTAssertNil(app.lastError)

        try refuse(app, ["clientId": id, "code": "something_new"])
        XCTAssertEqual(states(sender)[id], .failed)
        XCTAssertEqual(app.lastError,
                       "Kraki on your computer couldn't take this message. Retry; if it keeps failing, check the computer.")
    }

    func testRefusalCopyIsTranslated() throws {
        let path = try XCTUnwrap(Bundle(for: AppState.self).path(forResource: "zh-Hans", ofType: "lproj")
            ?? Bundle.main.path(forResource: "zh-Hans", ofType: "lproj"))
        let zh = try XCTUnwrap(Bundle(path: path))
        XCTAssertEqual(zh.localizedString(forKey: RefusedInputText.describe(code: "input_disk_full"), value: nil, table: nil),
                       "电脑上的 Kraki 无法保存这条消息，因为磁盘已满。请释放一些空间后重试。")
        for code in ["trust_rejected_clock", "trust_rejected_stale", "trust_rejected_unrecorded", nil] {
            let english = RefusedInputText.describe(code: code)
            XCTAssertNotEqual(zh.localizedString(forKey: english, value: nil, table: nil), english, "zh-Hans for \(code ?? "generic")")
        }
        for code in ["trust_rejected_clock", "trust_rejected_stale", "trust_rejected_unrecorded"] {
            let english = try XCTUnwrap(RefusedRequestText.describe(code: code))
            XCTAssertNotEqual(zh.localizedString(forKey: english, value: nil, table: nil), english, "zh-Hans for the request's \(code)")
        }
        XCTAssertEqual(zh.localizedString(forKey: "Not delivered. %@", value: nil, table: nil), "未送达。%@")
        XCTAssertEqual(zh.localizedString(forKey: "Not delivered. %@ Click to retry or delete", value: nil, table: nil), "未送达。%@ 点按重试或删除")
    }

    /// Triage review P2-5: a create or fork the computer refused (device
    /// trust) fails its placeholder in the app's words, not the computer's
    /// English. Other failures keep the computer's text.
    func testRefusedCreateAndForkSayWhyInTheAppsWords() throws {
        let app = makeApp()
        let sender = try XCTUnwrap(app.commandSender)
        let english = "This computer refused the request because the sending device's clock is ahead of the computer's. Check the date and time on both, then try again."
        func failRequest(_ requestId: String, _ fields: [String: Any]) throws -> String? {
            let placeholder = try XCTUnwrap(sender.pendingPlaceholderIds[requestId])
            var payload: [String: Any] = ["message": english, "requestId": requestId]
            payload.merge(fields) { $1 }
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
                "type": "error", "sessionId": "", "deviceId": "d", "seq": 0, "payload": payload,
            ]))
            XCTAssertNil(sender.pendingPlaceholderIds[requestId])
            return app.sessionStore.pendingSessionErrors[placeholder]
        }

        sender.forkSession(sessionId: "s")
        let fork = try XCTUnwrap(sender.pendingPlaceholderIds.keys.first)
        XCTAssertEqual(try failRequest(fork, ["code": "trust_rejected_stale"]),
                       "Your computer refused this request: it was signed too long ago, this device's clock is behind, or the computer recently reset its security state. Check the date and time, then try again in a few minutes.")
        let create = try XCTUnwrap(sender.createSession(targetDeviceId: "d", agentId: "pi", model: "m"))
        XCTAssertEqual(try failRequest(create, ["code": "trust_rejected_clock"]),
                       "Your computer refused this request because this device's clock is ahead of the computer's. Check the date and time on both, then try again.")
        let unrecorded = try XCTUnwrap(sender.createSession(targetDeviceId: "d", agentId: "pi", model: "m"))
        XCTAssertEqual(try failRequest(unrecorded, ["code": "trust_rejected_unrecorded"]),
                       "Your computer couldn't record this request securely, so it wasn't run. Check that Kraki on the computer can write to its data folder, then try again.")
        let newCode = try XCTUnwrap(sender.createSession(targetDeviceId: "d", agentId: "pi", model: "m"))
        XCTAssertEqual(try failRequest(newCode, ["code": "trust_rejected_something_new"]), "The computer couldn't complete that. Try again.")
        let other = try XCTUnwrap(sender.createSession(targetDeviceId: "d", agentId: "pi", model: "m"))
        XCTAssertEqual(try failRequest(other, ["message": "Couldn't create the session: pi is not installed"]),
                       "Couldn't create the session: pi is not installed")
    }

    #if os(macOS)
    /// Triage review P2-2: the toast is iOS-only, so the Mac bubble says why
    /// (tooltip and VoiceOver). The reason goes away with that failure.
    func testMacBubbleSaysWhyTheComputerRefusedIt() throws {
        let app = makeApp()
        var accept = true
        app.testOutboundMessageHandler = { _, _, _ in accept }
        let sender = try XCTUnwrap(app.commandSender)
        XCTAssertTrue(sender.sendInput(sessionId: "s", text: "hello"))
        let id = try XCTUnwrap(sender.pendingInputs("s").first?.clientId)
        try refuse(app, ["clientId": id, "code": "trust_rejected_unrecorded"])
        let why = "Your computer couldn't record this message securely, so it wasn't run. Check that Kraki on the computer can write to its data folder, then retry."
        var cell = try bubble(app)
        XCTAssertEqual(cell.deliveryStatusForRegression, "Not delivered. \(why) Click to retry or delete")
        XCTAssertEqual(statusToolTip(cell), "Not delivered. \(why)")

        // Retried, then not taken by transport: a failure of another kind.
        XCTAssertTrue(sender.retryPending(sessionId: "s", clientId: id))
        accept = false
        XCTAssertFalse(sender.retryPending(sessionId: "s", clientId: id))
        cell = try bubble(app)
        XCTAssertEqual(cell.deliveryStatusForRegression, "Not delivered. Click to retry or delete")
        XCTAssertEqual(statusToolTip(cell), "Not delivered")
    }

    private func statusToolTip(_ cell: MacChatBubbleCell) -> String? {
        cell.subviews.compactMap { $0 as? NSButton }.first { $0.accessibilityLabel() == cell.deliveryStatusForRegression }?.toolTip
    }

    private func bubble(_ app: AppState) throws -> MacChatBubbleCell {
        let message = try XCTUnwrap(app.commandSender?.pendingInputs("s").first)
        let content = MacChatBubbleContentBuilder.make(message: message, sessionId: "s", agent: "claude", documentWidth: 640)
        let cell = MacChatBubbleCell(frame: NSRect(x: 0, y: 0, width: 640, height: 1))
        cell.configure(
            content: content, renderKey: "refused-\(content.pendingDeliveryState ?? "")", documentWidth: 640, sessionMode: .auto,
            onTapSteps: { _ in }, onResolvePermission: { _, _, _ in }, onAnswerQuestion: { _, _ in },
            onOpenImage: { _ in }, onOpenHTMLArtifact: { _ in }, onHeightInvalidated: {})
        return cell
    }
    #endif
}
