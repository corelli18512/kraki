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
    }
}
