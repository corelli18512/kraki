import XCTest
@testable import Kraki_Dev

/// "Locate kraki manually…" only accepts the kraki CLI (K-352).
@MainActor
final class TentacleCLILocateTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("locate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    private func script(_ name: String, printing output: String, exit code: Int = 0) throws -> String {
        let url = dir.appendingPathComponent(name)
        try "#!/bin/sh\nprintf '%s\\n' '\(output)'\nexit \(code)\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url.path
    }

    func testVersionOutputIsABareVersion() {
        XCTAssertTrue(TentacleCLIManager.isKrakiVersionOutput("0.38.11"))
        XCTAssertTrue(TentacleCLIManager.isKrakiVersionOutput("0.39.0-beta.2\n"))
        XCTAssertTrue(TentacleCLIManager.isKrakiVersionOutput("1.0.0+build.7"))
        XCTAssertFalse(TentacleCLIManager.isKrakiVersionOutput("text"))
        XCTAssertFalse(TentacleCLIManager.isKrakiVersionOutput(""))
        XCTAssertFalse(TentacleCLIManager.isKrakiVersionOutput("ls: unrecognized option `--version'"))
        XCTAssertFalse(TentacleCLIManager.isKrakiVersionOutput("Python 3.12.1"))
    }

    func testOnlyAKrakiCLIIsAccepted() async throws {
        let manager = TentacleCLIManager()
        let kraki = try script("kraki", printing: "0.38.11")
        let version = await manager.krakiVersion(at: kraki)
        XCTAssertEqual(version, "0.38.11")
        let other = await manager.krakiVersion(at: try script("tool", printing: "text"))
        XCTAssertNil(other, "an executable that is not kraki")
        let failing = await manager.krakiVersion(at: try script("broken", printing: "0.38.11", exit: 1))
        XCTAssertNil(failing)
        let ls = await manager.krakiVersion(at: "/bin/ls")
        XCTAssertNil(ls, "/bin/ls is not 'kraki found'")
        let missing = await manager.krakiVersion(at: dir.appendingPathComponent("missing").path)
        XCTAssertNil(missing)
    }

    private final class Folders: FileManager {
        let existing: Set<String>
        init(_ existing: Set<String>) { self.existing = existing }
        override func fileExists(atPath path: String) -> Bool { existing.contains(path) }
    }

    func testPanelStartsInAnExistingCLIFolder() {
        let local = NSHomeDirectory() + "/.local/bin"
        XCTAssertEqual(TentacleCLIManager.locateStartDirectory(fileManager: Folders([local, "/usr/local/bin"]))?.path, local,
                       "the installer's folder first")
        XCTAssertEqual(TentacleCLIManager.locateStartDirectory(fileManager: Folders(["/opt/homebrew/bin"]))?.path,
                       "/opt/homebrew/bin")
        XCTAssertNil(TentacleCLIManager.locateStartDirectory(fileManager: Folders([])),
                     "never a missing folder")
    }
}
