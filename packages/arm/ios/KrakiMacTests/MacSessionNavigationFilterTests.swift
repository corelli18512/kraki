#if os(macOS) && DEBUG
import XCTest
@testable import Kraki_Dev

/// K-246: ⌘1–9 and ⌥⌘↑/↓ opened Sessions the sidebar search had hidden.
@MainActor
final class MacSessionNavigationFilterTests: XCTestCase {
    private func digest(_ id: String, _ title: String, _ createdAt: String) -> [String: Any] {
        ["id": id, "agent": "pi", "model": "m", "title": title, "state": "idle", "mode": "auto",
         "lastSeq": 1, "readSeq": 1, "messageCount": 1, "createdAt": createdAt, "lastActivityAt": createdAt]
    }

    func testKeyboardNavigationFollowsTheSidebarFilter() throws {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("nav-filter-\(UUID().uuidString).sqlite")))
        for (id, name) in [("d1", "Mac mini"), ("d2", "Build Server")] {
            app.deviceStore.addDevice(DeviceSummary(id: id, name: name, role: .tentacle, kind: .desktop, publicKey: nil,
                                                    encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        }
        let lists: [(String, [[String: Any]])] = [
            ("d1", [digest("a", "Fix voice layout", "2026-10-01T00:00:03.000Z"),
                    digest("b", "Release notes", "2026-10-01T00:00:02.000Z")]),
            ("d2", [digest("c", "Voice broker deploy", "2026-10-01T00:00:01.000Z")]),
        ]
        for (device, sessions) in lists {
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
                "type": "session_list", "deviceId": device, "seq": 1, "timestamp": ISO8601.withFractional.string(from: Date()),
                "payload": ["sessions": sessions, "archivedCount": 0, "autoArchiveDays": 14]]))
        }
        let store = app.sessionStore
        XCTAssertEqual(Set(store.filteredNavigationSessions.map(\.id)), ["a", "b", "c"], "no filter: every session")

        store.navigationFilter = SessionListFilter(deviceId: nil, query: "voice")
        XCTAssertEqual(Set(store.filteredNavigationSessions.map(\.id)), ["a", "c"])
        XCTAssertEqual(store.filteredNavigationSessions.map(\.id),
                       store.navigationOrderedSessions.map(\.id).filter { ["a", "c"].contains($0) },
                       "sidebar order kept")

        store.navigationFilter = SessionListFilter(deviceId: "d2", query: "voice")
        XCTAssertEqual(store.filteredNavigationSessions.map(\.id), ["c"])
    }
}
#endif
