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
    /// Either way an image still being prepared for it is dropped: the
    /// latest choice wins. Cleared with the Session (`removeSession`, a
    /// session list without it, `reset`).
    func setStagedImage(_ id: String, _ image: StagedComposerImage?) {
        if preparingImages[id] != nil { preparingImages.removeValue(forKey: id) }
        if stagedImages[id] != image { stagedImages[id] = image }
    }

    /// True while an image is being prepared for a Session's composer: the
    /// composer shows it loading (× cancels) and Send waits for it, so the
    /// image is neither sent late with the next message nor dropped.
    func isPreparingImage(_ id: String) -> Bool { preparingImages[id] != nil }

    /// Prepares an image for a Session's composer off the main thread, then
    /// hands the result to `stage` on the main thread. The image staged
    /// before goes at once (this one replaces it, so it cannot be sent by
    /// mistake meanwhile). A newer image, × or a send since then drops the
    /// result (`setStagedImage`).
    @MainActor
    func prepareStagedImage<Prepared: Sendable>(
        _ id: String,
        _ prepare: @escaping @Sendable () async -> Prepared,
        stage: @escaping @MainActor (Prepared) -> Void
    ) {
        let attempt = UUID()
        if stagedImages[id] != nil { stagedImages.removeValue(forKey: id) }
        preparingImages[id] = attempt
        Task { @MainActor in
            let prepared = await Task.detached(priority: .userInitiated, operation: prepare).value
            guard preparingImages[id] == attempt else { return }
            preparingImages.removeValue(forKey: id)
            stage(prepared)
        }
    }

    /// `reset`: no Session keeps a staged image or one being prepared.
    func discardAllStagedImages() {
        stagedImages.removeAll()
        preparingImages.removeAll()
    }

    /// `reconcileSessionList`'s tail and `removeSession`: removed Sessions
    /// lose their staged image (or one being prepared) with their draft.
    /// Returns the ids unchanged.
    func discardingStagedImages(of removedIDs: Set<String>) -> Set<String> {
        for id in removedIDs {
            if stagedImages[id] != nil { stagedImages.removeValue(forKey: id) }
            if preparingImages[id] != nil { preparingImages.removeValue(forKey: id) }
        }
        return removedIDs
    }
}
