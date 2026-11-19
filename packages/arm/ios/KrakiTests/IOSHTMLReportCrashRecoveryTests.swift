import WebKit
import XCTest
@testable import Kraki

#if os(iOS)
/// K-057: the report web view reloads once after its content process dies;
/// a second death before that reload finished must surface an error (with Try
/// Again) instead of leaving the sheet blank.
@MainActor
final class IOSHTMLReportCrashRecoveryTests: XCTestCase {
    func testSecondContentProcessCrashBeforeFinishingReportsFailure() {
        var failures = 0
        let coordinator = IOSHTMLArtifactWebView.Coordinator(onReady: {}, onContentProcessFailure: { failures += 1 })
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        webView.navigationDelegate = coordinator
        coordinator.load(html: "<p>report</p>", artifactID: "report-1", into: webView)

        coordinator.webViewWebContentProcessDidTerminate(webView)
        XCTAssertEqual(failures, 0, "the first crash reloads the report")

        coordinator.webViewWebContentProcessDidTerminate(webView)
        XCTAssertEqual(failures, 1, "a second crash before the reload finished is reported, not swallowed")
    }

    func testCrashAfterASuccessfulReloadRecoversAgain() {
        var failures = 0
        let coordinator = IOSHTMLArtifactWebView.Coordinator(onReady: {}, onContentProcessFailure: { failures += 1 })
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        webView.navigationDelegate = coordinator
        coordinator.load(html: "<p>report</p>", artifactID: "report-1", into: webView)

        coordinator.webViewWebContentProcessDidTerminate(webView)
        coordinator.webView(webView, didFinish: nil)
        coordinator.webViewWebContentProcessDidTerminate(webView)
        XCTAssertEqual(failures, 0, "each crash after a finished load gets its own reload")
    }
}
#endif
