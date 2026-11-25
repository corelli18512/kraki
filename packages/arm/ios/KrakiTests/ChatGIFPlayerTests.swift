import XCTest
#if os(macOS)
@testable import Kraki_Dev
#else
@testable import Kraki
#endif

/// A chat GIF plays its frames on time, pauses off screen, and respects
/// Reduce Motion (first frame until the user plays it). iOS and Mac.
@MainActor
final class ChatGIFPlayerTests: XCTestCase {
    override func tearDown() {
        ChatGIFPlayer.reduceMotionOverride = nil
        super.tearDown()
    }

    private func animation(frames: Int, delay: Double, loopCount: Int = 0) throws -> ChatGIFAnimation {
        try XCTUnwrap(ChatGIFAnimation.decode(try ChatGIFFixture.gif(frames: frames, delays: Array(repeating: delay, count: frames), loopCount: loopCount)))
    }

    private func frameIndex(_ frame: CGImage?, in animation: ChatGIFAnimation) -> Int? {
        frame.flatMap { frame in animation.frames.firstIndex { $0 === frame } }
    }

    func testPlaysEveryFrameInOrder() async throws {
        let animation = try animation(frames: 4, delay: 0.05)
        var shown: [Int] = []
        let player = ChatGIFPlayer { [unowned self] frame in
            if let index = self.frameIndex(frame, in: animation), shown.last != index { shown.append(index) }
        }
        player.setVisible(true)
        player.load(animation, playing: true)
        try await waitBriefly(seconds: 10) { shown.count >= 6 }
        XCTAssertEqual(Array(shown.prefix(6)), [0, 1, 2, 3, 0, 1], "frames in order, then looping")
        player.pause()
    }

    func testOffScreenPlayerDoesNotTick() async throws {
        let animation = try animation(frames: 3, delay: 0.03)
        var frames = 0
        let player = ChatGIFPlayer { _ in frames += 1 }
        player.load(animation, playing: true)
        XCTAssertEqual(frames, 1, "shows the first frame")
        try await Task.sleep(for: .milliseconds(250))
        XCTAssertEqual(frames, 1, "not in a window: no timer")
        player.setVisible(true)
        try await waitBriefly(seconds: 10) { frames >= 3 }
        XCTAssertGreaterThanOrEqual(frames, 3)
        player.setVisible(false)
    }

    func testFiniteLoopStopsOnTheLastFrameAndReplays() async throws {
        let animation = try animation(frames: 3, delay: 0.03, loopCount: 2)
        var last: CGImage?
        let player = ChatGIFPlayer { last = $0 }
        player.setVisible(true)
        player.load(animation, playing: true)
        try await waitBriefly(seconds: 10) { !player.isPlaying }
        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(frameIndex(last, in: animation), 2)
        player.play()
        XCTAssertTrue(player.isPlaying, "plays again from the start")
        XCTAssertEqual(player.currentFrameIndex, 0)
    }

    func testReduceMotionShowsTheFirstFrameUntilPlayed() async throws {
        ChatGIFPlayer.reduceMotionOverride = true
        let file = ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 3, delays: [0.03, 0.03, 0.03]))
        var last: CGImage?
        var changes = 0
        let player = ChatGIFPlayer { last = $0 }
        player.onPlaybackChange = { changes += 1 }
        player.setVisible(true)
        player.show(file)
        try await waitBriefly(seconds: 10) { player.isAnimated }
        XCTAssertTrue(player.isAnimated)
        XCTAssertFalse(player.isPlaying)
        let animation = try XCTUnwrap(player.animation)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(frameIndex(last, in: animation), 0, "stays on the first frame")
        player.play()
        XCTAssertTrue(player.isPlaying)
        XCTAssertGreaterThan(changes, 0)
        player.pause()
    }

    func testAutoplaysWithoutReduceMotionAndStillImagesHaveNothingToPlay() async throws {
        ChatGIFPlayer.reduceMotionOverride = false
        let player = ChatGIFPlayer { _ in }
        player.setVisible(true)
        player.show(ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2)))
        try await waitBriefly(seconds: 10) { player.isPlaying }
        XCTAssertTrue(player.isPlaying)
        var frames: [CGImage?] = []
        player.onFrame = { frames.append($0) }
        player.show(ChatGIFFixture.file(try ChatGIFFixture.png(), mimeType: "image/png"))
        XCTAssertFalse(player.isAnimated)
        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(frames.count, 1)
        XCTAssertNil(frames.first ?? nil, "back to the still image")
    }

    /// The same bytes shown again under another name (a reused bubble): the
    /// GIF plays on, and the player holds the new name for Save Image….
    func testSameImageUnderAnotherNameKeepsPlayingWithTheNewName() async throws {
        ChatGIFPlayer.reduceMotionOverride = false
        let first = ChatGIFFixture.file(try ChatGIFFixture.gif(frames: 2), label: "first")
        let player = ChatGIFPlayer { _ in }
        player.setVisible(true)
        player.show(first)
        try await waitBriefly(seconds: 10) { player.isPlaying }
        var stills = 0
        player.onFrame = { if $0 == nil { stills += 1 } }
        player.show(ChatImageFile(id: first.id, data: first.data, mimeType: first.mimeType, label: "second"))
        XCTAssertEqual(player.file?.fileName, "second.gif")
        XCTAssertTrue(player.isPlaying, "the same image plays on")
        XCTAssertEqual(stills, 0, "not reloaded")
        player.pause()
    }
}
