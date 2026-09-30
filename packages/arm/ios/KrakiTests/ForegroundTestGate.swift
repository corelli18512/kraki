import XCTest

/// Tests that open on-screen windows (they can take the developer's window
/// focus, keyboard or pointer) or drive voice input are not part of the routine
/// local run. CI runs them (KRAKI_RUN_UI_TESTS=1); run them locally only when
/// working on those features:
///
///   KRAKI_RUN_UI_TESTS=1 bash scripts/test-native.sh mac -only-testing:KrakiMacTests/MacChatUXRegressionTests
func requireForegroundUITests(file: StaticString = #filePath, line: UInt = #line) throws {
    try XCTSkipUnless(ProcessInfo.processInfo.environment["KRAKI_RUN_UI_TESTS"] == "1",
                      "Window/voice suite: set KRAKI_RUN_UI_TESTS=1 (runs in CI)", file: file, line: line)
}
