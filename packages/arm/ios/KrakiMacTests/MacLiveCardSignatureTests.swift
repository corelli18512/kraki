#if os(macOS) && DEBUG
import XCTest
@testable import Kraki_Dev

/// K-263: every session's draft row is keyed `__live__` and the CoreText
/// layout cache is shared: two drafts of the same length and ending (only
/// the last 512 bytes are hashed) collided, and one session showed the
/// other's draft.
final class MacLiveCardSignatureTests: XCTestCase {
    func testSameDraftInTwoSessionsHasDifferentSignatures() {
        let tail = String(repeating: "same ending ", count: 60)
        var a = MessageStore.SessionCard()
        a.text = "STREAM-S1 " + tail
        var b = MessageStore.SessionCard()
        b.text = "STREAM-S3 " + tail
        XCTAssertEqual(a.text.utf8.count, b.text.utf8.count)
        XCTAssertNotEqual(MacChatListRepresentable.liveCardSignature(a, sessionId: "s1"),
                          MacChatListRepresentable.liveCardSignature(b, sessionId: "s3"))
        XCTAssertEqual(MacChatListRepresentable.liveCardSignature(a, sessionId: "s1"),
                       MacChatListRepresentable.liveCardSignature(a, sessionId: "s1"), "stable within a session")
    }
}
#endif
