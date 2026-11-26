import Foundation

/// An image waiting in a composer to be sent (encoded as it will be sent).
/// `id` identifies this attachment, so a view can cache its decoded preview.
struct StagedComposerImage: Equatable {
    let id = UUID()
    let data: Data
    let mimeType: String
}

/// An image being prepared for a Session's composer (`prepareStagedImage`).
struct PreparingComposerImage {
    let attempt = UUID()
    /// Stops the work preparing it (a photo loading, a GIF being fitted).
    let cancel: () -> Void
}

extension SessionStore {
    /// Stages (or, with nil, removes) the image in a Session's composer.
    /// Either way an image still being prepared for it is dropped and its
    /// work stopped: the latest choice wins. Cleared with the Session
    /// (`removeSession`, a session list without it, `reset`).
    func setStagedImage(_ id: String, _ image: StagedComposerImage?) {
        cancelPreparingImage(id)
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
    /// result and cancels `prepare` (`setStagedImage`), which stops early
    /// where it checks for cancellation (`ComposerGIFFit`).
    @MainActor
    func prepareStagedImage<Prepared: Sendable>(
        _ id: String,
        _ prepare: @escaping @Sendable () async -> Prepared,
        stage: @escaping @MainActor (Prepared) -> Void
    ) {
        cancelPreparingImage(id)
        if stagedImages[id] != nil { stagedImages.removeValue(forKey: id) }
        let work = Task.detached(priority: .userInitiated, operation: prepare)
        let preparing = PreparingComposerImage(cancel: work.cancel)
        preparingImages[id] = preparing
        Task { @MainActor in
            let prepared = await work.value
            guard preparingImages[id]?.attempt == preparing.attempt else { return }
            preparingImages.removeValue(forKey: id)
            stage(prepared)
        }
    }

    /// `reset`: no Session keeps a staged image or one being prepared.
    func discardAllStagedImages() {
        stagedImages.removeAll()
        preparingImages.values.forEach { $0.cancel() }
        preparingImages.removeAll()
    }

    /// `reconcileSessionList`'s tail and `removeSession`: removed Sessions
    /// lose their staged image (or one being prepared) with their draft.
    /// Returns the ids unchanged.
    func discardingStagedImages(of removedIDs: Set<String>) -> Set<String> {
        for id in removedIDs {
            if stagedImages[id] != nil { stagedImages.removeValue(forKey: id) }
            cancelPreparingImage(id)
        }
        return removedIDs
    }

    private func cancelPreparingImage(_ id: String) {
        guard let preparing = preparingImages[id] else { return }
        preparing.cancel()
        preparingImages.removeValue(forKey: id)
    }
}
