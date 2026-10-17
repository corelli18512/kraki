import Foundation

extension SessionStore {
    /// Called on every entry, before the Session is marked read: remembers
    /// where the reader was (the chat lands on what's new, ChatScrollPolicy)
    /// and whether there really was something unread.
    func captureEntryUnreadBoundary(_ id: String) {
        let fromNotification = notificationEntrySessions.remove(id) != nil
        let unread = isUnread(id)
        guard let session = sessions[id], session.readSeq > 0, unread || fromNotification else {
            entryUnreadBoundaries.removeValue(forKey: id)
            entryUnreadGaps.remove(id)
            return
        }
        entryUnreadBoundaries[id] = session.readSeq
        if unread { entryUnreadGaps.insert(id) } else { entryUnreadGaps.remove(id) }
    }
}
