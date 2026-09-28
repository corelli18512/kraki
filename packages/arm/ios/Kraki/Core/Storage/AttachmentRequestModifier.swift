import SwiftUI

/// Requests attachments while a view shows them — keyed by the refs, not by
/// view appearance. Chat cells are reused and swap their hosted SwiftUI root
/// for another message without the view "appearing" again, so `onAppear`
/// alone never requested the new message's images (a cached image then
/// showed a loading placeholder forever). `task(id:)` re-runs whenever the
/// refs change and is cancelled when the view goes away, releasing them.
private struct AttachmentRequestModifier: ViewModifier {
    let ids: [String]
    let sessionId: String
    let store: AttachmentStore?
    let priority: AttachmentPriority

    func body(content: Content) -> some View {
        content.task(id: ids.joined(separator: ",") + "|" + sessionId) {
            guard let store, !ids.isEmpty else { return }
            for id in ids { store.requestIfNeeded(id: id, sessionId: sessionId, priority: priority) }
            // Hold the request until SwiftUI cancels this task.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_600_000_000_000)
            }
            for id in ids { store.release(id: id, priority: priority) }
        }
    }
}

extension View {
    func requestsAttachments(
        _ ids: [String],
        sessionId: String,
        store: AttachmentStore?,
        priority: AttachmentPriority = .visible
    ) -> some View {
        modifier(AttachmentRequestModifier(ids: ids, sessionId: sessionId, store: store, priority: priority))
    }
}
