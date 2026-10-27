import Foundation

/// An image waiting in a composer to be sent (encoded as it will be sent).
/// `id` identifies this attachment, so a view can cache its decoded preview.
struct StagedComposerImage: Equatable {
    let id = UUID()
    let data: Data
    let mimeType: String
}

extension SessionStore {
    /// Stages (or, with nil, removes) the image in a Session's composer.
    /// Cleared with the Session (`removeSession`, a session list without it,
    /// `reset`).
    func setStagedImage(_ id: String, _ image: StagedComposerImage?) {
        if stagedImages[id] != image { stagedImages[id] = image }
    }
}
