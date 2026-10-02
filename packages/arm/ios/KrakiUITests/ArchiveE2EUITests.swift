import XCTest

/// Archived sessions (F2) against a LOCAL Kraki stack (scripts/dev-local.ts).
/// Seed first: `pnpm exec tsx scripts/e2e/archive-e2e.ts seed`.
/// Runs only when TEST_RUNNER_KRAKI_E2E_ARCHIVE=1.
final class ArchiveE2EUITests: XCTestCase {
    private var shots = "/tmp/kraki-e2e-archive"

    private func shot(_ name: String) {
        try? XCUIScreen.main.screenshot().pngRepresentation
            .write(to: URL(fileURLWithPath: "\(shots)/\(name).png"))
    }

    func testOpenArchivedSessionFromListFooter() throws {
        let env = ProcessInfo.processInfo.environment
        guard env["KRAKI_E2E_ARCHIVE"] == "1" else { throw XCTSkip("local E2E only") }
        shots = env["KRAKI_E2E_SHOTS"] ?? shots
        try? FileManager.default.createDirectory(atPath: shots, withIntermediateDirectories: true)

        let app = XCUIApplication()
        let port = env["KRAKI_E2E_PORT"] ?? "4410"
        app.launchEnvironment["KRAKI_LOCAL_RELAY_PORT"] = port
        app.launch()
        // Must start signed out (a clean simulator) and use the local dev
        // login — never run this against a real account.
        let devLogin = app.buttons.containing(NSPredicate(format: "label CONTAINS[c] %@", "Dev Login")).firstMatch
        guard devLogin.waitForExistence(timeout: 15) else {
            XCTFail("expected a signed-out clean simulator with Dev Login")
            return
        }
        devLogin.tap()

        let archived = app.cells["session-list-archived"]
        XCTAssertTrue(archived.waitForExistence(timeout: 30), "collapsed Archived (N) row under the session list")
        let rowsBefore = app.cells.count
        sleep(1)
        shot("1-collapsed")
        archived.tap()

        // Expands in place: the archived sessions appear as normal rows.
        let deadline = Date().addingTimeInterval(15)
        while app.cells.count <= rowsBefore && Date() < deadline { usleep(200_000) }
        XCTAssertGreaterThan(app.cells.count, rowsBefore, "archived sessions expand inline")
        sleep(1)
        shot("2-expanded")
        app.cells.element(boundBy: app.cells.count - 1).tap()

        XCTAssertTrue(app.staticTexts["ok"].waitForExistence(timeout: 20), "opened archived session shows its history")
        sleep(1)
        shot("3-opened")
    }
}
