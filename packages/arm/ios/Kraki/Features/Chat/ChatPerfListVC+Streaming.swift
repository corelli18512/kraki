/// Streaming render pacing: how a live reply's growth reaches the screen.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    /// Coalesce streaming revisions into at most one render per display frame,
    /// and back off adaptively when a render is expensive (very long answers,
    /// slow devices) or while the user is scrolling, so scroll frames keep
    /// priority. Data reception is never paused; only presentation is paced.
    func scheduleLiveRender() {
        guard !liveRenderScheduled else { return }
        let now = CACurrentMediaTime()
        let interacting = collectionView.isDragging || collectionView.isDecelerating
        let floor: CFTimeInterval = interacting ? 1.0 / 30.0 : 1.0 / 60.0
        let interval = max(floor, min(0.15, lastLiveRenderCost * 3))
        let wait = max(0, lastLiveRenderAt + interval - now)
        liveRenderScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            self?.performLiveRender()
        }
    }

    func performLiveRender() {
        liveRenderScheduled = false
        guard !isLeavingView, collectionView != nil,
              let index = items.firstIndex(of: Self.liveCardID),
              vm.card != nil else { return }
        let started = CACurrentMediaTime()
        refreshVisibleLiveCard(at: index, duringPaging: false)
        if followingBottom, !items.isEmpty {
            pinToBottom(reason: "live-tail", animated: false)
        }
        updateJumpButtonVisibility()
        let finished = CACurrentMediaTime()
        lastLiveRenderCost = finished - started
        lastLiveRenderAt = finished
    }

    #if DEBUG
    var automationLastLiveRenderCostMs: Double { lastLiveRenderCost * 1_000 }
    #endif

    /// Edge deltas describe the change only when everything between the edges
    /// survived unchanged. The window can trim its newest rows while the live
    /// card stays last, putting the deletion in the MIDDLE; a batch built from
    /// edge counts then disagrees with the data source and UIKit throws.
    func edgesKeepMiddle(_ e: (insertFront: Int, deleteFront: Int, insertBack: Int, deleteBack: Int),
                         old: [String], new: [String]) -> Bool {
        let oldMid = e.deleteFront ..< (old.count - e.deleteBack)
        let newMid = e.insertFront ..< (new.count - e.insertBack)
        guard oldMid.lowerBound <= oldMid.upperBound, newMid.lowerBound <= newMid.upperBound else { return false }
        return old[oldMid].elementsEqual(new[newMid])
    }

    /// A non-edge change: keep the reading position with the anchored diff, or
    /// reload as a last resort. Never an edge batch update.
    func applyMiddleChange(reason: String, new newIds: [String]) {
        chatPerfLog.log("[apply] \(reason) midInvalid → anchored diff")
        if applyAnchoredDiff(old: items, new: newIds) { return }
        reloadWholeWindow(newIds)
    }

    /// Replace the whole window without animation (loses the scroll anchor,
    /// never desyncs the collection view from `items`).
    func reloadWholeWindow(_ newIds: [String]) {
        UIView.performWithoutAnimation {
            loadingOlder = hasLoadedWindow && !atOldest
            loadingNewer = showsNewerSpinner
            items = newIds
            paginationSnapshotDeferred = false
            collectionView.reloadData()
            collectionView.layoutIfNeeded()
        }
        warmWindow()
    }

    func applyEdges(txn: PaginateTxn? = nil,
                            reason: String,
                            insertFront: Int = 0, deleteFront: Int = 0,
                            insertBack: Int = 0, deleteBack: Int = 0) {
        let t0 = CFAbsoluteTimeGetCurrent()
        let oldCount = items.count
        let newIds = ids

        // AUTHORITATIVE EDGES (race-proof): the `insert*/delete*` deltas handed
        // in were computed EARLIER — in the caller's reconcile, before an async
        // `measurePage` gap. During that gap the OTHER pagination direction's
        // `refreshSpineSnapshot()` can mutate `turns`/`ids`, so the passed deltas may no
        // longer describe the live `items → ids` transition. Applying a batch
        // update whose deltas disagree with `items.count` desyncs the collection
        // view from the data source → `cellForItemAt` indexes `items` out of
        // bounds → SIGTRAP. So we RE-DERIVE the edits here, atomically, against
        // the current arrays, and ignore the (logging-only) parameters.
        guard let e = reconcileEdges(old: items, new: newIds) else {
            // No common anchor (buffer too deep / full replace) → safe reload.
            // Loses the scroll anchor (rare), but never crashes. The deepEnough
            // buffer hold keeps this practically unreachable.
            chatPerfLog.log("[apply] \(reason) NO-COMMON reload old=\(oldCount) new=\(newIds.count)")
            reloadWholeWindow(newIds)
            return
        }
        // A middle deletion (window trim before the live card) cannot be an
        // edge batch update: UIKit would throw. See `applyMiddleChange`.
        if !edgesKeepMiddle(e, old: items, new: newIds) {
            applyMiddleChange(reason: reason, new: newIds)
            return
        }
        let iF = e.insertFront, dF = e.deleteFront, iB = e.insertBack, dB = e.deleteBack

        // FRONT-SHIFT via SIZER-SUM (faithful 1:1 port of the validated test-page
        // engine; replaces the geometry-anchor variant production had diverged
        // into). Sum the heights of everything ABOVE the anchor that this edit
        // changes — older turns prepended push content down (+), trimmed-front
        // turns pull it up (−) — plus the ±44pt top-spinner toggle, and apply it
        // as ONE atomic contentOffset shift right after the batch, with NO
        // intervening `layoutIfNeeded`.
        //
        // Why this kills the blank-cell flash: the anchor variant read the turn's
        // post-layout position to self-correct, which forced a `layoutIfNeeded`
        // at the STILL-UNSHIFTED offset; on a far-end trim while parked at the
        // bottom that layout saw the offset pointing past the now-shorter content
        // and requested beyond-count cells → the OOB guard flashed blank cells.
        // The sizer-sum is precomputed and never touches a stale-offset layout,
        // so the artefact cannot occur — exactly why the test page never showed
        // it. Render units are identical to the test page (same grouper + same
        // block→[opener,block] split), so the sum is computed over the SAME turn
        // cells. Boundary reshape stays exact because reconcileEdges encodes it as
        // deleteFront(old id) + insertFront(new id): the old height leaves the sum
        // (cached) and the new height enters it (fresh measure), and the SAME
        // RealCellSizer feeds both this sum and the layout.
        let measureWidth = collectionView.bounds.width
        var frontDelta: CGFloat = 0
        for id in newIds.prefix(iF) {           // older turns prepended → push down (+)
            if let message = message(id) { frontDelta += sizer.height(for: message, width: measureWidth) }
            else if let c = sizer.cached(id) { frontDelta += c }
        }
        for id in items.prefix(dF) {            // front turns trimmed → pull up (−); `items` still OLD
            frontDelta -= sizer.cached(id) ?? 0
        }
        // Auto-manage the PERSISTENT edge spinners. The top "loading earlier"
        // header lives ABOVE the anchor, so fold its ±44pt show/hide into this
        // same front shift; the bottom "loading newer" footer sits BELOW the
        // viewport, so toggling it costs no shift (the free side). Each appears
        // the instant we trim back into unloaded history on its side and
        // disappears the instant that side's true boundary lands.
        let showOlderSpinner = !atOldest
        let showNewerSpinner = showsNewerSpinner
        let olderSpinnerChanged = showOlderSpinner != loadingOlder
        let newerSpinnerChanged = showNewerSpinner != loadingNewer
        if olderSpinnerChanged {
            frontDelta += showOlderSpinner ? spinnerRowHeight : -spinnerRowHeight
        }

        paginationSnapshotDeferred = false
        let newCount = newIds.count
        // A batch can reveal buffered older rows AND append new ones (a message
        // sent while older history was waiting to be shown). The front shift
        // below keeps the reading position; if the reader was at the bottom,
        // the new rows must also be followed, or they land under the composer.
        // An automatic fill can prepend into a short, top-aligned window.
        // Preserve its tail latch atomically rather than leaving an overscroll.
        // Only the reveal held before this batch survives its tail pin.
        let newTailReveal: CGFloat? = (takeUnderfilledTailFollow() || iB > 0) && followingBottom
            && !collectionView.isDragging && !collectionView.isDecelerating ? revealedAboveTail() : nil

        UIView.performWithoutAnimation {
            // Settle pending layout (e.g. the scroll step that triggered this
            // flush) against the OLD model, and swap the model only inside the
            // batch: UIKit lays out once before applying updates, and doing that
            // with the new model put the inserted rows' content into cells of
            // the old index paths (a bubble showing another message, wrong
            // height) during continuous scrolling.
            collectionView.layoutIfNeeded()
            // Fold the spinner header/footer size change into the SAME layout pass
            // as the item edits, so there's no intermediate frame where the row is
            // gone/added but the offset hasn't caught up.
            if olderSpinnerChanged || newerSpinnerChanged {
                if olderSpinnerChanged { loadingOlder = showOlderSpinner }
                if newerSpinnerChanged { loadingNewer = showNewerSpinner }
                let ctx = UICollectionViewFlowLayoutInvalidationContext()
                ctx.invalidateFlowLayoutDelegateMetrics = true
                collectionView.collectionViewLayout.invalidateLayout(with: ctx)
            }
            let offsetBeforeBatch = collectionView.contentOffset.y
            // Tell UIKit where the batch must land. Otherwise FlowLayout picks
            // its own target offset mid-update (seen: +357pt), builds cells for
            // that viewport, then remaps them by the insertion delta, leaving a
            // cell showing another row's content (wrong bubble, wrong height).
            let chatLayout = collectionView.collectionViewLayout as? ChatFlowLayout
            if abs(frontDelta) > 0.5 {
                chatLayout?.pendingUpdateOffsetY = offsetBeforeBatch + frontDelta
            }
            defer { chatLayout?.pendingUpdateOffsetY = nil }
            collectionView.performBatchUpdates {
                self.items = newIds
                if dF > 0 {
                    collectionView.deleteItems(at: (0..<dF).map { IndexPath(item: $0, section: 0) })
                }
                if dB > 0 {
                    collectionView.deleteItems(at: ((oldCount - dB)..<oldCount).map { IndexPath(item: $0, section: 0) })
                }
                if iF > 0 {
                    collectionView.insertItems(at: (0..<iF).map { IndexPath(item: $0, section: 0) })
                }
                if iB > 0 {
                    collectionView.insertItems(at: ((newCount - iB)..<newCount).map { IndexPath(item: $0, section: 0) })
                }
            }
            // Re-pin the viewport against the now-updated content size and reset
            // any in-flight drag/bounce so it doesn't snap back. No layoutIfNeeded:
            // the shift is precomputed from the sizer, never read post-layout.
            // Normally UIKit already landed on the target above; this only
            // corrects any remaining difference (absolute, never additive).
            let uikitDrift = collectionView.contentOffset.y - offsetBeforeBatch
            applyFrontShift(frontDelta - uikitDrift, gestureDelta: frontDelta)
            if let newTailReveal { pinToBottom(reason: "edges-new-tail", revealCap: newTailReveal) }
        }

        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        let state = collectionView.isDragging ? "drag" : (collectionView.isDecelerating ? "decel" : "rest")
        let offNow = collectionView.contentOffset.y
        if let txn {
            // Final reconciliation: did the manual batch edits land the
            // collection view EXACTLY on the grouper truth?
            let match = (items == ids)
            let cv = collectionView.numberOfItems(inSection: 0)
            chatPerfLog.log("[txn \(txn.id)] apply count=\(self.messageCount) win=[\(self.vm.windowTopSeq),\(self.vm.windowBottomSeq)] frontDelta=\(String(format: "%.0f", frontDelta)) state=\(state) itemsMatchIds=\(yn(match)) cv=\(cv) dt=\(f1(ms))")
            chatPerfLog.log("[txn \(txn.id)] END total=\(f1(txn.total()))")
        } else {
            chatPerfLog.log("[apply] \(reason) count=\(self.messageCount) win=[\(self.vm.windowTopSeq),\(self.vm.windowBottomSeq)] ms=\(String(format: "%.1f", ms)) frontDelta=\(String(format: "%.0f", frontDelta)) state=\(state) offNow=\(String(format: "%.0f", offNow))")
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            chatPerfLog.log("[apply] \(reason) settled offY=\(String(format: "%.0f", self.collectionView.contentOffset.y))")
            // A live update may have been deferred while this pagination batch
            // was in flight. Re-run now that items/byId are settled so the
            // spine catches up to any card/message changes that arrived mid-page.
            self.syncLiveUpdates()
        }
        lastApplyMs = ms
        lastReason = reason
        updateOverlay()
        warmWindow()
        updateJumpButtonVisibility()
    }

    #if DEBUG
    var automationContentSizeMismatch: CGFloat {
        collectionView.contentSize.height - collectionView.collectionViewLayout.collectionViewContentSize.height
    }
    #endif

    func pinToBottom(reason: String, animated: Bool = false, revealCap: CGFloat = .greatestFiniteMagnitude) {
        guard collectionView.numberOfItems(inSection: 0) > 0 else { return }
        if !animated, landOnFirstUnreadIfNeeded(reason: reason) { return }
        isPinningBottom = true
        collectionView.layoutIfNeeded()
        let maxY = followPinOffset(keepingRevealed: reason != "explicit", revealCap: revealCap)
        lastPinnedViewportSize = collectionView.bounds.size
        lastPinnedAdjustedInsets = tailAdjustedInsets
        scrollPolicy.pinToTail(observedOffset: maxY)
        let targetText = String(format: "%.1f", maxY)
        let currentText = String(format: "%.1f", collectionView.contentOffset.y)
        let contentText = String(format: "%.1f", collectionView.contentSize.height)
        let viewportText = String(format: "%.1f", collectionView.bounds.height)
        let insetText = String(format: "%.1f", collectionView.adjustedContentInset.bottom)
        chatPerfLog.log("[bottom] pin reason=\(reason) target=\(targetText) current=\(currentText) content=\(contentText) viewport=\(viewportText) inset=\(insetText)")
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: maxY),
            animated: animated)
        isPinningBottom = false
    }

    func scrollToBottom(animated: Bool) {
        scrollPolicy.cancelUnreadEntry()
        pinToBottom(reason: "explicit", animated: animated)
    }

    /// Entered with new messages and the user hasn't scrolled: every entry pin
    /// asks whether the first new message's start would still be readable at
    /// the tail. Once it isn't (on entry, when a cold start's sync lands, or as
    /// a reply streams), that start is held at the top instead and the list
    /// stops following — the same landing ↑ uses (ChatScrollPolicy.UnreadEntry).
    func landOnFirstUnreadIfNeeded(reason: String) -> Bool {
        guard !items.isEmpty, collectionView.bounds.width > 0 else { return false }
        if scrollPolicy.unreadEntry == .anchored {
            // Held: an entry pin (layout, a near-tail re-pin, arrivals) keeps
            // the first new message where it is instead of going to the tail.
            guard let index = heldUnreadIndex() else { return false }
            collectionView.layoutIfNeeded()
            guard let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame
            else { return false }
            let landing = landingOffset(forRowStart: frame.minY)
            if landing >= maximumOffsetY() - 1, let boundary = unreadEntryBoundary {
                // Measured: it fits after all. Follow the tail again.
                scrollPolicy.releaseUnreadAnchor(boundary: boundary)
                unreadAnchorID = nil
                return false
            }
            if abs(collectionView.contentOffset.y - landing) > 0.5 {
                isPinningBottom = true
                collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: landing), animated: false)
                isPinningBottom = false
            }
            scrollPolicy.rememberOffset(landing)
            lastPinnedViewportSize = collectionView.bounds.size
            lastPinnedAdjustedInsets = tailAdjustedInsets
            return true
        }
        guard let boundary = scrollPolicy.unreadEntryBoundary else { return false }
        let rows = unreadEntryRows()
        guard let targetID = ChatScrollPolicy.firstUnreadRow(rows, after: boundary,
                                                              latestReplyFallback: latestReplyFallback),
              let index = items.firstIndex(of: targetID) else { return false }
        // Exact heights for the first new message and the screen below it, so
        // "does it fit" is decided on real geometry. Not inside a layout pass.
        if reason != "layout" {
            let width = collectionView.bounds.width
            sizer.prepare(width: width)
            var changed = false
            var covered: CGFloat = 0
            var i = index
            while i < items.count, covered < collectionView.bounds.height * 1.2 {
                if let row = message(items[i]) {
                    if sizer.cached(row.id) == nil {
                        sizer.prime(row, width: width, notify: false)
                        appliedHeightIDs.insert(row.id)
                        changed = true
                    }
                    covered += sizer.cached(row.id) ?? 0
                } else {
                    covered += 200
                }
                i += 1
            }
            if changed {
                let context = UICollectionViewFlowLayoutInvalidationContext()
                context.invalidateFlowLayoutDelegateMetrics = true
                context.invalidateFlowLayoutAttributes = true
                collectionView.collectionViewLayout.invalidateLayout(with: context)
            }
        }
        collectionView.layoutIfNeeded()
        guard let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame,
              let landing = ChatScrollPolicy.unreadEntryLanding(
                rowStartLanding: landingOffset(forRowStart: frame.minY),
                tailOffset: maximumOffsetY()
              ) else { return false }
        isPinningBottom = true
        collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: landing), animated: false)
        isPinningBottom = false
        scrollPolicy.anchorAtFirstUnread(offset: landing)
        unreadAnchorID = targetID
        lastPinnedViewportSize = collectionView.bounds.size
        lastPinnedAdjustedInsets = tailAdjustedInsets
        KLog.chat("📌 [chat-entry] first-unread session=\(sessionId.prefix(12)) reason=\(reason) boundary=\(boundary) row=\(targetID.prefix(16)) landing=\(Int(landing)) tail=\(Int(maximumOffsetY()))")
        updateJumpButtonVisibility()
        return true
    }

    /// The held first new row. A turn that concludes folds its mid-turn
    /// messages into Steps: then the first new row still shown takes over.
    func heldUnreadIndex() -> Int? {
        if let id = unreadAnchorID, let index = items.firstIndex(of: id) { return index }
        guard let boundary = unreadEntryBoundary else { return nil }
        let rows = unreadEntryRows()
        guard let id = ChatScrollPolicy.firstUnreadRow(rows, after: boundary,
                                                        latestReplyFallback: latestReplyFallback) else { return nil }
        unreadAnchorID = id
        return items.firstIndex(of: id)
    }

    /// The entry had a red dot and every row up to the Session's head is
    /// loaded: the latest reply may be the new part (firstUnreadRow).
    var latestReplyFallback: Bool { unreadEntryHadGap && atNewest }

    /// Every loaded row with its seq and whether the user wrote it, for
    /// ChatScrollPolicy.firstUnreadRow.
    func unreadEntryRows() -> [(id: String, seq: Int?, isUser: Bool)] {
        items.map { id in
            guard let message = message(id), message.seq > 0 else { return (id, nil, false) }
            return (id, message.seq, message.type == "user_message")
        }
    }

    #if DEBUG
    var automationUnreadEntry: ChatScrollPolicy.UnreadEntry { scrollPolicy.unreadEntry }
    #endif
}
#endif
