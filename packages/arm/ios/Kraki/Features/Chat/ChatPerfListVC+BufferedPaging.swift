/// Newer and older pagination engines: fetching and applying pages with buffered coalescing.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    // MARK: Newer pagination — SYMMETRIC mirror of the older buffered engine
    //
    // Exact sign-flip of the older path (fetchOlder/prefetch/maybeFlush/flush):
    // approach the BOTTOM → prefetch newer pages into a buffer → reveal the
    // whole buffer in ONE coalesced batch via `applyWhenStable`. Going newer the
    // costly above-viewport op is the FRONT-TRIM (maxWindow slides the top out),
    // but `applyEdges`'s geometry anchor pins it jump-free exactly like the
    // older prepend — so DOWN now feels identical to UP (validated in the test
    // page). Data source: `vm.pageNewerRaw()` (sync DB read) + `refreshSpineSnapshot()`.

    /// Newer turns grouped into the model but not yet revealed in `items`.
    func bufferedNewerCount() -> Int {
        guard let e = reconcileEdges(old: items, new: ids) else { return messages.count }
        return e.insertBack
    }
    func bufferedNewerHeight() -> CGFloat {
        let n = bufferedNewerCount()
        guard n > 0 else { return 0 }
        let w = collectionView.bounds.width
        return messages.suffix(n).reduce(0) { total, message in
            total + (sizer.cached(message.id) ?? sizer.estimatedHeight(for: message, width: w))
        }
    }
    /// Distance from the viewport to the bottom of loaded content (px).
    func distanceToBottom() -> CGFloat {
        collectionView.contentSize.height + tailAdjustedInsets.bottom
            - collectionView.bounds.height - collectionView.contentOffset.y
    }

    /// Fire one page fetch into the newer buffer (serialized). On return it
    /// refreshes the snapshot, measures the buffered page off-frame, then re-evaluates flush +
    /// prefetch. Mirror of `fetchOlder`.
    func fetchNewer() {
        guard !fetchingNewer, !measuringNewerPage, !atNewest, !scrollingToTop else { return }
        fetchingNewer = true
        KLog.chat("📤 [page] fetch-newer session=\(sessionId.prefix(12)) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) distBottom=\(Int(distanceToBottom()))")
        let gen = pagingGeneration
        let txn = newTxn("newer")
        let winBefore = vm.windowBottomSeq
        // The bottom spinner is persistent while newer history remains
        // (auto-managed in applyEdges via showsNewerSpinner), so nothing to toggle.
        chatPerfLog.log("[txn \(txn.id) fetch] newer y=\(String(format: "%.0f", collectionView.contentOffset.y)) buf=\(bufferedNewerCount()) drag=\(yn(collectionView.isDragging)) decel=\(yn(collectionView.isDecelerating))")
        Task { @MainActor [weak self] in
            guard let self else { return }
            txn.mark()
            let moved = self.vm.pageNewerRaw()
            self.fetchingNewer = false
            // Stale across a re-anchor (jump-to-latest) → this page targeted the
            // old window; snapshot refresh/flushing it now would fight the fresh one.
            guard gen == self.pagingGeneration else {
                chatPerfLog.log("[txn \(txn.id)] STALE newer gen=\(gen) cur=\(self.pagingGeneration) — drop")
                return
            }
            chatPerfLog.log("[txn \(txn.id)] raw bot \(winBefore)→\(self.vm.windowBottomSeq) moved=\(self.yn(moved)) dt=\(self.f1(txn.lap()))")
            guard moved else {
                chatPerfLog.log("[txn \(txn.id)] END noop moved=false total=\(self.f1(txn.total()))")
                return
            }
            self.paginationSnapshotDeferred = true
            self.refreshSpineSnapshot()
            let n = self.bufferedNewerCount()
            if self.items == self.ids { self.paginationSnapshotDeferred = false }
            chatPerfLog.log("[txn \(txn.id)] group buf=\(n) dt=\(self.f1(txn.lap()))")
            self.resumeBufferedPageMeasurements()
        }
    }

    /// Top up the newer buffer while approaching the bottom, until it can clear
    /// the band. Mirror of `prefetchOlderIfNeeded`.
    func prefetchNewerIfNeeded() {
        guard viewIfLoaded?.window != nil,
              pendingApply == nil,
              bufferedNewerHeight() < olderBufferTargetHeight else { return }
        let isLoading = fetchingNewer || measuringNewerPage
        guard scrollPolicy.shouldRequestNewerPage(
            distanceToNewerEdge: distanceToBottom(),
            hasNewer: !atNewest,
            isLoading: isLoading,
            externallySuppressed: scrollingToTop
        ) else { return }
        fetchNewer()
    }

    /// Reveal the buffered newer pages in ONE batch update when due. Mirror of
    /// `maybeFlushOlder` (near the BOTTOM instead of the top).
    func maybeFlushNewer(reason: String) {
        guard !suppressPagingForBottom else { return }
        guard pendingApply == nil, !measuringNewerPage else { return }
        let n = bufferedNewerCount()
        guard n > 0, !scrollingToTop else { return }
        let atRest = !collectionView.isDragging && !collectionView.isDecelerating
        let nearBottom = distanceToBottom() < pageTriggerHeadroom
        let deepEnough = bufferedNewerHeight() >= olderBufferTargetHeight
        let cap = n >= 120
        guard (nearBottom && (deepEnough || atNewest))
                || (atRest && nearBottom)
                || cap else { return }
        flushNewer(reason: reason)
    }

    /// Reveal the buffered newer turns into `items` in one anchored batch update
    /// (deferred to rest by `applyWhenStable`). The far-edge front-trim is
    /// pinned jump-free by the geometry anchor in `applyEdges`; the bottom
    /// spinner is auto-managed there (`showsNewerSpinner`). Mirror of `flushOlder`.
    func flushNewer(reason: String) {
        let old = items
        let new = ids
        guard let e = reconcileEdges(old: old, new: new) else {
            chatPerfLog.log("[flush \(reason)] NO-COMMON reload old=\(old.count) new=\(new.count)")
            loadingNewer = showsNewerSpinner
            items = new
            paginationSnapshotDeferred = false
            collectionView.reloadData()
            warmWindow()
            return
        }
        guard e.insertFront > 0 || e.deleteFront > 0 || e.insertBack > 0 || e.deleteBack > 0 else { return }
        let survOld = Array(old[e.deleteFront ..< (old.count - e.deleteBack)])
        let survNew = Array(new[e.insertFront ..< (new.count - e.insertBack)])
        guard survOld == survNew else {
            let mm = firstMismatch(survOld, survNew)
            chatPerfLog.log("[flush \(reason)] midInvalid mismatch=\(mm.idx) → reload")
            loadingNewer = showsNewerSpinner
            items = new
            paginationSnapshotDeferred = false
            collectionView.reloadData()
            warmWindow()
            return
        }
        chatPerfLog.log("[flush \(reason)] iF=\(e.insertFront) dF=\(e.deleteFront) iB=\(e.insertBack) dB=\(e.deleteBack)")
        applyWhenStable {
            self.applyEdges(reason: "loadNewer",
                            insertFront: e.insertFront, deleteFront: e.deleteFront,
                            insertBack: e.insertBack, deleteBack: e.deleteBack)
        }
    }

    // MARK: Older pagination — decoupled fetch / apply (buffered coalescing)
    //
    // Copied 1:1 (in structure) from the validated ScrollPerfTest engine; only
    // the DATA SOURCE is swapped:
    //   • test page  `provider.loadOlder()` (sync slide of a mock window)
    //   • production `await vm.pageOlderRaw()` + `refreshSpineSnapshot()` (off-main DB page,
    //                then re-group the raw window into turns).
    // The buffer = the grouped model (`turns`) advanced past the applied cells
    // (`items`). Boundary-merge safe: its depth is the new-front count from
    // `reconcileEdges(old: items, new: ids)` (the oldest applied turn may merge
    // into a new id when older history arrives), NOT raw seq arithmetic.
    //
    // Why this cannot run away (the 370-fetch/3-apply bug): DB fetches are
    // serialized, and each 10-row page extends one shared buffer. Short rows may
    // require a few compact pages, but prefetch stops as soon as buffered height
    // reaches `olderBufferTargetHeight`; a reveal then drains the whole buffer in
    // one apply instead of fetching once per scroll frame.

    /// Older turns grouped into the model but not yet revealed in `items`.
    func bufferedOlderCount() -> Int {
        guard let e = reconcileEdges(old: items, new: ids) else { return messages.count }
        return e.insertFront
    }
    func bufferedOlderHeight() -> CGFloat {
        let n = bufferedOlderCount()
        guard n > 0 else { return 0 }
        let w = collectionView.bounds.width
        return messages.prefix(n).reduce(0) { total, message in
            total + (sizer.cached(message.id) ?? sizer.estimatedHeight(for: message, width: w))
        }
    }
    /// Keep filling the buffer until it can cover this much content above the
    /// viewport — enough to clear the trigger band in one reveal (+ margin).
    var olderBufferTargetHeight: CGFloat { pageTriggerHeadroom + 600 }
    /// Fire one page fetch into the buffer (serialized). On return it refreshes the snapshot
    /// (advances the model), measures the buffered page off-frame, then
    /// re-evaluates flush + prefetch.
    func fetchOlder() {
        guard !fetchingOlder, !measuringOlderPage, !vm.isLoadingOlder,
              !atOldest, !scrollingToTop else { return }
        fetchingOlder = true
        KLog.chat("📤 [page] fetch-older session=\(sessionId.prefix(12)) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) off=\(Int(collectionView.contentOffset.y))")
        let gen = pagingGeneration
        let txn = newTxn("older")
        let winBefore = vm.windowTopSeq
        // The top spinner is persistent while older history remains (set in
        // applyInitial, removed only at the true oldest), so nothing to toggle.
        chatPerfLog.log("[txn \(txn.id) fetch] older y=\(String(format: "%.0f", collectionView.contentOffset.y)) buf=\(bufferedOlderCount()) drag=\(yn(collectionView.isDragging)) decel=\(yn(collectionView.isDecelerating))")
        Task { @MainActor [weak self] in
            guard let self else { return }
            txn.mark()
            let moved = await self.vm.pageOlderRaw()
            self.fetchingOlder = false
            // Stale across a re-anchor (jump-to-latest) → this page targeted the
            // old window; snapshot refresh/flushing it now would slide the freshly
            // pinned window off the tail. (The provider's DB read already
            // re-validates topSeq, so the store isn't mutated across a reset —
            // this just skips the now-meaningless grouping/flush.)
            guard gen == self.pagingGeneration else {
                chatPerfLog.log("[txn \(txn.id)] STALE older gen=\(gen) cur=\(self.pagingGeneration) — drop")
                return
            }
            chatPerfLog.log("[txn \(txn.id)] raw top \(winBefore)→\(self.vm.windowTopSeq) moved=\(self.yn(moved)) dt=\(self.f1(txn.lap()))")
            guard moved else {
                chatPerfLog.log("[txn \(txn.id)] END noop moved=false total=\(self.f1(txn.total()))")
                return
            }
            // Advance the grouped model — the buffer grows. (The test page's
            // `provider.loadOlder()` is the analog; snapshot refresh is the cost the mock
            // window doesn't have, kept here off the REVEAL.)
            self.paginationSnapshotDeferred = true
            self.refreshSpineSnapshot()
            let n = self.bufferedOlderCount()
            if self.items == self.ids { self.paginationSnapshotDeferred = false }
            chatPerfLog.log("[txn \(txn.id)] group buf=\(n) dt=\(self.f1(txn.lap()))")
            // Warm the buffered turns off-frame; only THEN are their heights
            // known, so flush/prefetch decisions read a hot cache.
            self.resumeBufferedPageMeasurements()
        }
    }

    /// Page measurement is paused during a gesture so it never competes with
    /// scroll frames. When the reader is already at the loaded top waiting for
    /// the next page, keep measuring it (budgeted per frame) so continuous
    /// scrolling keeps revealing history instead of stalling until lift-off.
    func resumePageMeasurementAtOlderEdgeIfWaiting() {
        guard measuringOlderPage, pager.pendingCount > 0 else { return }
        let distanceToOlderEdge = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        guard distanceToOlderEdge < collectionView.bounds.height else { return }
        pager.resume()
    }

    /// Top up the buffer while approaching the top, until it can clear the band.
    func prefetchOlderIfNeeded() {
        guard viewIfLoaded?.window != nil,
              pendingApply == nil,
              bufferedOlderHeight() < olderBufferTargetHeight else { return }
        let isLoading = fetchingOlder || measuringOlderPage || vm.isLoadingOlder
        let distanceToOlderEdge = max(
            0,
            collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        )
        guard scrollPolicy.shouldRequestOlderPage(
            distanceToOlderEdge: distanceToOlderEdge,
            viewportLength: collectionView.bounds.height,
            hasOlder: !atOldest,
            isLoading: isLoading,
            externallySuppressed: scrollingToTop
        ) else { return }
        fetchOlder()
    }

    /// Reveal the buffered pages in ONE batch update when it's due. The key to
    /// coalescing: do NOT flush a shallow buffer just because we reached the
    /// trigger line — hold until the buffer is deep enough to clear the band in
    /// one shot (or we've stopped / hit the true oldest). While holding near the
    /// top the loaded content still fills the viewport, so we WAIT for enough
    /// older rows to arrive instead of washboarding one tiny page per frame.
    func maybeFlushOlder(reason: String) {
        guard !suppressPagingForBottom else { return }
        guard pendingApply == nil, !measuringOlderPage else { return }
        let n = bufferedOlderCount()
        guard n > 0, !scrollingToTop else { return }
        let y = collectionView.contentOffset.y
        let atRest = !collectionView.isDragging && !collectionView.isDecelerating
        let nearTop = y < pageTriggerHeadroom
        let deepEnough = bufferedOlderHeight() >= olderBufferTargetHeight
        let cap = n >= 120                            // hard memory bound
        guard (nearTop && (deepEnough || atOldest))
                || (atRest && nearTop)
                || cap else { return }
        flushOlder(reason: reason)
    }

    /// Arbitrary (non-edge) model change applied as one batch update that keeps
    /// the row being read at the same screen position. The landing offset is
    /// computed before the batch from the same heights `sizeForItemAt` uses
    /// and handed to the layout, so UIKit builds cells for the final viewport.
    func applyAnchoredDiff(old: [String], new: [String]) -> Bool {
        guard collectionView.window != nil, !old.isEmpty, !new.isEmpty else { return false }
        let newSet = Set(new)
        let visible = collectionView.indexPathsForVisibleItems.sorted()
        guard let anchorPath = visible.first(where: {
                  $0.item < old.count && old[$0.item] != Self.liveCardID && newSet.contains(old[$0.item])
              }),
              let anchorFrame = collectionView.layoutAttributesForItem(at: anchorPath)?.frame,
              let newAnchorIndex = new.firstIndex(of: old[anchorPath.item]) else { return false }
        let width = collectionView.bounds.width
        sizer.prepare(width: width)
        func height(_ id: String) -> CGFloat {
            if id == Self.liveCardID, let card = vm.card { return liveContent(card).cellHeight(cellWidth: width) }
            guard let message = message(id) else { return 44 }
            return sizer.cached(message.id) ?? sizer.height(for: message, width: width)
        }
        let showOlderSpinner = !atOldest
        let newHeader: CGFloat = showOlderSpinner ? spinnerRowHeight : 0
        let newAnchorY = newHeader + new[..<newAnchorIndex].reduce(CGFloat(0)) { $0 + height($1) }
        let delta = newAnchorY - anchorFrame.minY
        let diff = new.difference(from: old)
        var removals: [IndexPath] = [], insertions: [IndexPath] = []
        for change in diff {
            switch change {
            case .remove(let offset, _, _): removals.append(IndexPath(item: offset, section: 0))
            case .insert(let offset, _, _): insertions.append(IndexPath(item: offset, section: 0))
            }
        }
        let offsetBefore = collectionView.contentOffset.y
        let chatLayout = collectionView.collectionViewLayout as? ChatFlowLayout
        UIView.performWithoutAnimation {
            collectionView.layoutIfNeeded()
            if loadingOlder != showOlderSpinner {
                loadingOlder = showOlderSpinner
                let ctx = UICollectionViewFlowLayoutInvalidationContext()
                ctx.invalidateFlowLayoutDelegateMetrics = true
                collectionView.collectionViewLayout.invalidateLayout(with: ctx)
            }
            chatLayout?.pendingUpdateOffsetY = offsetBefore + delta
            collectionView.performBatchUpdates {
                self.items = new
                self.paginationSnapshotDeferred = false
                collectionView.deleteItems(at: removals)
                collectionView.insertItems(at: insertions)
            }
            chatLayout?.pendingUpdateOffsetY = nil
            let drift = collectionView.contentOffset.y - offsetBefore
            applyFrontShift(delta - drift, gestureDelta: delta)
        }
        warmWindow()
        return true
    }

    /// Reveal the buffered older turns into `items` in one anchored batch update
    /// (deferred to rest by `applyWhenStable`, like the test page). The exact
    /// edge edits come from `reconcileEdges` so the boundary-merge case is
    /// handled; the persistent top spinner is auto-managed inside `applyEdges`.
    func flushOlder(reason: String) {
        let old = items
        let new = ids
        guard let e = reconcileEdges(old: old, new: new) else {
            // No common turn (buffer too deep / full replace) → safe reload.
            // deepEnough-hold keeps the buffer shallow, so this is a last resort.
            chatPerfLog.log("[flush \(reason)] NO-COMMON reload old=\(old.count) new=\(new.count)")
            loadingOlder = !atOldest
            items = new
            paginationSnapshotDeferred = false
            collectionView.reloadData()
            warmWindow()
            return
        }
        guard e.insertFront > 0 || e.deleteFront > 0 || e.insertBack > 0 || e.deleteBack > 0 else { return }
        let survOld = Array(old[e.deleteFront ..< (old.count - e.deleteBack)])
        let survNew = Array(new[e.insertFront ..< (new.count - e.insertBack)])
        guard survOld == survNew else {
            let mm = firstMismatch(survOld, survNew)
            chatPerfLog.log("[flush \(reason)] midInvalid mismatch=\(mm.idx) → anchored diff")
            // Typical cause: the window trimmed its newest rows while the live
            // card stays last, so the deletion is not at an edge. A plain
            // reload here lost the reading position (a whole page jump).
            if applyAnchoredDiff(old: old, new: new) { return }
            loadingOlder = !atOldest
            items = new
            paginationSnapshotDeferred = false
            collectionView.reloadData()
            warmWindow()
            return
        }
        chatPerfLog.log("[flush \(reason)] iF=\(e.insertFront) dF=\(e.deleteFront) iB=\(e.insertBack) dB=\(e.deleteBack)")
        applyWhenStable {
            // The top spinner is auto-managed inside applyEdges from !atOldest:
            // it stays put across normal reveals and collapses itself the
            // instant this reveal brings in the true oldest.
            self.applyEdges(reason: "loadOlder",
                            insertFront: e.insertFront, deleteFront: e.deleteFront,
                            insertBack: e.insertBack, deleteBack: e.deleteBack)
        }
    }
}
#endif
