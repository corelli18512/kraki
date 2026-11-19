import Foundation

/// What a composer draft is addressed to: the open permission (the draft is
/// its deny reason), the open question (its answer) or the conversation.
///
/// A draft stays bound to the target that was open when it was started
/// (K-021). If that changed before Send — a permission or question arrived,
/// or was resolved elsewhere — the send is held once and the user is told,
/// instead of the text silently going to the new target: a deny reason must
/// never deny another command, an answer must not become a steer. A prompt
/// that becomes a steer is not a new target.
enum ComposerDraftTarget: Equatable {
    case conversation
    case permission(String)
    case question(String)

    init(permissionID: String?, questionID: String?) {
        if let permissionID {
            self = .permission(permissionID)
        } else if let questionID {
            self = .question(questionID)
        } else {
            self = .conversation
        }
    }

    /// True when a draft bound to `bound` must not be sent to `live` without
    /// a second press. An unbound draft (nil) is never held.
    static func changed(boundTo bound: ComposerDraftTarget?, live: ComposerDraftTarget) -> Bool {
        guard let bound else { return false }
        return bound != live
    }

    static var changedNotice: String {
        String(localized: "The agent's request changed. Check your message, then send again.")
    }
}
