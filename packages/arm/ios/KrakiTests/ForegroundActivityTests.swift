import XCTest
@testable import Kraki

final class ForegroundActivityTests: XCTestCase {
    func testOnlyForegroundAuthenticatedUseAndNoBacklog() {
        var eligible = false
        var sends = 0
        var time = Date(timeIntervalSince1970: 1_000)
        let reporter = ForegroundActivityReporter(eligible: { eligible }, platformActive: { true },
                                                  send: { sends += 1 }, now: { time })
        reporter.refresh()
        XCTAssertEqual(sends, 0)
        eligible = true
        reporter.refresh()
        reporter.refresh()
        XCTAssertEqual(sends, 1)
        time += 60
        reporter.refresh()
        XCTAssertEqual(sends, 2)
        eligible = false
        reporter.refresh()
        time += 86400
        reporter.refresh()
        XCTAssertEqual(sends, 2)
        eligible = true
        reporter.refresh()
        XCTAssertEqual(sends, 3, "only current foreground signal, never yesterday's backlog")
        reporter.stop()
    }

    func testOptimisticLifecycleHintCannotReportDuringBackgroundColdLaunch() {
        var platformActive = false
        var sends = 0
        let reporter = ForegroundActivityReporter(eligible: { true }, platformActive: { platformActive },
                                                  send: { sends += 1 })
        reporter.refresh()
        XCTAssertEqual(sends, 0, "auth/lifecycle hints alone are not foreground proof")
        platformActive = true
        reporter.refresh()
        XCTAssertEqual(sends, 1)
        platformActive = false
        reporter.refresh()
        XCTAssertEqual(sends, 1)
        platformActive = true
        reporter.refresh()
        XCTAssertEqual(sends, 2, "activation reports now, without replaying background activity")
        reporter.stop()
    }
}
