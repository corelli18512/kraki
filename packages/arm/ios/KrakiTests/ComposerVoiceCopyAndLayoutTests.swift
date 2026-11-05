import XCTest
import CoreGraphics
#if os(iOS)
@testable import Kraki
#else
@testable import Kraki_Dev
#endif

/// Small pure rules behind chat images and voice copy (iPhone and Mac).
final class ComposerVoiceCopyAndLayoutTests: XCTestCase {
    private func displaySize(_ source: CGSize, maxWidth: CGFloat = 280, maxHeight: CGFloat = 240) -> CGSize {
        #if os(iOS)
        IOSImageGalleryLayout.displaySize(source: source, maxWidth: maxWidth, maxHeight: maxHeight)
        #else
        MacImageGalleryLayout.displaySize(source: source, maxWidth: maxWidth, maxHeight: maxHeight)
        #endif
    }

    /// K-157: a 1×1 image rendered as a 1-pt dot with a 1-pt tap target.
    func testTinyImageGetsATappableMinimumSize() {
        let dot = displaySize(CGSize(width: 1, height: 1))
        XCTAssertGreaterThanOrEqual(dot.width, 44)
        XCTAssertGreaterThanOrEqual(dot.height, 44)

        let line = displaySize(CGSize(width: 2_000, height: 1))
        XCTAssertEqual(line.width, 280, "never wider than the bubble")
        XCTAssertGreaterThanOrEqual(line.height, 44)

        XCTAssertEqual(displaySize(CGSize(width: 800, height: 600)), CGSize(width: 280, height: 210),
                       "ordinary images keep their aspect")
        XCTAssertEqual(displaySize(CGSize(width: 10, height: 10), maxWidth: 30), CGSize(width: 30, height: 30),
                       "the minimum never exceeds the available width")
    }

    /// K-181: the relay's raw (English) detail is not user copy.
    func testInvalidLeaseRequestShowsLocalizedCopyNotTheRelayDetail() {
        let error = VoiceInputError.leaseDenied(.invalidRequest, "lease request body missing resource")
        XCTAssertEqual(error.errorDescription, String(localized: "The voice authorization request was rejected."))
        XCTAssertEqual(VoiceInputError.leaseDenied(.invalidRequest, nil).errorDescription,
                       String(localized: "The voice authorization request was rejected."))
    }

    #if os(iOS)
    /// K-041: the offline notice is part of the bottom footprint the chat
    /// reserves, so the newest bubble and ↓ rest above it.
    func testOfflineNoticeCountsAsComposerFootprint() {
        let clearance: CGFloat = 60
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: clearance, composerVisible: true, compacting: false), 60)
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: clearance, composerVisible: true, compacting: false,
                                                    offlineNoticeHeight: 20.4), 60 + 21 + 8)
        XCTAssertEqual(ChatBottomObstruction.height(composerClearance: clearance, composerVisible: true, compacting: true,
                                                    offlineNoticeHeight: 20), 60 + 40 + 8 + 20 + 8)
    }

    /// K-041: a long computer name no longer hides the word "offline".
    func testOfflineNoticeKeepsOfflineInViewForLongNames() {
        let long = String(repeating: "Workstation-", count: 6)
        let text = IOSComposerOfflineNotice.text(deviceName: long)
        XCTAssertTrue(text.contains("offline"))
        XCTAssertLessThan(text.distance(from: text.startIndex, to: text.range(of: "offline")!.lowerBound),
                          IOSComposerOfflineNotice.maxNameLength + 5, "the name is shortened before \"offline\"")
        XCTAssertEqual(IOSComposerOfflineNotice.text(deviceName: "Desk"),
                       String(localized: "Desk is offline — message will deliver when it reconnects."))
        XCTAssertEqual(IOSComposerOfflineNotice.text(deviceName: nil),
                       String(localized: "Device is offline — message will deliver when it reconnects."))
    }

    /// K-069: the Stop square stays white while it fades out (it turned dark
    /// grey for a few frames when the turn stopped).
    func testStopGlyphStaysWhiteWhenTheButtonTurnsInactive() {
        XCTAssertEqual(MessageInputView.primaryGlyphColor("stop.fill", active: false), .white)
        XCTAssertEqual(MessageInputView.primaryGlyphColor("arrow.up", active: false), .secondary)
        XCTAssertEqual(MessageInputView.primaryGlyphColor("arrow.up", active: true), .white)
    }

    /// K-151: Stop is ignored only briefly after a submission.
    func testStopGraceAfterSubmit() {
        let sent = Date()
        XCTAssertTrue(MessageComposerPolicy.acceptsStop(lastSubmitAt: nil, now: sent))
        XCTAssertFalse(MessageComposerPolicy.acceptsStop(lastSubmitAt: sent, now: sent.addingTimeInterval(0.36)))
        XCTAssertTrue(MessageComposerPolicy.acceptsStop(lastSubmitAt: sent, now: sent.addingTimeInterval(1)))
    }

    /// K-152: a steer (or a deny reason) never takes the staged image.
    func testOnlyPromptsAndImageAnswersCarryTheStagedImage() {
        XCTAssertTrue(MessageComposerPolicy.carriesImage(.prompt, agent: "claude"))
        XCTAssertFalse(MessageComposerPolicy.carriesImage(.steer, agent: "pi"))
        XCTAssertFalse(MessageComposerPolicy.carriesImage(.denyPermission, agent: "pi"))
        XCTAssertTrue(MessageComposerPolicy.carriesImage(.answerQuestion, agent: "pi"))
        XCTAssertFalse(MessageComposerPolicy.carriesImage(.answerQuestion, agent: "claude"))
    }
    #endif

    /// K-194: the settings say why voice input is missing.
    func testVoiceUnavailableNoteOnlyForAConnectedRelayWithoutVoice() {
        let voice = VoiceCapability(brokerUrl: "wss://voice.invalid", resource: "voice/doubao")
        XCTAssertTrue(VoiceInputCopy.showsUnavailable(connectionStatus: .connected, voiceCapability: nil))
        XCTAssertFalse(VoiceInputCopy.showsUnavailable(connectionStatus: .connected, voiceCapability: voice))
        XCTAssertFalse(VoiceInputCopy.showsUnavailable(connectionStatus: .disconnected, voiceCapability: nil),
                       "not known while offline")
    }
}
