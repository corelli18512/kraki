#if os(iOS)
import UIKit

/// Per-entry automatic budget, separate from user-driven edge paging (Mac parity).
struct IOSUnderfilledHistoryState {
    var scheduled = false
    var pagesRequested = 0
    var requestedTop: Int?
    var followsTail = false
}

extension ChatPerfListVC {
    func takeUnderfilledTailFollow() -> Bool {
        defer { underfilledHistory.followsTail = false }
        return underfilledHistory.followsTail
    }

    /// A compact raw window can project to less than one screen, even no rows.
    /// Fill at rest without manufacturing scroll intent or measuring on a drag.
    func scheduleUnderfilledHistoryCheck() {
        guard !isLeavingView, !underfilledHistory.scheduled else { return }
        underfilledHistory.scheduled = true
        let generation = pagingGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.underfilledHistory.scheduled = false
            guard generation == self.pagingGeneration,
                  !self.isLeavingView, self.viewIfLoaded?.window != nil,
                  !self.view.isHidden, self.view.alpha > 0,
                  self.didInitialScroll, self.collectionView.bounds.width > 1,
                  self.collectionView.bounds.height > 1,
                  self.vm.windowTopSeq > 1, !self.atOldest,
                  !self.fetchingOlder, !self.fetchingNewer, !self.vm.isLoadingOlder, !self.vm.isFillingTail,
                  !self.measuringOlderPage, !self.measuringNewerPage,
                  !self.paginationSnapshotDeferred, self.pendingApply == nil,
                  !self.navigationLoadInFlight, !self.scrollPolicy.navigationActive,
                  !self.scrollPolicy.interactionActive,
                  !self.collectionView.isTracking, !self.collectionView.isDragging,
                  !self.collectionView.isDecelerating, !self.scrollingToTop,
                  !self.widthRelayoutScheduled,
                  !self.heightRefreshScheduled, self.pendingHeightRefreshIDs.isEmpty,
                  self.items == self.ids,
                  self.underfilledHistory.pagesRequested < 8,
                  self.underfilledHistory.requestedTop != self.vm.windowTopSeq else { return }
            // Wait for applied exact heights; estimates may misclassify a tail.
            guard self.items.allSatisfy({ id in
                id == Self.liveCardID || (self.sizer.cached(id) != nil && self.appliedHeightIDs.contains(id))
            }) else { return }
            self.collectionView.layoutIfNeeded()
            let edgeRows = self.items.isEmpty ? [] : [0, self.items.count - 1]
            let frames = edgeRows.compactMap {
                self.collectionView.layoutAttributesForItem(at: IndexPath(item: $0, section: 0))?.frame
            }
            // A row mid-update (the live card during a relayout) can report a
            // zero frame; that is not geometry, and read as underfilled history.
            guard frames.count == edgeRows.count, frames.allSatisfy({ $0.height > 0 }) else { return }
            let renderedHeight = (frames.last?.maxY ?? 0) - (frames.first?.minY ?? 0)
            // Spinners, safe area and composer overlay are not rendered history.
            let availableHeight = self.collectionView.bounds.height
                - self.collectionView.adjustedContentInset.top - self.tailAdjustedInsets.bottom
            guard renderedHeight < availableHeight - 1 else { return }
            // Consume first: provider loading flags can lag, and a no-progress
            // edge must not spin. Reuse UIKit's fetch/measure/anchored-apply path.
            self.underfilledHistory.requestedTop = self.vm.windowTopSeq
            self.underfilledHistory.pagesRequested += 1
            self.underfilledHistory.followsTail = self.followingBottom
            self.fetchOlder()
        }
    }
}
#endif
