import XCTest
import SwiftUI
@testable import Kraki

/// Session search shared by the iOS list and Mac sidebar.
final class SessionSearchTests: XCTestCase {
    private func digest(_ id: String, _ title: String, model: String = "deepseek-flash") -> [String: Any] {
        ["id": id, "agent": "pi", "model": model, "title": title, "state": "idle", "mode": "auto",
         "lastSeq": 1, "readSeq": 1, "messageCount": 1, "createdAt": "2026-10-01T00:00:00.000Z",
         "lastActivityAt": "2026-10-01T00:00:00.000Z"]
    }

    @MainActor
    func testSearchMatchesTitleComputerModelAndPreviewWithinAComputer() throws {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("search-\(UUID().uuidString).sqlite")))
        for (id, name) in [("d1", "Mac mini"), ("d2", "Build Server")] {
            app.deviceStore.addDevice(DeviceSummary(id: id, name: name, role: .tentacle, kind: .desktop, publicKey: nil,
                                                    encryptionKey: nil, online: true, lastSeen: nil, createdAt: nil))
        }
        let lists: [(String, [[String: Any]])] = [
            ("d1", [digest("a", "Fix voice layout"), digest("b", "Résumé parser", model: "claude-opus")]),
            ("d2", [digest("c", "Release notes")]),
        ]
        for (device, sessions) in lists {
            app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
                "type": "session_list", "deviceId": device, "seq": 1, "timestamp": ISO8601.withFractional.string(from: Date()),
                "payload": ["sessions": sessions, "archivedCount": 0, "autoArchiveDays": 14]]))
        }
        let store = app.sessionStore
        store.setPreview("c", text: "Signed and notarized the DMG")
        let all = store.sortedSessions
        func ids(_ device: String?, _ query: String) -> Set<String> {
            Set(store.filteredSessions(all, deviceId: device, matching: query).map(\.id))
        }
        XCTAssertEqual(ids(nil, ""), ["a", "b", "c"])
        XCTAssertEqual(ids(nil, "  "), ["a", "b", "c"], "whitespace is not a query")
        XCTAssertEqual(ids(nil, "VOICE"), ["a"], "case-insensitive title")
        XCTAssertEqual(ids(nil, "resume"), ["b"], "diacritic-insensitive")
        XCTAssertEqual(ids(nil, "opus"), ["b"], "model")
        XCTAssertEqual(ids(nil, "server"), ["c"], "computer name")
        XCTAssertEqual(ids(nil, "notarized"), ["c"], "preview text")
        XCTAssertEqual(ids("d1", "notarized"), [], "search stays within the chosen computer")
        XCTAssertEqual(ids("d2", ""), ["c"])
    }
}
