/// Finding the row a Session with new messages opens at.

#if os(macOS)
import AppKit

extension MacChatDocumentView {
    /// The first new row on entry (ChatScrollPolicy.firstUnreadRow).
    func firstItem(afterSeq boundary: Int, latestReplyFallback: Bool = false) -> (key: String, frame: NSRect)? {
        let rows = contents.enumerated().map { (id: $0.offset, seq: $0.element.seq > 0 ? $0.element.seq : nil,
                                                isUser: $0.element.isUser) }
        guard let index = ChatScrollPolicy.firstUnreadRow(rows, after: boundary,
                                                          latestReplyFallback: latestReplyFallback),
              index < itemFrames.count, index < itemKeys.count else { return nil }
        return (itemKeys[index], itemFrames[index])
    }
}
#endif
