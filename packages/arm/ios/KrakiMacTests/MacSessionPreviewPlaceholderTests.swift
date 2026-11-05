#if os(macOS) && DEBUG
import AppKit
import XCTest
@testable import Kraki_Dev

/// K-314: a running Session kept the "Session created" placeholder. The
/// placeholder is stamped with the session_created envelope; the computer's
/// own preview (an imported or prompt-started Session's first line) can be
/// older and lost the timestamp comparison.
@MainActor
final class MacSessionPreviewPlaceholderTests: XCTestCase {
    func testComputerPreviewReplacesTheCreatedPlaceholder() throws {
        let app = AppState.makeUnitTestHost()
        let device = "preview-placeholder-device"
        app.deviceStore.addDevice(DeviceSummary(id: device, name: "Mac", role: .tentacle, kind: .desktop, publicKey: nil,
                                                encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_created", "deviceId": device, "sessionId": "s1", "seq": 0,
            "timestamp": "2026-10-01T00:00:10.000Z",
            "payload": ["agent": "pi", "model": "m", "lastSeq": 0]]))
        XCTAssertEqual(app.sessionStore.sessionPreviews["s1"]?.type, "session_created")

        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": device, "seq": 1, "timestamp": ISO8601.withFractional.string(from: Date()),
            "payload": ["sessions": [[
                "id": "s1", "agent": "pi", "model": "m", "title": "Imported", "state": "active", "mode": "auto",
                "lastSeq": 3, "readSeq": 3, "messageCount": 3, "createdAt": "2026-10-01T00:00:00.000Z",
                "lastActivityAt": "2026-10-01T00:00:05.000Z",
                "preview": ["text": "Refactor the parser", "type": "user", "timestamp": "2026-10-01T00:00:05.000Z"],
            ]], "archivedCount": 0, "autoArchiveDays": 14]]))

        XCTAssertEqual(app.sessionStore.sessionPreviews["s1"]?.text, "Refactor the parser")
        XCTAssertEqual(app.sessionStore.sessionPreviews["s1"]?.type, "user")
    }

    func testOlderRealPreviewsStillDoNotMoveBackwards() throws {
        let app = AppState.makeUnitTestHost()
        let store = app.sessionStore
        store.setPreview("s2", text: "Newer", type: "agent", timestamp: "2026-10-01T00:00:10.000Z")
        store.setPreview("s2", text: "Older", type: "user", timestamp: "2026-10-01T00:00:05.000Z")
        XCTAssertEqual(store.sessionPreviews["s2"]?.text, "Newer")
    }

    /// K-314(b): the Dock count is set again once notifications are allowed,
    /// without waiting for the unread count to change.
    func testDockBadgeIsSetAgainAfterPermission() {
        defer { MacDockBadge.show(unread: 0) }
        MacDockBadge.show(unread: 3)
        XCTAssertEqual(NSApp.dockTile.badgeLabel, "3")
        NSApp.dockTile.badgeLabel = nil
        MacDockBadge.reapply()
        XCTAssertEqual(NSApp.dockTile.badgeLabel, "3")
        MacDockBadge.show(unread: 0)
        XCTAssertEqual(NSApp.dockTile.badgeLabel ?? "", "")
    }
}
#endif
