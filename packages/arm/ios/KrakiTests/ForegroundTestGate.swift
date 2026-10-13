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

/// Polls `done` on the main actor for up to `seconds` (CI runners can run a
/// short timer late; a fixed sleep made bounded-timing tests flaky).
@MainActor
func waitBriefly(seconds: TimeInterval = 2, _ done: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !done(), Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
}
