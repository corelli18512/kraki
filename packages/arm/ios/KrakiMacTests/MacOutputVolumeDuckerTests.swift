import XCTest
@testable import Kraki_Dev

/// Lowering other sounds while dictating (MacOutputVolumeDucker), against a
/// fake output device: no real volume is touched.
final class MacOutputVolumeDuckerTests: XCTestCase {
    final class FakeDevice: OutputVolumeBackend {
        var volumeValue: Float32 = 0.8
        var muted = false
        var writable = true
        var failReads = false
        var rejectWrites = false
        var writes: [Float32] = []
        func defaultDevice() throws -> UInt32 { 42 }
        func supportsWritableVolume(_ device: UInt32) -> Bool { writable }
        func volume(_ device: UInt32) throws -> Float32 {
            if failReads { throw NSError(domain: "fake", code: 1) }
            return volumeValue
        }
        func setVolume(_ device: UInt32, _ value: Float32) throws {
            writes.append(value)
            if !rejectWrites { volumeValue = value }
        }
        func isMuted(_ device: UInt32) -> Bool { muted }
    }

    final class FakeWatchdog: OutputVolumeWatchdogLauncher {
        var launched = 0
        var stopped = 0
        var fail = false
        func launch(journal: URL, state: OutputVolumeState) throws -> () -> Void {
            if fail { throw NSError(domain: "fake", code: 2) }
            launched += 1
            return { [weak self] in self?.stopped += 1 }
        }
    }

    private var dir: URL!
    private var journal: OutputVolumeJournal!
    private var device: FakeDevice!
    private var watchdog: FakeWatchdog!
    private var enabled = true

    override func setUp() {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("duck-\(UUID().uuidString)")
        journal = OutputVolumeJournal(url: dir.appendingPathComponent("state.json"))
        device = FakeDevice()
        watchdog = FakeWatchdog()
        enabled = true
    }

    override func tearDown() { try? FileManager.default.removeItem(at: dir) }

    private func makeDucker() -> MacOutputVolumeDucker {
        MacOutputVolumeDucker(backend: device, journal: journal, watchdogLauncher: watchdog,
                              isEnabled: { [unowned self] in self.enabled })
    }

    private func lower(_ ducker: MacOutputVolumeDucker) {
        ducker.scheduleLowering(after: 0)
        ducker.drain()
        ducker.drain() // the delayed work item
        let deadline = Date().addingTimeInterval(1)
        while !ducker.isLowered, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    }

    func testTargetIsTheLowerOfTwentyPercentAndFortyPercentOfCurrent() {
        XCTAssertEqual(OutputVolumeDucking.target(original: 1.0) ?? -1, 0.20, accuracy: 0.0001)
        XCTAssertEqual(OutputVolumeDucking.target(original: 0.30) ?? -1, 0.12, accuracy: 0.0001)
        XCTAssertNil(OutputVolumeDucking.target(original: 0.02), "already quiet: don't touch")
        XCTAssertNil(OutputVolumeDucking.target(original: 0))
    }

    func testLowersThenRestoresAndCleansUp() {
        let ducker = makeDucker()
        lower(ducker)
        XCTAssertEqual(device.volumeValue, 0.20, accuracy: 0.0001)
        XCTAssertEqual(journal.read()?.originalVolume ?? -1, 0.8, accuracy: 0.0001, "journaled before lowering")
        XCTAssertEqual(watchdog.launched, 1)
        ducker.restore(reason: "test")
        ducker.drain()
        XCTAssertEqual(device.volumeValue, 0.8, accuracy: 0.0001)
        XCTAssertNil(journal.read())
        XCTAssertEqual(watchdog.stopped, 1)
        XCTAssertFalse(ducker.isLowered)
    }

    func testAVolumeTheUserChangedMeanwhileIsKept() {
        let ducker = makeDucker()
        lower(ducker)
        device.volumeValue = 0.55 // user turned it up mid-dictation
        ducker.restore(reason: "test")
        ducker.drain()
        XCTAssertEqual(device.volumeValue, 0.55, accuracy: 0.0001)
        XCTAssertNil(journal.read())
        XCTAssertFalse(ducker.isLowered)

        lower(ducker)
        device.muted = true // or muted it
        ducker.restore(reason: "test")
        ducker.drain()
        XCTAssertEqual(device.writes.last ?? -1, 0.20, accuracy: 0.0001, "no restore write after mute")
    }

    func testReleasedBeforeTheCueDelayNeverLowers() {
        let ducker = makeDucker()
        ducker.scheduleLowering(after: 0.3)
        ducker.restore(reason: "quick tap")
        ducker.drain()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        ducker.drain()
        XCTAssertTrue(device.writes.isEmpty)
        XCTAssertEqual(watchdog.launched, 0)
    }

    func testSkipsDisabledMutedReadOnlyOrQuietDevices() {
        enabled = false
        lower(makeDucker())
        enabled = true
        device.muted = true
        lower(makeDucker())
        device.muted = false
        device.writable = false
        lower(makeDucker())
        device.writable = true
        device.volumeValue = 0.03
        lower(makeDucker())
        XCTAssertTrue(device.writes.isEmpty)
        XCTAssertEqual(watchdog.launched, 0)
        XCTAssertNil(journal.read())
    }

    func testNoWatchdogMeansNoLowering() {
        watchdog.fail = true
        lower(makeDucker())
        XCTAssertTrue(device.writes.isEmpty, "never lower what we couldn't protect")
        XCTAssertNil(journal.read())
    }

    func testDeviceRejectingTheLevelIsPutBackAndForgotten() {
        device.rejectWrites = true
        let ducker = makeDucker()
        lower(ducker)
        XCTAssertFalse(ducker.isLowered)
        XCTAssertEqual(device.volumeValue, 0.8, accuracy: 0.0001)
        XCTAssertNil(journal.read())
        XCTAssertEqual(watchdog.stopped, 1)
    }

    func testLaunchRecoversTheJournalOfADeadKrakiOnly() throws {
        // Owner gone (crashed): restored.
        device.volumeValue = 0.2
        try journal.write(OutputVolumeState(deviceID: 42, originalVolume: 0.8, duckedVolume: 0.2,
                                            ownerPID: 999_999, token: "t", startedAt: 0))
        let ducker = makeDucker()
        ducker.recoverAbandonedState()
        ducker.drain()
        XCTAssertEqual(device.volumeValue, 0.8, accuracy: 0.0001)
        XCTAssertNil(journal.read())

        // Owner alive (another Kraki recording right now): left alone.
        device.volumeValue = 0.2
        try journal.write(OutputVolumeState(deviceID: 42, originalVolume: 0.8, duckedVolume: 0.2,
                                            ownerPID: ProcessInfo.processInfo.processIdentifier, token: "u", startedAt: 0))
        ducker.recoverAbandonedState()
        ducker.drain()
        XCTAssertEqual(device.volumeValue, 0.2, accuracy: 0.0001)
        XCTAssertNotNil(journal.read())
    }

    func testUnreadableDeviceKeepsTheJournalForLater() {
        let ducker = makeDucker()
        lower(ducker)
        device.failReads = true // device switched away mid-recording
        ducker.restore(reason: "test")
        ducker.drain()
        XCTAssertNotNil(journal.read(), "kept for the watchdog / next launch")
        XCTAssertTrue(ducker.isLowered, "a new recording can't overwrite the unrecovered level")
        device.failReads = false
        let deadline = Date().addingTimeInterval(2)
        while ducker.isLowered, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertEqual(device.volumeValue, 0.8, accuracy: 0.0001, "retry restored it")
    }
}
