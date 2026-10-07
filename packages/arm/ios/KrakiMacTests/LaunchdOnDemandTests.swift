import XCTest
@testable import Kraki_Dev

final class LaunchdOnDemandTests: XCTestCase {
    func testReadsOnDemandCountFromLaunchctlPrint() {
        let stuck = "gui/501 = {\n\ttype = gui\n\ton-demand count = 1\n\tactive count = 140\n}"
        XCTAssertEqual(TentacleCLIManager.onDemandCount(fromLaunchctlPrint: stuck), 1)
        let normal = "gui/501 = {\n\ton-demand count = 0\n}"
        XCTAssertEqual(TentacleCLIManager.onDemandCount(fromLaunchctlPrint: normal), 0)
        XCTAssertEqual(TentacleCLIManager.onDemandCount(fromLaunchctlPrint: "garbage"), 0)
    }

    func testThisMacIsReallyReadable() {
        // Sanity: the real `launchctl print gui/<uid>` contains the field.
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["print", "gui/\(getuid())"]; let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        try? p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile() // read before wait: output > pipe buffer
        p.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        // The domain is readable. macOS 27 omits `on-demand count` when it is
        // 0, so only check that a missing field reads as "not stuck".
        XCTAssertEqual(p.terminationStatus, 0)
        XCTAssertTrue(text.contains("active count = "), "launchctl print gui/<uid> is readable")
        if !text.contains("on-demand count = ") {
            XCTAssertEqual(TentacleCLIManager.onDemandCount(fromLaunchctlPrint: text), 0)
        }
    }
}
