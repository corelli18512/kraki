import XCTest

/// Captures the design reference used to keep the Web client in sync with
/// iOS. Local stack only: runs when TEST_RUNNER_KRAKI_E2E_SESSION is set
/// (scripts/e2e/seed-design-sessions.ts creates the sessions).
final class DesignReferenceUITests: XCTestCase {
    func testCaptureSessionAndList() throws {
        let env = ProcessInfo.processInfo.environment
        guard let session = env["KRAKI_E2E_SESSION"], !session.isEmpty else { throw XCTSkip("local only") }
        let dir = env["KRAKI_E2E_SHOTS"] ?? "/tmp/kraki-design-ios"
        let tag = env["KRAKI_E2E_TAG"] ?? "ref"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        func shot(_ name: String) {
            try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(dir)/\(tag)-\(name).png"))
        }
        let app = XCUIApplication()
        app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = env["KRAKI_E2E_PORT"] ?? "4470"
        if session != "list" { app.launchEnvironment["KRAKI_OPEN_SESSION_ID"] = session }
        app.launch()
        let devLogin = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Dev Login")).firstMatch
        if devLogin.waitForExistence(timeout: 8) { devLogin.tap() }
        sleep(12)
        shot("chat")
        if session == "list" { return }
        app.swipeDown()
        sleep(2)
        shot("chat-older")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.068)).tap()
        sleep(3)
        shot("list")
    }
}
