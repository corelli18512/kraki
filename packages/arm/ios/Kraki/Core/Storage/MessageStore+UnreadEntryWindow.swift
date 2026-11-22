import Foundation

extension MessageStore {
    /// Read rows kept above the first unread one (`anchorWindowAtFirstUnread`).
    private static let firstUnreadContextRows = 3

    /// Most unread rows added above the newest window, on iOS and Mac. More
    /// would take an iOS window past its rendered-height cap, where every live
    /// arrival trims a row off the top: the rows under the reader.
    private static let maxUnreadPrependRows = 30

    /// Entering with more unread rows than the newest window holds (K-042):
    /// keep that window and add, above it, the unread rows down to the first
    /// unread one plus a few read rows, so the chat lands on it while the
    /// newest message, a live card and an open question stay in the window.
    /// No-op, so main's window and landing, when the window already holds the
    /// first unread row, more unread rows than the cap lie above it, or this
    /// device's cache has a hole there: a row missing inside the window would
    /// never be shown (older paging fills holes only below the window top).
    func anchorWindowAtFirstUnread(_ sessionId: String, after boundary: Int) {
        guard let state = windows[sessionId], state.bottomSeq > 0, state.topSeq > boundary + 1,
              let newest = messages[sessionId], !newest.isEmpty else { return }
        let unread = dbMessagesAfter(sessionId, afterSeq: boundary, limit: Self.maxUnreadPrependRows + 1)
            .filter { Self.isPersistent($0) && $0.seq < state.topSeq }
        guard unread.count <= Self.maxUnreadPrependRows, unread.first?.seq == boundary + 1,
              unread.last?.seq == state.topSeq - 1, Self.isDense(unread) else { return }
        let page = readContext(sessionId, endingAt: boundary) + unread
        guard let first = page.first else { return }
        messages[sessionId] = page + newest
        windows[sessionId] = WindowState(topSeq: first.seq, bottomSeq: state.bottomSeq)
        #if os(macOS)
        KLog.chatEntry(
            "mac-window reason=first-unread session=\(sessionId.prefix(12)) "
                + "boundary=\(boundary) window=[\(first.seq),\(state.bottomSeq)] added=\(page.count)"
        )
        #endif
    }

    /// Up to `firstUnreadContextRows` read rows directly above the first
    /// unread one, stopping at a hole.
    private func readContext(_ sessionId: String, endingAt boundary: Int) -> [ChatMessage] {
        var rows: [ChatMessage] = []
        for row in dbMessagesBefore(sessionId, beforeSeq: boundary + 1, limit: Self.firstUnreadContextRows).reversed() {
            guard Self.isPersistent(row), row.seq == boundary - rows.count else { break }
            rows.insert(row, at: 0)
        }
        return rows
    }

    private static func isDense(_ rows: [ChatMessage]) -> Bool {
        zip(rows, rows.dropFirst()).allSatisfy { $1.seq == $0.seq + 1 }
    }
}
