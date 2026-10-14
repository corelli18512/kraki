#if os(iOS)
import UIKit

/// Re-laying out bubbles that are already on screen: after a code block's
/// syntax highlight finishes, and after the user changes the text size.
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
        guard TKTextSize.refresh(), collectionView != nil else { return }
        let anchorItem = followingBottom ? nil : collectionView.indexPathsForVisibleItems.min()
        cancelPageMeasurements()
        cancelPendingWarm()
        warmEnqueued.removeAll(keepingCapacity: true)
        appliedHeightIDs.removeAll(keepingCapacity: true)
        sizer.reset()
        TKLiveBody.discardAll()
        liveContentMemo = nil
        lastLiveCardHeight = nil
        collectionView.reloadData()
        if let anchorItem, anchorItem.item < collectionView.numberOfItems(inSection: 0) {
            collectionView.layoutIfNeeded()
            collectionView.scrollToItem(at: anchorItem, at: .top, animated: false)
        } else {
            primeTailViewport()
            pinToBottom(reason: "text-size")
        }
        warmWindow()
        resumeBufferedPageMeasurements()
        updateJumpButtonVisibility()
        chatPerfLog.log("[text-size] relayout size=\(TKTextSize.key) items=\(items.count)")
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
