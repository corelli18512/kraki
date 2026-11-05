#if os(macOS) && DEBUG
import XCTest
@testable import Kraki_Dev

/// K-330: a second copy of Kraki (another bundle, `open -n`) ran beside the
/// first. The launch decision only; nothing is launched.
final class MacSingleInstanceTests: XCTestCase {
    private typealias C = MacSingleInstance.Candidate

    func testASecondLaunchFindsTheRunningInstance() {
        let running = C(pid: 100, isTerminated: false)
        XCTAssertEqual(MacSingleInstance.runningInstance(among: [running, C(pid: 200, isTerminated: false)],
                                                          currentPID: 200), running)
    }

    func testAloneOrAfterAnExitedInstanceStarts() {
        XCTAssertNil(MacSingleInstance.runningInstance(among: [C(pid: 200, isTerminated: false)], currentPID: 200))
        XCTAssertNil(MacSingleInstance.runningInstance(among: [], currentPID: 200))
        XCTAssertNil(MacSingleInstance.runningInstance(among: [C(pid: 100, isTerminated: true), C(pid: 200, isTerminated: false)],
                                                       currentPID: 200), "an instance that has exited is not running")
    }

    /// "Relaunch Now" (language) starts a new copy while this one still
    /// runs; that copy must start, not hand back and exit.
    func testARelaunchIgnoresTheInstanceItReplaces() {
        let replaced = C(pid: 100, isTerminated: false)
        let args = ["/Applications/Kraki.app/Contents/MacOS/Kraki", MacSingleInstance.relaunchedFromArgument, "100"]
        XCTAssertEqual(MacSingleInstance.relaunchedFromPID(arguments: args), 100)
        XCTAssertNil(MacSingleInstance.runningInstance(among: [replaced, C(pid: 200, isTerminated: false)],
                                                       currentPID: 200, ignoring: 100))
        // A third copy still finds the one that is not being replaced.
        let other = C(pid: 300, isTerminated: false)
        XCTAssertEqual(MacSingleInstance.runningInstance(among: [replaced, other], currentPID: 200, ignoring: 100), other)
        XCTAssertNil(MacSingleInstance.relaunchedFromPID(arguments: ["Kraki"]))
        XCTAssertNil(MacSingleInstance.relaunchedFromPID(arguments: ["Kraki", MacSingleInstance.relaunchedFromArgument]))
    }

    @MainActor
    func testTheTestHostNeverHandsOff() {
        // Returns (does not exit) in the test host.
        MacSingleInstance.handOffToRunningInstanceIfNeeded()
        XCTAssertEqual(MacSingleInstance.showWindowNotification(bundleId: "chat.kraki.mac").rawValue,
                       "chat.kraki.mac.showMainWindow")
    }
}
#endif
