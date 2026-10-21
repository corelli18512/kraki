#if os(iOS)
import UIKit

/// Re-laying out bubbles that are already on screen: after a code block's
/// syntax highlight finishes, and after the user changes the text size.
/// Where the reader is, kept across a full re-layout.
enum ReadingAnchor: Equatable {
    /// At the newest message: stay pinned to the bottom.
    case newest
    /// A message near the top of the viewport and its distance from the top.
    case message(id: String, offsetFromTop: CGFloat)
}

extension ChatPerfListVC {
    func installRelayoutObservers() {
        codeHighlightObserver = NotificationCenter.default.addObserver(
            forName: .tkCodeHighlightReady,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleCodeHighlightReady()
        }
        textSizeObserver = NotificationCenter.default.addObserver(
            forName: UIContentSizeCategory.didChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.relayoutForTextSizeChange() }
        }
    }

    /// The user changed the text size while the chat is open. Every bubble's
    /// text and height was built for the old size: drop them all and lay the
    /// loaded window out again (like a width change), keeping the reader where
    /// they were: at the newest message, or on the row at the top.
    func relayoutForTextSizeChange() {
        TKTextSize.refresh()
        // Per list: another open chat may already have refreshed the key.
        guard laidOutTextSize != TKTextSize.key, collectionView != nil else { return }
        laidOutTextSize = TKTextSize.key
        relayoutLoadedWindow(keeping: followingBottom ? .newest : currentReadingAnchor(), reason: "text-size")
        chatPerfLog.log("[text-size] relayout size=\(TKTextSize.key) items=\(items.count)")
    }

    // MARK: Width changes (iPhone Duo fold/unfold, iPad resize, rotation)

    /// Called from `viewDidLayoutSubviews`. The anchor was captured in
    /// `viewWillLayoutSubviews`, before the list took its new width.
    func handleWidthChangeIfNeeded() {
        guard collectionView != nil, !isLeavingView else { return }
        let width = collectionView.bounds.width
        guard width > 0 else { return }
        if laidOutWidth == 0 { laidOutWidth = width; return }
        guard width != laidOutWidth else { rememberReadingAnchor(force: false); return }
        guard !widthRelayoutScheduled else { return }
        widthRelayoutScheduled = true
        // Never re-enter a collection update from inside layout.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.widthRelayoutScheduled = false
            let width = self.collectionView.bounds.width
            guard width > 0, width != self.laidOutWidth else { return }
            let anchor = self.followingBottom ? .newest : self.lastReadingAnchor
            self.laidOutWidth = width
            self.relayoutLoadedWindow(keeping: anchor, reason: "width")
            chatPerfLog.log("[width] relayout width=\(Int(width)) items=\(self.items.count)")
        }
    }

    /// Put the anchored message back at its distance from the viewport top.
    func restore(_ anchor: ReadingAnchor) {
        guard case .message(let id, let delta) = anchor, collectionView != nil,
              let index = items.firstIndex(of: id), index < collectionView.numberOfItems(inSection: 0) else { return }
        for _ in 0..<3 {
            collectionView.layoutIfNeeded()
            guard let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else { return }
            let inset = collectionView.adjustedContentInset
            let maxY = max(-inset.top, collectionView.contentSize.height + inset.bottom - collectionView.bounds.height)
            let y = min(max(frame.minY - delta - inset.top, -inset.top), maxY)
            if abs(collectionView.contentOffset.y - y) < 0.5 { return }
            applyingProgrammaticShift = true
            collectionView.setContentOffset(CGPoint(x: 0, y: y), animated: false)
            applyingProgrammaticShift = false
        }
    }

    /// Record the reading position, only while laid out for `laidOutWidth`.
    /// `force` (a user scroll) re-reads it. Otherwise it is kept as is, so
    /// repeated folds don't drift to a neighbouring message; it is refreshed
    /// only when missing, when following changes, or when its message is no
    /// longer loaded.
    func rememberReadingAnchor(force: Bool) {
        guard collectionView != nil, laidOutWidth > 0, collectionView.bounds.width == laidOutWidth,
              !widthRelayoutScheduled else { return }
        if followingBottom { lastReadingAnchor = .newest; return }
        // Same message, current distance: late height corrections can move
        // what is on screen without a user scroll, and a fold must keep what
        // the reader sees now. Re-pick only on a user scroll or if it's gone.
        if !force, case .message(let id, _)? = lastReadingAnchor, let delta = visibleOffsetFromTop(of: id) {
            lastReadingAnchor = .message(id: id, offsetFromTop: delta)
            return
        }
        lastReadingAnchor = currentReadingAnchor()
    }

    /// A loaded, on-screen message's top relative to the viewport top.
    func visibleOffsetFromTop(of id: String) -> CGFloat? {
        guard let index = items.firstIndex(of: id), index < collectionView.numberOfItems(inSection: 0) else { return nil }
        let path = IndexPath(item: index, section: 0)
        guard collectionView.indexPathsForVisibleItems.contains(path),
              let frame = collectionView.layoutAttributesForItem(at: path)?.frame else { return nil }
        return frame.minY - (collectionView.contentOffset.y + collectionView.adjustedContentInset.top)
    }

    /// The message nearest the top of the viewport and its distance from it.
    func currentReadingAnchor() -> ReadingAnchor? {
        guard collectionView != nil else { return nil }
        let top = collectionView.contentOffset.y + collectionView.adjustedContentInset.top
        let candidates = collectionView.indexPathsForVisibleItems.compactMap { ip -> (String, CGFloat)? in
            guard ip.item < items.count,
                  let frame = collectionView.layoutAttributesForItem(at: ip)?.frame,
                  frame.maxY > top else { return nil }
            return (items[ip.item], frame.minY - top)
        }
        guard let best = candidates.min(by: { abs($0.1) < abs($1.1) }) else { return nil }
        return .message(id: best.0, offsetFromTop: best.1)
    }

    /// Drop every cached height and rendered body, lay the loaded window out
    /// again for the current width/text size, and put the reader back.
    func relayoutLoadedWindow(keeping anchor: ReadingAnchor?, reason: String) {
        cancelPageMeasurements()
        cancelPendingWarm()
        warmEnqueued.removeAll(keepingCapacity: true)
        appliedHeightIDs.removeAll(keepingCapacity: true)
        sizer.reset()
        TKLiveBody.discardAll()
        liveContentMemo = nil
        lastLiveCardHeight = nil
        collectionView.reloadData()
        collectionView.layoutIfNeeded()
        if case .message? = anchor, let anchor {
            widthAnchorGeneration += 1
            let generation = widthAnchorGeneration
            restore(anchor)
            // Background height measurement settles rows above the anchor
            // just after a full re-layout; follow it until the user scrolls.
            for delay in [0.1, 0.35, 0.8] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    guard let self, self.collectionView != nil, self.widthAnchorGeneration == generation,
                          !self.collectionView.isTracking, !self.collectionView.isDragging,
                          !self.collectionView.isDecelerating, !self.followingBottom else { return }
                    self.restore(anchor)
                }
            }
        } else if case .newest? = anchor {
            primeTailViewport()
            pinToBottom(reason: reason)
        }
        warmWindow()
        resumeBufferedPageMeasurements()
        updateJumpButtonVisibility()
    }

    func handleCodeHighlightReady() {
        pendingCodeHighlightRefresh = true
        scheduleCodeHighlightRefreshIfNeeded()
    }

    func scheduleCodeHighlightRefreshIfNeeded() {
        guard pendingCodeHighlightRefresh,
              collectionView != nil,
              !collectionView.isDragging,
              !collectionView.isTracking,
              !collectionView.isDecelerating else { return }
        codeHighlightSettleWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.refreshVisibleCodeHighlights()
        }
        codeHighlightSettleWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
    }

    func refreshVisibleCodeHighlights() {
        guard pendingCodeHighlightRefresh,
              !collectionView.isDragging,
              !collectionView.isTracking,
              !collectionView.isDecelerating else { return }
        pendingCodeHighlightRefresh = false
        codeHighlightSettleWork = nil

        for indexPath in collectionView.indexPathsForVisibleItems.sorted() {
            guard let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell,
                  cell.hasProvisionalCodeHighlight else { continue }
            let finalContent: TKBubbleContent?
            if let (message, card) = frozenRow(indexPath.item) {
                finalContent = TKBubbleContent.live(
                    card: card,
                    agent: agentName,
                    sessionId: sessionId,
                    steps: message.steps ?? 0,
                    isFrozen: true,
                    frozenTimestamp: message.finishedAt ?? message.timestamp,
                    attachments: message.contentRefAttachments
                )
            } else if indexPath.item < items.count,
                      let message = message(items[indexPath.item]) {
                TKBubbleContent.bust(message.id)
                finalContent = TKBubbleContent.make(
                    message: message,
                    sessionId: sessionId,
                    agent: agentName
                )
            } else {
                finalContent = nil
            }
            guard let finalContent, !finalContent.hasProvisionalCodeHighlight else { continue }
            cell.configure(finalContent, cellWidth: collectionView.bounds.width)
            cell.setBodyInteractive(true)
            cell.setNeedsLayout()
        }
    }
}
#endif
