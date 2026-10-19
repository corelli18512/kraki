import AppKit

extension MacChatScrollView {
    func schedulePresentationHealthCheck() {
        // Streaming snapshots may arrive 10–20 times per second. Keep the first
        // deadline for this epoch instead of perpetually postponing diagnosis;
        // the work item reads the latest window metadata when it fires.
        guard presentationHealthWorkItem == nil else { return }
        let epoch = presentationEpoch
        let work = DispatchWorkItem { [weak self] in
            guard let self, epoch == self.presentationEpoch else { return }
            self.presentationHealthWorkItem = nil
            let health = self.chatDocumentView.presentationHealth(in: self.contentView.bounds)
            if !self.isScrollInteractionActive, !health.unresolvedSeqs.isEmpty {
                _ = self.chatDocumentView.updateVisibleCells(
                    in: self.contentView.bounds,
                    runwayOverride: 0
                )
            }
            let refreshed = self.chatDocumentView.presentationHealth(in: self.contentView.bounds)
            self.emitPresentationLog(
                reason: refreshed.unresolvedSeqs.isEmpty
                    ? "viewport-resolved"
                    : "viewport-stuck",
                force: true
            )
        }
        presentationHealthWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75, execute: work)
    }
}
