/// Finding the row a Session with new messages opens at.

#if os(macOS)
import AppKit

extension MacChatDocumentView {
    /// The first new row on entry (ChatScrollPolicy.firstUnreadRow).
    func firstItem(afterSeq boundary: Int, latestReplyFallback: Bool = false) -> (key: String, frame: NSRect)? {
        // The live card carries its turn's prompt seq for Steps; it is not a
        // landed row (as on iPhone, where it has no seq).
        let rows = contents.enumerated().map { item in
            (id: item.offset, seq: item.element.seq > 0 && item.element.key != "__live__" ? item.element.seq : nil,
             isUser: item.element.isUser)
        }
        guard let index = ChatScrollPolicy.firstUnreadRow(rows, after: boundary,
                                                          latestReplyFallback: latestReplyFallback),
              index < itemFrames.count, index < itemKeys.count else { return nil }
        return (itemKeys[index], itemFrames[index])
    }
}
#endif
