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

    func testAloneOrReplacingAQuittingInstanceStarts() {
        XCTAssertNil(MacSingleInstance.runningInstance(among: [C(pid: 200, isTerminated: false)], currentPID: 200))
        XCTAssertNil(MacSingleInstance.runningInstance(among: [], currentPID: 200))
        XCTAssertNil(MacSingleInstance.runningInstance(among: [C(pid: 100, isTerminated: true), C(pid: 200, isTerminated: false)],
                                                       currentPID: 200), "an update relaunch must start")
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
