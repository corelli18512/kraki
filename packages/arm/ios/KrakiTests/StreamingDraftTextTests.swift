import XCTest
@testable import Kraki

#if os(iOS)
/// What the streaming draft draws for the text received so far.
@MainActor
final class StreamingDraftTextTests: XCTestCase {
    private func draftContent(_ text: String) -> String? {
        let card = MessageStore.SessionCard(text: text, action: nil)
        return TKBubbleContent.live(card: card, agent: "pi", sessionId: "draft-\(UUID().uuidString)", steps: 0)
            .message.content
    }

    /// K-047: the landed reply is trimmed; leading blank lines drew the draft
    /// taller and made it jump up at handoff.
    func testDraftDropsLeadingBlankLinesLikeTheLandedReply() {
        XCTAssertEqual(draftContent("\n\n  Here is what I found"), "Here is what I found")
        XCTAssertNil(draftContent("\n\n"))
        XCTAssertEqual(draftContent("Line one\n\n    code"), "Line one\n\n    code")
    }

    /// K-049: a chunk that ends inside a grapheme cluster holds it back
    /// instead of drawing the wrong glyph until the rest arrives.
    func testDraftHoldsBackAnUnfinishedTrailingGrapheme() {
        let hold = TKBubbleContent.withoutIncompleteTrailingGrapheme
        XCTAssertEqual(hold("Japan \u{1F1EF}"), "Japan ", "a lone regional indicator is half a flag")
        XCTAssertEqual(hold("Flags \u{1F1EF}\u{1F1F5}"), "Flags \u{1F1EF}\u{1F1F5}")
        XCTAssertEqual(hold("\u{1F1EF}\u{1F1F5}\u{1F1FA}"), "\u{1F1EF}\u{1F1F5}")
        XCTAssertEqual(hold("Family \u{1F468}\u{200D}"), "Family ", "a sequence waiting for its next emoji")
        XCTAssertEqual(hold("Family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}"),
                       "Family \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}")
        XCTAssertEqual(hold("Wales \u{1F3F4}\u{E0067}\u{E0062}"), "Wales ", "a tag sequence without its end")
        XCTAssertEqual(hold("Wales \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}"),
                       "Wales \u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}")
        XCTAssertEqual(hold("plain text"), "plain text")
        XCTAssertEqual(draftContent("Japan \u{1F1EF}"), "Japan ")
    }

    func testFrozenCardKeepsItsWholeText() {
        let card = MessageStore.SessionCard(text: "Stopped at \u{1F1EF}", action: nil)
        let frozen = TKBubbleContent.live(card: card, agent: "pi", sessionId: "frozen", steps: 0, isFrozen: true)
        XCTAssertEqual(frozen.message.content, "Stopped at \u{1F1EF}")
    }
}
#endif
