import AppKit

/// Bounded at-rest older paging for a history window that does not fill the
/// viewport (see `scheduleUnderfilledHistoryCheck`). Reset on every entry.
struct MacUnderfilledHistoryState {
    var scheduled = false
    var pagesRequested = 0
    var requestedTop: Int?
}

extension MacChatScrollView {
    func fullWindowGeometryDidBecomeReady() {
        requestInitialTailTrimIfReady()
        scheduleUnderfilledHistoryCheck()
    }

    /// A compact raw tail can project to less than one screen (e.g. stopped
    /// turns). It cannot generate older scroll intent, so fill it at rest,
    /// independently of the normal user-driven edge-paging policy.
    func scheduleUnderfilledHistoryCheck() {
        guard !isDeallocating, !underfilledHistory.scheduled else { return }
        underfilledHistory.scheduled = true
        let epoch = presentationEpoch
        DispatchQueue.main.async { [weak self] in
            guard let self, epoch == self.presentationEpoch else { return }
            self.underfilledHistory.scheduled = false
            guard !self.isDeallocating,
                  !self.snapshotApplyActive,
                  self.alphaValue > 0,
                  self.contentView.bounds.width > 1,
                  self.contentView.bounds.height > 1,
                  self.diagnosticWindowTop > 1,
                  !self.diagnosticAtOldest,
                  !self.loadingOlder, !self.loadingNewer,
                  !self.navigationLoadInFlight,
                  !self.hasPendingLatestStartJump,
                  !self.scrollPolicy.navigationActive,
                  !self.isScrollInteractionActive,
                  !self.isResizingControls, self.window?.inLiveResize != true,
                  !self.isProgrammaticScrollActive,
                  self.chatDocumentView.contents.isEmpty || self.chatDocumentView.isFullWindowGeometryReady,
                  self.underfilledHistory.pagesRequested < 8,
                  self.underfilledHistory.requestedTop != self.diagnosticWindowTop,
                  let loadOlder = self.onScrolledNearTop else { return }
            // Do not count bottom-alignment padding, edge spinners, or composer
            // clearance as rendered history. Wait for exact row heights above.
            let frames = self.chatDocumentView.itemFrames
            let renderedHeight = (frames.last?.maxY ?? 0) - (frames.first?.minY ?? 0)
            let availableHeight = self.contentView.bounds.height - self.topContentInset
                - self.chatDocumentView.bottomSafeArea
            guard renderedHeight < availableHeight - 1 else { return }
            // Consume before dispatch: SwiftUI/provider loading flags can lag
            // one turn. A no-progress request must not spin on the same edge.
            self.underfilledHistory.requestedTop = self.diagnosticWindowTop
            self.underfilledHistory.pagesRequested += 1
            loadOlder()
        }
    }
}
