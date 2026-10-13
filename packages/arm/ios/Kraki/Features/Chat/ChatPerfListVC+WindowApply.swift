/// Applying window changes to the iOS chat list as manual batch updates (inserts, removals, reloads, anchoring).

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    // MARK: Window apply (manual batch updates)

    /// First load: fill the model and jump to the newest end (bottom).
    func applyInitial() {
        let t0 = CFAbsoluteTimeGetCurrent()
        items = ids
        chatPerfLog.log("[diag] applyInitial items=\(items.count) turns=\(messages.count) cvFrame=\(Int(view.bounds.width))x\(Int(view.bounds.height)) cvCount=\(collectionView.numberOfItems(inSection: 0))")
        // Persistent edge spinners: show "loading earlier messages" as long as
        // older history remains undisplayed (header above the oldest loaded
        // row), and "loading newer messages" while newer history remains below
        // (footer below the newest loaded row). Both auto-managed in applyEdges
        // thereafter. Set BEFORE the first layout so they're part of the initial
        // content - we anchor at the bottom, so the off-screen top header needs
        // no front-shift, and the footer is usually hidden on open (at head).
        loadingOlder = hasLoadedWindow && !atOldest
        loadingNewer = showsNewerSpinner
        collectionView.reloadData()
        if !items.isEmpty {
            // Position the first layout at the tail. Laying out at offset zero
            // first creates the oldest visible rich cells only to discard them
            // when pinToBottom runs, adding hundreds of milliseconds to entry.
            collectionView.scrollToItem(
                at: IndexPath(item: items.count - 1, section: 0),
                at: .bottom,
                animated: false
            )
        }
        collectionView.layoutIfNeeded()
        didInitialScroll = true
        pinToBottom(reason: "initial")
        lastReason = "initial"
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        chatPerfLog.log("[entry] applyInitial ms=\(String(format: "%.1f", ms)) items=\(items.count)")
        KLog.chat("📥 [chat-entry] applyInitial session=\(sessionId.prefix(12)) items=\(items.count) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) atNewest=\(atNewest) ms=\(String(format: "%.1f", ms))")
        logEntryState("applyInitial")
        updateOverlay()
        updateJumpButtonVisibility()
    }

    /// Resolve the bottom viewport before UIKit presents the navigation
    /// transition. The list can cheaply estimate every loaded row, but exposing
    /// those estimates makes the final bubble (or the rows immediately above a
    /// live card) appear clipped until the async warmer expands them. Measuring
    /// only the already-visible tail here keeps entry bounded while ensuring
    /// the first composited frame uses the same exact geometry as the cells.
    func settleInitialVisibleGeometryBeforePresentation() {
        guard !initialVisibleGeometrySettled,
              !isSettlingInitialVisibleGeometry,
              collectionView != nil,
              !items.isEmpty else { return }
        let width = collectionView.bounds.width
        guard width > 0 else { return }

        isSettlingInitialVisibleGeometry = true
        defer { isSettlingInitialVisibleGeometry = false }
        let started = CFAbsoluteTimeGetCurrent()
        let oldContentHeight = collectionView.contentSize.height
        sizer.prepare(width: width)
        lastWarmWidth = width
        collectionView.layoutIfNeeded()

        var measuredIDs = Set<String>()
        // A height correction can slightly change which older row intersects
        // the top edge. Iterate a small bounded number of times so every row in
        // the final first viewport is exact without warming the whole window.
        for _ in 0..<3 {
            let cold = collectionView.indexPathsForVisibleItems
                .sorted()
                .compactMap { indexPath -> ChatMessage? in
                    guard indexPath.item < items.count,
                          let message = message(items[indexPath.item]),
                          sizer.cached(message.id) == nil else { return nil }
                    return message
                }
            guard !cold.isEmpty else { break }
            for message in cold {
                sizer.prime(message, width: width, notify: false)
                measuredIDs.insert(message.id)
            }
            let context = UICollectionViewFlowLayoutInvalidationContext()
            context.invalidateFlowLayoutDelegateMetrics = true
            context.invalidateFlowLayoutAttributes = true
            collectionView.collectionViewLayout.invalidateLayout(with: context)
            collectionView.layoutIfNeeded()
            if followingBottom {
                pinToBottom(reason: "entry-exact")
            }
        }

        let hasColdVisibleMessage = collectionView.indexPathsForVisibleItems.contains { indexPath in
            guard indexPath.item < items.count,
                  let message = message(items[indexPath.item]) else { return false }
            return sizer.cached(message.id) == nil
        }
        guard !hasColdVisibleMessage else { return }
        appliedHeightIDs.formUnion(measuredIDs)
        initialVisibleGeometrySettled = true
        let elapsed = (CFAbsoluteTimeGetCurrent() - started) * 1_000
        chatPerfLog.log(
            "[entry] exact-visible n=\(measuredIDs.count) "
                + "content=\(String(format: "%.1f", oldContentHeight))"
                + "→\(String(format: "%.1f", collectionView.contentSize.height)) "
                + "ms=\(String(format: "%.1f", elapsed)) live=\(hasLiveCardItem ? 1 : 0)"
        )
    }

    /// Keep one compact screen of nearby rows hot after entry/settling. The
    /// initial window is only 30 persistent messages, so eight neighbors cover
    /// typical real Sessions without restoring the old whole-history warm storm.
    /// Warm the WHOLE loaded window at rest, nearest rows first. Pages enter
    /// already measured, so the window is the only source of cold rows; keeping
    /// it fully exact means a fling never exposes an estimated height.
    static let warmRadius = 400

    func scheduleWarmKick() {
        warmKickWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.viewIfLoaded?.window != nil else { return }
            self.warmKickWork = nil
            self.warmWindow()
        }
        warmKickWork = work
        // Let the navigation transition and the first back/tap opportunity
        // settle before any atomic TextKit measurement reaches the main actor.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35, execute: work)
    }

    func cancelPendingWarm() {
        warmer.cancelAll()
        warmEnqueued = Set(warmEnqueued.filter { sizer.cached($0) != nil })
        pendingHeightRefreshIDs.removeAll(keepingCapacity: true)
    }

    /// Coalesce exact-height upgrades into one layout pass. When the user is
    /// following the newest tail, repin after the pass; otherwise preserve the
    /// first visible item's screen position while rows above it change height.
    func scheduleHeightRefresh(for id: String) {
        guard collectionView != nil else { return }
        pendingHeightRefreshIDs.insert(id)
        guard !heightRefreshScheduled else { return }
        heightRefreshScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.heightRefreshScheduled = false
            let ids = self.pendingHeightRefreshIDs
            self.pendingHeightRefreshIDs.removeAll(keepingCapacity: true)
            guard !ids.isEmpty,
                  !self.isLeavingView,
                  self.collectionView != nil,
                  self.viewIfLoaded?.window != nil else { return }

            let anchor = self.readingAnchor(excluding: ids)
            let context = UICollectionViewFlowLayoutInvalidationContext()
            let applicableIDs = ids.filter { self.items.contains($0) }
            let paths = applicableIDs.compactMap { id in
                self.items.firstIndex(of: id).map { IndexPath(item: $0, section: 0) }
            }
            guard !paths.isEmpty else { return }
            let layoutStarted = CFAbsoluteTimeGetCurrent()
            let oldContentHeight = self.collectionView.contentSize.height
            let oldHeights = Dictionary(paths.map { path in
                (path, self.collectionView.layoutAttributesForItem(at: path)?.frame.height ?? -1)
            }, uniquingKeysWith: { first, _ in first })
            let contentHeightDelta = paths.reduce(CGFloat.zero) { total, path in
                let old = oldHeights[path] ?? 0
                guard path.item < self.items.count,
                      let new = self.sizer.cached(self.items[path.item]), old >= 0 else { return total }
                return total + new - old
            }
            if self.followingBottom, abs(contentHeightDelta) > 0.5 {
                // Rebase the scroll offset inside the same FlowLayout
                // invalidation transaction that changes content height. Laying
                // out first and pinning second briefly exposes an earlier,
                // clipped viewport when nearby rows warm after entry.
                context.contentOffsetAdjustment = CGPoint(x: 0, y: contentHeightDelta)
            }
            // `sizeForItemAt` is a FlowLayout delegate metric. Invalidating only
            // item attributes can leave the old estimated height cached until a
            // user scroll starts another layout cycle, producing the observed
            // "broken on entry, fixed after one swipe" state. Force FlowLayout
            // to re-read the now-exact sizer cache in this same settled pass.
            context.invalidateFlowLayoutDelegateMetrics = true
            context.invalidateFlowLayoutAttributes = true
            self.collectionView.collectionViewLayout.invalidateLayout(with: context)
            self.collectionView.layoutIfNeeded()

            if self.followingBottom {
                self.lastPinnedViewportSize = self.collectionView.bounds.size
                self.lastPinnedAdjustedInsets = self.tailAdjustedInsets
            } else if let anchor,
                      let newFrame = self.collectionView.layoutAttributesForItem(at: anchor.0)?.frame {
                self.collectionView.contentOffset.y += newFrame.minY - anchor.1
            }
            self.appliedHeightIDs.formUnion(applicableIDs)
            let layoutMs = (CFAbsoluteTimeGetCurrent() - layoutStarted) * 1_000
            let changed = paths.reduce(into: 0) { count, path in
                let old = oldHeights[path] ?? -1
                let new = self.collectionView.layoutAttributesForItem(at: path)?.frame.height ?? -1
                if abs(new - old) > 0.5 { count += 1 }
            }
            if layoutMs > 4 || changed > 0 {
                chatPerfLog.log(
                    "[height] apply n=\(paths.count) changed=\(changed) "
                        + "content=\(String(format: "%.1f", oldContentHeight))"
                        + "→\(String(format: "%.1f", self.collectionView.contentSize.height)) "
                        + "off=\(String(format: "%.1f", self.collectionView.contentOffset.y)) "
                        + "distBottom=\(String(format: "%.1f", self.distanceToBottom())) "
                        + "ms=\(String(format: "%.1f", layoutMs))"
                )
            }
        }
    }

    /// The row the reader is looking at: the visible row closest to the middle
    /// of the unobstructed viewport whose height is NOT about to change. Using
    /// "first visible row" as the anchor made every correction of that (often
    /// partially visible, still estimated) row shift everything being read.
    func readingAnchor(excluding changing: Set<String> = []) -> (IndexPath, CGFloat)? {
        // Landed on the first new message: it is what the reader is reading,
        // so height corrections above it must not move it.
        if scrollPolicy.unreadEntry == .anchored, let index = heldUnreadIndex(),
           let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame {
            return (IndexPath(item: index, section: 0), frame.minY)
        }
        let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        let bottom = collectionView.contentOffset.y + collectionView.bounds.height
            - collectionView.adjustedContentInset.bottom
        let middle = (top + bottom) / 2
        var best: (IndexPath, CGFloat, CGFloat)?
        var fallback: (IndexPath, CGFloat, CGFloat)?
        for indexPath in collectionView.indexPathsForVisibleItems {
            guard indexPath.item < items.count,
                  let frame = collectionView.layoutAttributesForItem(at: indexPath)?.frame,
                  frame.maxY > top + 1, frame.minY < bottom - 1 else { continue }
            let id = items[indexPath.item]
            let distance = abs(frame.midY - middle)
            let stable = !changing.contains(id)
                && (id == Self.liveCardID || sizer.cached(id) != nil)
            if stable {
                if best == nil || distance < best!.2 { best = (indexPath, frame.minY, distance) }
            } else if fallback == nil || distance < fallback!.2 {
                fallback = (indexPath, frame.minY, distance)
            }
        }
        if let best { return (best.0, best.1) }
        return fallback.map { ($0.0, $0.1) }
    }

    /// Make every visible row exact before the frame is composited. Used after
    /// any reload that can introduce new row identities (stream → landed
    /// message, pending → echoed message, jump re-anchor). Follows the tail
    /// when pinned; otherwise preserves the reading anchor.
    @discardableResult
    func exactVisibleRows() -> Int {
        let width = collectionView.bounds.width
        guard width > 0, !items.isEmpty else { return 0 }
        sizer.prepare(width: width)
        var measured = 0
        for _ in 0..<4 {
            // Ask the layout, not the cell pool: right after reloadData + a
            // programmatic offset change no cells exist yet for the new rect.
            collectionView.layoutIfNeeded()
            let cold = visibleIndexPathsFromLayout().compactMap { indexPath -> ChatMessage? in
                guard indexPath.item < items.count,
                      let message = message(items[indexPath.item]),
                      sizer.cached(message.id) == nil else { return nil }
                return message
            }
            guard !cold.isEmpty else { break }
            let coldIDs = Set(cold.map(\.id))
            let anchor = followingBottom ? nil : readingAnchor(excluding: coldIDs)
            for message in cold {
                sizer.prime(message, width: width, notify: false)
                appliedHeightIDs.insert(message.id)
                measured += 1
            }
            let context = UICollectionViewFlowLayoutInvalidationContext()
            context.invalidateFlowLayoutDelegateMetrics = true
            context.invalidateFlowLayoutAttributes = true
            collectionView.collectionViewLayout.invalidateLayout(with: context)
            collectionView.layoutIfNeeded()
            if followingBottom {
                pinToBottom(reason: "exact-visible")
            } else if let anchor,
                      let frame = collectionView.layoutAttributesForItem(at: anchor.0)?.frame {
                collectionView.contentOffset.y += frame.minY - anchor.1
            }
        }
        return measured
    }

    func visibleIndexPathsFromLayout() -> [IndexPath] {
        let rect = CGRect(origin: collectionView.contentOffset, size: collectionView.bounds.size)
        return (collectionView.collectionViewLayout.layoutAttributesForElements(in: rect) ?? [])
            .filter { $0.representedElementCategory == .cell }
            .map(\.indexPath)
            .sorted()
    }

    /// Measure the rows that will fill the viewport at the newest edge, so a
    /// jump to latest lands on exact geometry instead of correcting afterwards.
    func primeTailViewport() {
        let width = collectionView.bounds.width
        guard width > 0 else { return }
        sizer.prepare(width: width)
        var covered: CGFloat = 0
        let target = collectionView.bounds.height * 1.25
        for id in items.reversed() {
            guard covered < target else { break }
            if id == Self.liveCardID { covered += 200; continue }
            guard let message = message(id) else { continue }
            sizer.prime(message, width: width, notify: false)
            appliedHeightIDs.insert(id)
            covered += sizer.cached(id) ?? 0
        }
        let context = UICollectionViewFlowLayoutInvalidationContext()
        context.invalidateFlowLayoutDelegateMetrics = true
        collectionView.collectionViewLayout.invalidateLayout(with: context)
        collectionView.layoutIfNeeded()
    }

    func warmWindow(radius requestedRadius: Int? = nil) {
        let width = collectionView.bounds.width
        guard width > 0,
              !items.isEmpty,
              !isLeavingView,
              viewIfLoaded?.window != nil else { return }
        // Width changed (rotation / split): cancel jobs measured for the old
        // geometry before clearing the cache and restarting the warm pass.
        if width != lastWarmWidth {
            lastWarmWidth = width
            cancelPendingWarm()
            warmEnqueued.removeAll(keepingCapacity: true)
            appliedHeightIDs.removeAll(keepingCapacity: true)
        }
        sizer.prepare(width: width)

        let visible = collectionView.indexPathsForVisibleItems.map(\.item).sorted()
        var candidates = visible.isEmpty ? [items.count - 1] : visible
        let radius = requestedRadius ?? Self.warmRadius
        if radius > 0, let first = visible.first, let last = visible.last {
            for distance in 1...radius {
                let before = first - distance
                let after = last + distance
                if before >= 0 { candidates.append(before) }
                if after < items.count { candidates.append(after) }
            }
        }

        var seen = Set<Int>()
        var jobs: [() -> Void] = []
        for index in candidates where seen.insert(index).inserted {
            guard index >= 0, index < items.count,
                  let message = message(items[index]) else { continue }
            if sizer.cached(message.id) != nil {
                if !appliedHeightIDs.contains(message.id) {
                    scheduleHeightRefresh(for: message.id)
                }
                continue
            }
            guard !warmEnqueued.contains(message.id) else { continue }
            warmEnqueued.insert(message.id)
            jobs.append { [weak self] in self?.sizer.prime(message, width: width) }
        }
        guard !jobs.isEmpty else { return }
        chatPerfLog.log("[warm] enqueue n=\(jobs.count) visible=\(visible.first ?? -1)-\(visible.last ?? -1)")
        warmer.enqueue(jobs)
    }

    /// Apply a window slide as explicit edge edits, optionally collapsing
    /// the loading spinner row in the SAME pass. The change in content
    /// height ABOVE the viewport (`frontDelta`) is handed to the layout, so
    /// UIKit shifts the viewport itself during the update cycle — keeping
    /// existing bubbles visually pinned without a hand-written contentOffset
    /// that would fight an in-flight drag or the top rubber-band.
    ///
    /// Index spaces: deletes use the OLD index space, inserts the NEW —
    /// exactly what `performBatchUpdates` expects.
    /// Refresh the flat spine snapshot + reload when new messages have landed on the spine since the
    /// last sync. Called from the SwiftUI representable's `updateUIViewController`
    /// (which fires on every `@Observable` store change) so live arrivals render.
    /// No-op when nothing changed.
    /// Keep the newest edge anchored when the fixed composer/status clearance
    /// changes (e.g. device availability). Expansion of the floating composer
    /// never reaches this path; older-history reading remains independent.
    var shouldFollowLiveTail: Bool {
        scrollPolicy.shouldFollowTail(distanceToBottom: distanceToBottom())
    }

    func updateBottomContentInset(_ value: CGFloat) {
        guard abs(value - bottomContentInset) > 0.5 else { return }
        // Preserve semantic follow state while still tolerating tiny geometry
        // drift. Explicit older-history intent wins over the 24pt tolerance.
        let shouldFollow = shouldFollowLiveTail
        let delta = abs(value - bottomContentInset)
        bottomContentInset = value
        let apply = {
            self.collectionView.contentInset.bottom = value + self.composerOverlayInset
            self.collectionView.verticalScrollIndicatorInsets.bottom = value + self.composerOverlayInset
            self.jumpButtonBottomConstraint?.constant = -Self.jumpBottomGap(value)
            self.view.layoutIfNeeded()
            self.scrollPolicy.setFollowingTail(shouldFollow)
            if shouldFollow {
                self.pinToBottom(reason: "composer-inset")
            }
        }
        // Animate genuine obstruction changes (e.g. the compaction status row).
        // Recording/multiline growth never changes this resting clearance.
        if delta > 30, view.window != nil {
            UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.9,
                           initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState],
                           animations: apply)
        } else {
            apply()
        }
        updateJumpButtonVisibility()
    }

    func refreshVisibleLiveCard(at index: Int, duringPaging: Bool) {
        guard index < collectionView.numberOfItems(inSection: 0),
              let card = vm.card else { return }
        let indexPath = IndexPath(item: index, section: 0)
        if let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell {
            let content = liveContent(card)
            cell.configure(content, cellWidth: collectionView.bounds.width)
            cell.onOpenSteps = { [weak self] _ in self?.presentLiveSteps() }
            #if DEBUG
            if alignmentLoggingEnabled {
                alignmentRevision += 1
                let presentationHeight = cell.layer.presentation()?.frame.height ?? cell.frame.height
                IOSChatAlignmentLog.write(
                    "revision=\(alignmentRevision) cell=\(ObjectIdentifier(cell)) oldHeight=\(String(format: "%.2f", cell.bounds.height)) presentationHeight=\(String(format: "%.2f", presentationHeight)) targetHeight=\(String(format: "%.2f", content.cellHeight(cellWidth: collectionView.bounds.width))) pinned=\(followingBottom ? 1 : 0)"
                )
            }
            #endif
        }
        animateItemGeometry(at: indexPath, animated: !duringPaging)
    }

    func animateHeightChange(for cell: TKBubbleCell) {
        guard let indexPath = collectionView.indexPath(for: cell) else {
            collectionView.collectionViewLayout.invalidateLayout()
            return
        }
        animateItemGeometry(at: indexPath, animated: true)
    }

    func animateItemGeometry(at indexPath: IndexPath, animated: Bool) {
        let shouldFollow = shouldFollowLiveTail
        let context = UICollectionViewFlowLayoutInvalidationContext()
        context.invalidateItems(at: [indexPath])
        // An item-only invalidation updates FlowLayout's content size but NOT
        // UIScrollView.contentSize (every tail pin / distance reads the latter).
        // Report the growth PLUS any drift already present, so the scroll view
        // always converges on the layout's truth instead of accumulating error
        // (which showed as a gap under the bubble after a table rendered).
        let layoutHeight = collectionView.collectionViewLayout.collectionViewContentSize.height
        let drift = layoutHeight - collectionView.contentSize.height
        let oldItemHeight = collectionView.layoutAttributesForItem(at: indexPath)?.frame.height ?? 0
        let newItemHeight = self.collectionView(
            collectionView,
            layout: collectionView.collectionViewLayout,
            sizeForItemAt: indexPath
        ).height
        let adjustment = (newItemHeight - oldItemHeight) + drift
        if abs(adjustment) > 0.01 {
            context.contentSizeAdjustment = CGSize(width: 0, height: adjustment)
        }
        collectionView.collectionViewLayout.invalidateLayout(with: context)

        let updates = {
            self.collectionView.layoutIfNeeded()
            if shouldFollow {
                let maxY = self.followPinOffset(keepingRevealed: true)
                self.collectionView.contentOffset.y = maxY
                self.scrollPolicy.pinToTail(observedOffset: maxY)
            }
        }
        guard animated, collectionView.window != nil else {
            UIView.performWithoutAnimation(updates)
            return
        }
        UIView.animate(
            withDuration: 0.22,
            delay: 0,
            options: [.beginFromCurrentState, .curveEaseOut, .allowUserInteraction],
            animations: updates
        ) { [weak self] finished in
            #if DEBUG
            guard let self, self.alignmentLoggingEnabled else { return }
            let height = self.collectionView.layoutAttributesForItem(at: indexPath)?.frame.height ?? -1
            IOSChatAlignmentLog.write(
                "animation item=\(indexPath.item) finished=\(finished ? 1 : 0) height=\(String(format: "%.2f", height)) bottomDistance=\(String(format: "%.2f", self.distanceToBottom()))"
            )
            #endif
        }
    }

    func syncLiveUpdates() {
        #if KRAKI_DIAG
        let diagWork = KrakiDiag.beginWork()
        defer { KrakiDiag.endWork(diagWork, source: "ios.list_sync", session: sessionId) }
        #endif
        let cardSig = liveCardSignature
        let cardChanged = cardSig != lastLiveCardSignature
        let pendingSig = vm.pendingSignature
        // Captured before refreshSpineSnapshot() records the new signature.
        let previousPendingSig = lastPendingSignature
        let sig = "\(vm.filteredMessages.count)|\(vm.windowTopSeq)|\(vm.windowBottomSeq)|\(vm.sessionLastSeq)|\(cardSig)|\(pendingSig)"
        chatPerfLog.log("[diag] syncLive sig=\(sig) last=\(lastSyncedSignature) items=\(items.count)")
        logEntryState("syncBefore")
        guard sig != lastSyncedSignature else { return }
        lastSyncedSignature = sig
        // If a pagination batch is mid-flight, a `reloadData()` here would
        // desync `items` from the batch's view of the data source and surface
        // as empty-cell (OOB guard) flashes. Defer the spine reload until the
        // page settles; `cardChanged` (streaming tail) still reconfigures the
        // single live-card cell cheaply so the tail keeps updating live.
        let pagingInFlight = fetchingOlder || fetchingNewer || measuringOlderPage || measuringNewerPage
            || paginationSnapshotDeferred || pendingApply != nil
        if pagingInFlight {
            refreshSpineSnapshot()
            // A held (fully fetched) older page must not hide the live tail.
            revealHeldOlderPageForLiveUpdate()
            if cardChanged, let idx = items.firstIndex(of: Self.liveCardID) {
                lastLiveCardSignature = cardSig
                refreshVisibleLiveCard(at: idx, duringPaging: true)
            }
            return
        }
        refreshSpineSnapshot()
        // A network `.before` response may advance the raw window after the
        // initiating DB-first task has already returned. Treat that external
        // front growth as the same buffered pagination transaction rather than
        // reloading cold rows directly from this observation callback.
        if !items.isEmpty,
           let edge = reconcileEdges(old: items, new: ids),
           edge.insertFront > 0 {
            paginationSnapshotDeferred = true
            resumeBufferedPageMeasurements()
            return
        }
        // Tail append (including the important empty → first-message
        // transition): reconcile items → ids and reload. Head metadata can
        // also change without changing ids; refresh the footer/jump state so
        // an initially unknown head does not leave a permanent newer spinner.
        let newIds = ids
        let showOlderSpinner = hasLoadedWindow && !atOldest
        // Network catch-up lands silently; the bottom spinner is only for
        // newer rows paged back in from this device's own history.
        let showNewerSpinner = showsNewerSpinner
        let edgeStateChanged = loadingOlder != showOlderSpinner || loadingNewer != showNewerSpinner
        loadingOlder = showOlderSpinner
        loadingNewer = showNewerSpinner
        let idsChanged = items != newIds
        let pendingStateChanged = pendingSig != previousPendingSig
        lastPendingSignature = pendingSig
        if !idsChanged, !edgeStateChanged, pendingStateChanged {
            // Same rows, new delivery state: reconfigure in place (no reload).
            reconfigureVisiblePendingRows()
        }
        if idsChanged || edgeStateChanged {
            // Full reload only when the spine item set or edge spinners moved.
            let wasAtBottom = shouldFollowLiveTail
            let isFirstMaterialization = items.isEmpty && !newIds.isEmpty
            let oldItemsForArrivals = items
            let anchor = wasAtBottom ? nil : readingAnchor()
            let anchorID = anchor.flatMap { $0.0.item < items.count ? items[$0.0.item] : nil }
            let oldItems = items
            lastLiveCardSignature = cardSig
            liveContentMemo = nil
            let entrances = didInitialScroll && !isFirstMaterialization
                ? recordEntrances(old: oldItems, new: newIds) : 0
            let offsetBeforeArrival = collectionView.contentOffset.y
            if edgeStateChanged || isFirstMaterialization || !applyTailInPlace(old: oldItems, new: newIds) {
                items = newIds
                collectionView.reloadData()
            }
            collectionView.layoutIfNeeded()
            if !items.isEmpty, !didInitialScroll || wasAtBottom {
                pinToBottom(reason: "live-update", animated: false)
                if entrances > 0, wasAtBottom {
                    glideArrival(from: offsetBeforeArrival)
                }
            } else if let anchor, let anchorID, let index = items.firstIndex(of: anchorID),
                      let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame {
                // A reload must not move what the reader is looking at.
                collectionView.contentOffset.y += frame.minY - anchor.1
            }
            if didInitialScroll, !isFirstMaterialization {
                // New identities (landed answer, echoed send) must never be
                // composited with an estimated height.
                exactVisibleRows()
                if !wasAtBottom { noteArrivalsWhileAway(old: oldItemsForArrivals, new: items) }
            }
            // If the controller was created while its DB window was still
            // empty, this observation is its real first frame. Settle that tail
            // synchronously in the same run-loop turn before it can be shown.
            if isFirstMaterialization {
                initialVisibleGeometrySettled = false
                settleInitialVisibleGeometryBeforePresentation()
            }
        } else if cardChanged {
            // Only the streaming tail cell's content changed (same item set).
            // Avoid the full reloadData()+layoutIfNeeded() storm that fired
            // once per streaming chunk and fought scroll/gesture state - just
            // reconfigure the live-card cell (and re-pin only if we're
            // following, so a growing tail stays visible without yanking a
            // user who scrolled up).
            lastLiveCardSignature = cardSig
            scheduleLiveRender()
        }
        updateJumpButtonVisibility()
        updateOverlay()
        logEntryState("syncAfter")
    }

    func handlePendingAction(clientId: String, action: TKBubbleCell.PendingAction) {
        guard let sender = appState.commandSender else { return }
        switch action {
        case .retry:
            if sender.isStaged(sessionId: sessionId, clientId: clientId) {
                // "Send original": don't wait for the voice correction.
                sender.dispatchStagedInput(sessionId: sessionId, clientId: clientId,
                                           text: sender.originalText(sessionId: sessionId, clientId: clientId) ?? "")
            } else {
                sender.retryPending(sessionId: sessionId, clientId: clientId)
            }
        case .delete:
            sender.discardPending(sessionId: sessionId, clientId: clientId)
        }
        syncLiveUpdates()
    }

    /// Mirrors Mac `recordEntrances`: only new rows after the last surviving
    /// old row, at most two (a catch-up burst is not a conversation beat), and
    /// a row that only changes identity (pending → echoed message, live card →
    /// landed answer) replaces an old tail row of the same role and does not
    /// enter again. Session entry and older pages never get here.
    @discardableResult
    func recordEntrances(old: [String], new: [String]) -> Int {
        let now = CACurrentMediaTime()
        pendingEntrances = pendingEntrances.filter { $0.value.deadline > now }
        guard !old.isEmpty, !UIAccessibility.isReduceMotionEnabled else { return 0 }
        let oldSet = Set(old), newSet = Set(new)
        // Rows added at the top are older history, not an arrival.
        if let first = old.first, let firstInNew = new.firstIndex(of: first), firstInNew > 0 { return 0 }
        var removedUser = 0, removedReply = 0
        for id in old where !newSet.contains(id) {
            switch entranceRole(id) {
            case .user?: removedUser += 1
            case .reply?: removedReply += 1
            case nil: break
            }
        }
        guard let survivingTail = new.lastIndex(where: { oldSet.contains($0) }) else { return 0 }
        let appended = new[(survivingTail + 1)...].compactMap { id in entranceRole(id).map { (id, $0) } }
        guard !appended.isEmpty, appended.count <= 2 else { return 0 }
        var recorded = 0
        for (id, role) in appended {
            switch role {
            case .user where removedUser > 0: removedUser -= 1; continue
            case .reply where removedReply > 0: removedReply -= 1; continue
            default: break
            }
            pendingEntrances[id] = (role == .user, now + 0.8)
            recorded += 1
        }
        return recorded
    }

    enum EntranceRole { case user, reply }

    var latestItemIsUser: Bool {
        items.last.flatMap(entranceRole) == .user
    }

    func entranceRole(_ id: String) -> EntranceRole? {
        if id == Self.liveCardID { return .reply }
        guard let message = message(id) else { return nil }
        if ["user_message", "send_input", "pending_input"].contains(message.type) { return .user }
        if message.type == "agent_message" || message.frozenCard != nil { return .reply }
        return nil
    }

    /// The bubble slides in from its side while fading in. Additive on the
    /// cell's presentation only, so frame/height updates while streaming never
    /// fight it.
    func runEntranceIfPending(_ cell: UICollectionViewCell, id: String) {
        guard let entrance = pendingEntrances.removeValue(forKey: id),
              entrance.deadline > CACurrentMediaTime() else { return }
        let slide = CABasicAnimation(keyPath: "transform.translation.x")
        slide.fromValue = (entrance.fromTrailing ? 1 : -1) * Self.entranceOffset
        slide.toValue = 0
        slide.isAdditive = true
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        let group = CAAnimationGroup()
        group.animations = [slide, fade]
        group.duration = Self.entranceDuration
        group.timingFunction = Self.entranceTiming
        group.fillMode = .backwards
        cell.layer.add(group, forKey: "kraki.entrance")
        #if DEBUG
        entranceLog.append((id, entrance.fromTrailing))
        #endif
    }

    /// The list glides up to make room for an arrival. The real offset is
    /// already pinned to the bottom; only the presentation starts from the old
    /// position, so later streaming pins compose with it instead of cutting it.
    func glideArrival(from oldOffset: CGFloat) {
        let delta = collectionView.contentOffset.y - oldOffset
        guard delta > 0.5, collectionView.window != nil else { return }
        let glide = CABasicAnimation(keyPath: "sublayerTransform.translation.y")
        glide.fromValue = delta
        glide.toValue = 0
        glide.isAdditive = true
        glide.duration = Self.entranceDuration
        glide.timingFunction = Self.entranceTiming
        collectionView.layer.add(glide, forKey: "kraki.arrivalGlide")
        #if DEBUG
        arrivalGlideLog.append(delta)
        #endif
    }

    /// Apply a change confined to the newest rows (send, echo, stream start,
    /// answer landing) without `reloadData()`: rows are inserted/deleted
    /// without animation and rows whose identity changed in place (pending →
    /// echoed message, live card → landed answer) keep their existing cell and
    /// are simply reconfigured. A reload re-dequeues every visible cell, which
    /// re-assigns all text and backgrounds and reads as a flash.
    func applyTailInPlace(old: [String], new: [String]) -> Bool {
        guard !old.isEmpty, !new.isEmpty, collectionView.window != nil else { return false }
        // The live card changes rows first (animated), then the rest applies.
        if let moved = liveCardMoved(old: old, new: new), applyLiveCardMove(old: old, to: moved) {
            return moved == new || applyTailInPlace(old: moved, new: new)
        }
        let shared = min(old.count, new.count)
        var prefix = 0
        while prefix < shared, old[prefix] == new[prefix] { prefix += 1 }
        let oldTail = old.count - prefix
        let newTail = new.count - prefix
        guard oldTail <= 12, newTail <= 12, prefix > 0 || old.count <= 12 else { return false }
        let replaced = min(oldTail, newTail)

        // Exact heights for every new identity before any layout sees it.
        let width = collectionView.bounds.width
        sizer.prepare(width: width)
        for id in new[prefix...] where id != Self.liveCardID {
            guard let message = message(id) else { continue }
            sizer.prime(message, width: width, notify: false)
            appliedHeightIDs.insert(id)
        }

        // The tail swap is applied model-first: the replaced rows are
        // reconfigured explicitly below, and the OLD model is not layout-safe
        // here (a just-cleared live card has no content to size), because
        // performBatchUpdates computes pre-update attributes before running
        // its block. Pagination (applyEdges) swaps INSIDE the block instead:
        // there the old rows are intact and the swap must not be visible to
        // the pre-update pass. Invariant for this path: nothing may lay out
        // between this assignment and performBatchUpdates (no layoutIfNeeded,
        // no run-loop turn); invalidateLayout below is lazy.
        items = new
        UIView.performWithoutAnimation {
            let context = UICollectionViewFlowLayoutInvalidationContext()
            context.invalidateFlowLayoutDelegateMetrics = true
            collectionView.collectionViewLayout.invalidateLayout(with: context)
            collectionView.performBatchUpdates {
                if oldTail > newTail {
                    collectionView.deleteItems(at: ((prefix + replaced)..<old.count).map { IndexPath(item: $0, section: 0) })
                }
                if newTail > oldTail {
                    collectionView.insertItems(at: ((prefix + replaced)..<new.count).map { IndexPath(item: $0, section: 0) })
                }
            }
            for index in prefix..<(prefix + replaced) {
                let indexPath = IndexPath(item: index, section: 0)
                guard let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell else { continue }
                configureCell(cell, at: indexPath)
                cell.setNeedsLayout()
            }
            collectionView.layoutIfNeeded()
        }
        chatPerfLog.log("[apply] tail-in-place prefix=\(prefix) replaced=\(replaced) old=\(oldTail) new=\(newTail)")
        return true
    }

    func reconfigureVisiblePendingRows() {
        let width = collectionView.bounds.width
        sizer.prepare(width: width)
        var heightChanged = false
        for (index, id) in items.enumerated() where id.contains(":pending:") {
            guard let message = message(id) else { continue }
            // Correcting voice text changes in place. The bubble keeps its
            // size while it is corrected (it may grow, never shrink/jump).
            let correcting = message.payload["localState"]?.stringValue == "correcting"
            if sizer.remeasure(message, width: width, allowShrink: !correcting) { heightChanged = true }
            let indexPath = IndexPath(item: index, section: 0)
            guard let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell else { continue }
            cell.configure(TKBubbleContent.make(message: message, sessionId: sessionId, agent: agentName),
                           cellWidth: width)
            cell.setNeedsLayout()
        }
        guard heightChanged else { return }
        let wasAtBottom = shouldFollowLiveTail
        UIView.performWithoutAnimation {
            let context = UICollectionViewFlowLayoutInvalidationContext()
            context.invalidateFlowLayoutDelegateMetrics = true
            collectionView.collectionViewLayout.invalidateLayout(with: context)
            collectionView.layoutIfNeeded()
        }
        if wasAtBottom { pinToBottom(reason: "pending-resize", animated: false) }
    }
}
#endif
