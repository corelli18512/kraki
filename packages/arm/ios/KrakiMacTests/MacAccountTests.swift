import XCTest
@testable import Kraki_Dev

/// Settings › Account and computer-key warnings on the Mac.
@MainActor
final class MacAccountTests: XCTestCase {

    /// K-265: a CJK name gets one character, not the first two of the full name.
    func testAccountInitials() {
        XCTAssertEqual(AccountPane.initials(from: "王小明@example.com"), "王")
        XCTAssertEqual(AccountPane.initials(from: "さくら@example.com"), "さ")
        XCTAssertEqual(AccountPane.initials(from: "김민준@example.com"), "김")
        XCTAssertEqual(AccountPane.initials(from: "burn2alice"), "BU")
        XCTAssertEqual(AccountPane.initials(from: "jane.doe@example.com"), "JD")
        XCTAssertEqual(AccountPane.initials(from: "🦊fox@example.com"), "🦊F")
    }

    /// K-114: a computer reinstalled with new keys is flagged, and the Mac's
    /// warning names a recovery a Mac can do (it can't scan a pairing code).
    func testComputerKeyChangeWarningOnTheMac() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("key-warning-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let app = AppState(testDatabase: try MessageDatabase(databaseURL: root.appendingPathComponent("m.sqlite")))
        let computer = "dev_rekeyed_\(UUID().uuidString.prefix(8))"
        defer { app.deviceStore.keyPins.forget(computer) }

        let first = try CryptoManager().exportPublicKeySPKI(try CryptoManager().generateKeyPair().publicKey)
        let second = try CryptoManager().exportPublicKeySPKI(try CryptoManager().generateKeyPair().publicKey)
        app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Studio", role: .tentacle, kind: .desktop, encryptionKey: first, online: true)])
        XCTAssertNil(app.keyWarning)
        app.deviceStore.setDevices([DeviceSummary(id: computer, name: "Studio", role: .tentacle, kind: .desktop, encryptionKey: second, online: true)])

        let warning = try XCTUnwrap(app.keyWarning)
        XCTAssertEqual(warning.ids, [computer])
        XCTAssertTrue(warning.message.contains("Studio"), warning.message)
        XCTAssertTrue(warning.message.contains("sign out of Kraki on this Mac"), warning.message)
        XCTAssertFalse(warning.message.contains("scan"), warning.message)
    }
}
