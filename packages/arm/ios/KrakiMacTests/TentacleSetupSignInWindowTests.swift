import AuthenticationServices
import XCTest
@testable import Kraki_Dev

/// "Show Sign-in Window" during GitHub sign-in (TentacleSetupRunner.reopenBrowser)
/// must bring the window back, not end the sign-in (K-329). Runs a fake
/// `kraki setup --json` and a fake system sign-in window; nothing is shown.
@MainActor
final class TentacleSetupSignInWindowTests: XCTestCase {
    /// Behaves like ASWebAuthenticationSession: cancelling reports
    /// `canceledLogin` to the completion handler later, on the main queue.
    private final class FakeSignInWindow: SetupWebAuthSession {
        let completion: SetupWebAuth.Completion
        private(set) var cancelled = false
        init(completion: @escaping SetupWebAuth.Completion) { self.completion = completion }
        func start() -> Bool { true }
        func cancel() {
            cancelled = true
            DispatchQueue.main.async {
                self.completion(nil, ASWebAuthenticationSessionError(.canceledLogin))
            }
        }
    }

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("setup-signin-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A `kraki setup --json --oauth` that waits for the callback on stdin and
    /// reports "cancelled" when stdin closes, like the tentacle.
    private func fakeSetup() throws -> String {
        let script = directory.appendingPathComponent("kraki")
        try """
        #!/bin/sh
        echo '{"event":"start"}'
        echo '{"event":"oauth_url","url":"https://github.com/login/oauth/authorize?client_id=x","callbackScheme":"kraki"}'
        if read callback; then
          echo '{"event":"authenticated","username":"octo"}'
          echo '{"event":"done","username":"octo"}'
          exit 0
        fi
        echo '{"event":"error","code":"cancelled"}'
        exit 1
        """.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        return script.path
    }

    private func waitUntil(_ condition: () -> Bool, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertTrue(condition(), "timed out", file: file, line: line)
    }

    func testShowSignInWindowKeepsTheSignInGoing() throws {
        var windows: [FakeSignInWindow] = []
        let runner = TentacleSetupRunner { _, _, completion in
            let window = FakeSignInWindow(completion: completion)
            windows.append(window)
            return window
        }
        runner.start(binaryPath: try fakeSetup())
        waitUntil { runner.phase == .waitingForBrowser && windows.count == 1 }

        runner.reopenBrowser()
        XCTAssertEqual(windows.count, 2, "a new sign-in window opens")
        XCTAssertTrue(windows[0].cancelled)
        // Let the replaced window's cancellation arrive (and the setup react).
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertEqual(runner.phase, .waitingForBrowser, "the old window's cancellation must not end the sign-in")

        // Approving GitHub in the new window signs in.
        windows[1].completion(URL(string: "kraki://oauth/callback?code=abc"), nil)
        waitUntil { runner.phase == .done(username: "octo") }
    }

    func testCancellingStillEndsTheSignIn() throws {
        var windows: [FakeSignInWindow] = []
        let runner = TentacleSetupRunner { _, _, completion in
            let window = FakeSignInWindow(completion: completion)
            windows.append(window)
            return window
        }
        runner.start(binaryPath: try fakeSetup())
        waitUntil { runner.phase == .waitingForBrowser && windows.count == 1 }
        // The user closes the sign-in window: EOF makes the setup report "cancelled".
        windows[0].completion(nil, ASWebAuthenticationSessionError(.canceledLogin))
        waitUntil { runner.phase == .idle }
    }
}
