import XCTest
@testable import Kraki

/// Settings › Archive After across several computers (K-082): every computer
/// on the account gets the value, also one offline since launch, and the
/// picker says when the computers disagree.
@MainActor
final class ArchiveSettingsTests: XCTestCase {
    private var sent: [(type: String, target: String?, days: Int?)] = []

    private func makeApp() throws -> AppState {
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("archive-\(UUID().uuidString).sqlite")))
        app.connectionStatus = .connected
        app.testOutboundMessageHandler = { [weak self] message, _, _ in
            self?.sent.append((message["type"] as? String ?? "", message["targetDeviceId"] as? String,
                               (message["payload"] as? [String: Any])?["days"] as? Int))
            return true
        }
        return app
    }

    private func sessionList(_ app: AppState, from deviceId: String, days: Int) throws {
        app.messageRouter?.handleDataMessage(try JSONSerialization.data(withJSONObject: [
            "type": "session_list", "deviceId": deviceId, "timestamp": ISO8601.withFractional.string(from: Date()),
            "payload": ["sessions": [] as [Any], "archivedCount": 1, "autoArchiveDays": days],
        ]))
    }

    private func computer(_ id: String, online: Bool) -> DeviceSummary {
        DeviceSummary(id: id, name: id, role: .tentacle, online: online)
    }

    func testOfflineSinceLaunchComputerGetsArchiveAfterWhenItReports() throws {
        let app = try makeApp()
        app.deviceStore.setDevices([computer("on", online: true), computer("off", online: false)])
        try sessionList(app, from: "on", days: 14)
        XCTAssertEqual(app.sessionStore.autoArchiveDays, 14)

        sent.removeAll()
        app.commandSender?.setAutoArchiveDaysOnAllComputers(30)
        XCTAssertEqual(sent.filter { $0.type == "set_auto_archive_days" }.map(\.target), ["on"])
        XCTAssertEqual(app.sessionStore.autoArchiveDays, 30)

        // The offline computer comes back still on 14: it gets 30 now, once.
        sent.removeAll()
        app.deviceStore.setDeviceOnline("off", online: true)
        try sessionList(app, from: "off", days: 14)
        XCTAssertEqual(sent.map(\.type), ["set_auto_archive_days"])
        XCTAssertEqual(sent.first?.target, "off")
        XCTAssertEqual(sent.first?.days, 30)
        sent.removeAll()
        try sessionList(app, from: "off", days: 30)
        try sessionList(app, from: "on", days: 30)
        XCTAssertTrue(sent.isEmpty)
        XCTAssertTrue(app.sessionStore.pendingAutoArchiveDays.isEmpty)
        XCTAssertEqual(app.sessionStore.autoArchiveDays, 30)
    }

    func testComputersWithDifferentValuesShowNoSingleValue() throws {
        let app = try makeApp()
        try sessionList(app, from: "a", days: 7)
        try sessionList(app, from: "b", days: 90)
        XCTAssertNil(app.sessionStore.autoArchiveDays)
        try sessionList(app, from: "b", days: 7)
        XCTAssertEqual(app.sessionStore.autoArchiveDays, 7)
    }
}
