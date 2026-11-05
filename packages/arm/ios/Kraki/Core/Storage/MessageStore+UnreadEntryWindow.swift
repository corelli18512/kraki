import Foundation

extension MessageStore {
    /// Read rows kept above the first unread one when the entry window is
    /// opened there (`anchorWindowAtFirstUnread`).
    private static let firstUnreadContextRows = 3

    /// Entering with more unread rows than the tail window holds: start the
    /// window at the first unread row stored on this device, so the chat
    /// lands on it instead of mid-backlog at the tail window's top (K-042).
    /// A few read rows stay above it for context; older and newer rows page
    /// in as the reader scrolls. No-op when the window already reaches the
    /// first unread row or nothing after it is stored.
    func anchorWindowAtFirstUnread(_ sessionId: String, after boundary: Int) {
        guard let state = windows[sessionId], state.bottomSeq > 0, state.topSeq > boundary + 1 else { return }
        let unread = dbMessagesAfter(sessionId, afterSeq: boundary, limit: Self.initialWindowSize)
            .filter(Self.isPersistent)
        guard let firstUnread = unread.first, firstUnread.seq < state.topSeq else { return }
        let context = dbMessagesBefore(sessionId, beforeSeq: firstUnread.seq, limit: Self.firstUnreadContextRows)
            .filter(Self.isPersistent)
        let page = context + unread
        guard let first = page.first, let last = page.last else { return }
        messages[sessionId] = page
        windows[sessionId] = WindowState(topSeq: first.seq, bottomSeq: last.seq)
        #if os(macOS)
        KLog.chatEntry(
            "mac-window reason=first-unread session=\(sessionId.prefix(12)) "
                + "boundary=\(boundary) window=[\(first.seq),\(last.seq)] rows=\(page.count)"
        )
        #endif
    }
}
