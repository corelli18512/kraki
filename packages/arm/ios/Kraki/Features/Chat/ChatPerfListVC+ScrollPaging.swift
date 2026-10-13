/// Scroll-driven pagination: when scrolling near an edge loads older or newer history.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    // MARK: Scroll-driven pagination

    func noteUserScrollOffset(_ offsetY: CGFloat) {
        scrollPolicy.observeUserOffset(
            offsetY,
            distanceToBottom: distanceToBottom()
        )
    }

    /// Drive both edges from one place: prefetch + flush whichever edge the
    /// viewport is approaching. Mirror-symmetric — older (top) and newer
    /// (bottom) run the identical buffered/coalesced path, opposite sign.
    func driveEdges() {
        guard allowsEdgePaging, !scrollingToTop else { return }
        updateJumpButtonVisibility()
        guard !suppressPagingForBottom else { return }
        if !atOldest {
            prefetchOlderIfNeeded()
            resumePageMeasurementAtOlderEdgeIfWaiting()
            maybeFlushOlder(reason: "scroll")
        }
        if !atNewest {
            prefetchNewerIfNeeded()
            maybeFlushNewer(reason: "scroll")
        }
    }

    /// At rest: flush whatever each edge has buffered (jump-free now) and keep
    /// the approaching buffer topped up. Mirror-symmetric over both edges.
    func settleEdges() {
        maybeFlushOlder(reason: "settle")
        prefetchOlderIfNeeded()
        maybeFlushNewer(reason: "settle")
        prefetchNewerIfNeeded()
        updateJumpButtonVisibility()
    }

    #if DEBUG
    var automationPolicy: ChatScrollPolicy { scrollPolicy }

    /// Read-only barrier for geometry tests: initial offscreen height upgrades
    /// legitimately change contentSize/offset while preserving screen anchors.
    /// Wait for them before attributing any later geometry change to a composer.
    var automationHeightMeasurementsSettled: Bool {
        !items.isEmpty && warmKickWork == nil && warmer.pendingCount == 0
            && !heightRefreshScheduled && pendingHeightRefreshIDs.isEmpty
            && items.allSatisfy { $0 == Self.liveCardID || (sizer.cached($0) != nil && appliedHeightIDs.contains($0)) }
    }

    func automationMarkUserScrolledAway() {
        scrollPolicy.beginUserInteraction(
            offset: collectionView?.contentOffset.y ?? 0,
            distanceToBottom: distanceToBottom()
        )
        scrollPolicy.recordUserIntent(
            .older,
            offset: collectionView?.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
    }

    func automationMarkUserScrollingTowardNewer() {
        scrollPolicy.beginUserInteraction(
            offset: collectionView?.contentOffset.y ?? 0,
            distanceToBottom: distanceToBottom()
        )
        scrollPolicy.recordUserIntent(
            .newer,
            offset: collectionView?.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
    }

    var automationPaginationState: (measuring: Bool, jobs: Int, deferred: Bool) {
        (measuringOlderPage || measuringNewerPage, pager.pendingCount,
         paginationSnapshotDeferred || pendingApply != nil)
    }

    /// Stage an already-measured buffered row using the real collection model.
    /// Lifecycle recovery must reveal it even though no measurement is needed.
    func automationStageWarmBufferedOlderPage(pending: Bool) {
        guard let first = messages.first, messages.count > 1 else { return }
        pager.cancelAll()
        measuringOlderPage = false
        measuringNewerPage = false
        sizer.prime(first, width: collectionView.bounds.width, notify: false)
        items = Array(ids.dropFirst())
        paginationSnapshotDeferred = true
        collectionView.delegate = nil
        collectionView.reloadData()
        collectionView.setContentOffset(
            CGPoint(x: 0, y: -collectionView.adjustedContentInset.top), animated: false
        )
        collectionView.layoutIfNeeded()
        collectionView.delegate = self
        pendingApply = pending ? { [weak self] in self?.flushOlder(reason: "warm-resume-probe") } : nil
    }

    /// Reproduces the build-24 crash state without synthetic scroll machinery:
    /// a pending stable apply, one active edge measurement, and an already-warm
    /// opposite buffer. The old implementation synchronously re-entered
    /// flush → resume → measurePage → finish until stack overflow.
    func automationProbeCrossEdgeMeasurementBarrier(olderActive: Bool = false)
        -> (waitedForActiveEdge: Bool, appliedExactlyOnce: Bool) {
        guard let warmRow = olderActive ? messages.last : messages.first,
              messages.count > 1,
              collectionView.bounds.width > 0 else { return (false, false) }

        sizer.prime(warmRow, width: collectionView.bounds.width, notify: false)
        let savedItems = items
        let savedPendingApply = pendingApply
        let savedMeasuringOlderPage = measuringOlderPage
        let savedMeasuringNewerPage = measuringNewerPage
        let savedPaginationSnapshotDeferred = paginationSnapshotDeferred
        defer {
            items = savedItems
            pendingApply = savedPendingApply
            measuringOlderPage = savedMeasuringOlderPage
            measuringNewerPage = savedMeasuringNewerPage
            paginationSnapshotDeferred = savedPaginationSnapshotDeferred
        }

        // Expose one warm older row without mutating the backing message
        // snapshot or UICollectionView. The probe ends before another layout.
        items = olderActive ? Array(ids.dropLast()) : Array(ids.dropFirst())
        var applyCount = 0
        pendingApply = { applyCount += 1 }
        measuringOlderPage = olderActive
        measuringNewerPage = !olderActive

        flushPendingApply()
        let waited = applyCount == 0
            && pendingApply != nil
            && (olderActive ? !measuringNewerPage : !measuringOlderPage)

        measuringOlderPage = false
        measuringNewerPage = false
        flushPendingApply()
        let applied = applyCount == 1 && pendingApply == nil
        return (waited, applied)
    }
    #endif

    /// Check both buffered edges before applying. Cold pages are measured by
    /// the pager at rest; ready pages settle without installing a new barrier.
    func bufferedOlderNeedsMeasurement() -> Bool {
        let count = bufferedOlderCount()
        guard count > 0 else { return false }
        return messages.prefix(count).contains { sizer.cached($0.id) == nil }
    }

    func bufferedNewerNeedsMeasurement() -> Bool {
        let count = bufferedNewerCount()
        guard count > 0 else { return false }
        return messages.suffix(count).contains { sizer.cached($0.id) == nil }
    }

    func cancelPageMeasurements() {
        pager.cancelAll()
        measuringOlderPage = false
        measuringNewerPage = false
    }

    func finishPageMeasurement(older: Bool) {
        if older { measuringOlderPage = false } else { measuringNewerPage = false }
        // The buffer/width can change while jobs run. Re-evaluate both edges;
        // an active opposite edge still owns its completion barrier.
        resumeBufferedPageMeasurements()
    }

    func resumeBufferedPageMeasurements() {
        guard !isLeavingView, viewIfLoaded?.window != nil,
              collectionView.bounds.width > 0 else { return }
        sizer.prepare(width: collectionView.bounds.width)
        let older = bufferedOlderCount()
        if older > 0, !measuringOlderPage, bufferedOlderNeedsMeasurement() {
            paginationSnapshotDeferred = true
            measuringOlderPage = true
            if !measurePage(messages.prefix(older), then: { [weak self] in
                self?.finishPageMeasurement(older: true)
            }) { measuringOlderPage = false }
        }
        let newer = bufferedNewerCount()
        if newer > 0, !measuringNewerPage, bufferedNewerNeedsMeasurement() {
            paginationSnapshotDeferred = true
            measuringNewerPage = true
            if !measurePage(messages.suffix(newer), then: { [weak self] in
                self?.finishPageMeasurement(older: false)
            }) { measuringNewerPage = false }
        }

        // Readiness and measurement are separate phases. Warm pages (including
        // a cancelled final barrier on navigation) still need to settle, but
        // must not create another synchronous measure -> finish -> flush loop.
        guard !measuringOlderPage, !measuringNewerPage,
              !bufferedOlderNeedsMeasurement(), !bufferedNewerNeedsMeasurement() else { return }
        if pendingApply != nil {
            flushPendingApply()
        } else if paginationSnapshotDeferred || older > 0 || newer > 0 {
            settleEdges()
        }
        if items == ids { paginationSnapshotDeferred = false }
    }

    /// Returns false if no barrier can be owned yet (hidden or zero width).
    func measurePage(_ page: ArraySlice<ChatMessage>, then apply: @escaping () -> Void) -> Bool {
        guard !isLeavingView, viewIfLoaded?.window != nil else { return false }
        let width = collectionView.bounds.width
        guard width > 0 else { return false }
        var jobs: [() -> Void] = []
        for t in page where sizer.cached(t.id) == nil {
            jobs.append { [weak self] in self?.sizer.prime(t, width: width) }
        }
        if jobs.isEmpty { apply(); return true }
        chatPerfLog.log("[page] measure n=\(jobs.count)")
        jobs.append(apply)
        pager.enqueue(jobs)
        return true
    }

    /// Reconcile two window snapshots (old → new) into edge edits by diffing
    /// `ChatMessage.id`. Robust to the BOUNDARY-MERGE case: when older history is
    /// paged in, the window's top turn (often a half-captured block) refreshes the snapshot
    /// into a NEW combined turn with a different id — so an exact "is old-first
    /// still present?" check fails. Instead we anchor on the contiguous COMMON
    /// MIDDLE (turns present in both, unchanged by paging) and express the
    /// boundary reshape as delete-old-edge + insert-new-edge at each end:
    ///   • insertFront = new turns before the first common id
    ///   • deleteFront = old turns before the first common id (merged-away)
    ///   • insertBack  = new turns after the last common id
    ///   • deleteBack  = old turns after the last common id (trimmed/merged)
    /// Returns nil only when the two snapshots share NO turn at all (→ caller
    /// does a full reload rather than risk a bad batch update).
    func reconcileEdges(old: [String], new: [String])
        -> (insertFront: Int, deleteFront: Int, insertBack: Int, deleteBack: Int)? {
        if old.isEmpty { return (new.count, 0, 0, 0) }
        if new.isEmpty { return (0, old.count, 0, 0) }
        let newSet = Set(new)
        let oldSet = Set(old)
        guard let firstCommonOldIdx = old.firstIndex(where: { newSet.contains($0) }),
              let firstCommonNewIdx = new.firstIndex(of: old[firstCommonOldIdx]),
              let lastCommonNewIdx = new.lastIndex(where: { oldSet.contains($0) }),
              let lastCommonOldIdx = old.lastIndex(of: new[lastCommonNewIdx])
        else { return nil }
        let insertFront = firstCommonNewIdx
        let deleteFront = firstCommonOldIdx
        let insertBack = new.count - 1 - lastCommonNewIdx
        let deleteBack = old.count - 1 - lastCommonOldIdx
        return (insertFront, deleteFront, insertBack, deleteBack)
    }
}
#endif
