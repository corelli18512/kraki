/// User scrolling: scroll interaction begin/settle, keys, the wheel, clip view reflection, older-page prefetch, edge paging, automation hooks.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatScrollView {
    func beginScrollInteraction(scrollerKnob: Bool) {
        scrollSettleWorkItem?.cancel()
        scrollSettleWorkItem = nil
        scrollSettlePending = false
        geometryAnchorLock = nil
        hasUserScrolled = true
        sendTailLock = false
        scrollPolicy.beginUserInteraction(
            offset: contentView.bounds.minY,
            distanceToBottom: distanceToBottom
        )
        if scrollerKnob {
            knobScrollActive = true
        } else {
            liveScrollActive = true
        }
        chatDocumentView.beginScrollInteraction(scrollerKnob: knobScrollActive)
    }

    func endScrollInteraction(scrollerKnob: Bool) {
        if scrollerKnob {
            knobScrollActive = false
            // A missing live-scroll-end may have overlapped a scrollbar drag.
            // The watchdog deliberately yields while the knob owns geometry;
            // re-arm it once knob tracking finishes so the live state cannot
            // remain fenced forever.
            if liveScrollActive { notePreciseScrollActivity() }
        } else {
            liveScrollActive = false
            scrollInteractionWatchdogWorkItem?.cancel()
            scrollInteractionWatchdogWorkItem = nil
            scrollActivityGeneration += 1
        }
        scheduleScrollSettleIfIdle()
    }

    func notePreciseScrollActivity() {
        scrollActivityGeneration += 1
        let generation = scrollActivityGeneration
        scrollInteractionWatchdogWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self,
                  generation == self.scrollActivityGeneration else { return }
            self.scrollInteractionWatchdogWorkItem = nil
            guard self.liveScrollActive, !self.knobScrollActive else { return }
            self.liveScrollActive = false
            let sessionPrefix = self.representedSessionId.map { String($0.prefix(12)) } ?? "none"
            let health = self.chatDocumentView.presentationHealth(in: self.contentView.bounds)
            KLog.chatEntry(
                "mac-watchdog session=\(sessionPrefix) "
                    + "reason=missing-live-scroll-end placeholders=\(health.placeholderSeqs.count) "
                    + "unmaterialized=\(health.unmaterializedSeqs.count)"
            )
            self.scheduleScrollSettleIfIdle()
        }
        scrollInteractionWatchdogWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
    }

    func scheduleScrollSettleIfIdle() {
        guard !hasDirectScrollInteraction else {
            settleScrollInteractionIfIdle()
            return
        }
        scrollSettleWorkItem?.cancel()
        scrollSettlePending = true
        // AppKit may emit didEndLiveScroll between two adjacent trackpad
        // phases. Keep the list in scroll-protection mode across that tiny gap
        // so a live Markdown revision cannot start a 60 Hz height animation or
        // atomic snapshot immediately before the next gesture packet arrives.
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.scrollSettleWorkItem = nil
            self.scrollSettlePending = false
            self.settleScrollInteractionIfIdle()
        }
        scrollSettleWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: work)
    }

    func settleScrollInteractionIfIdle() {
        if hasDirectScrollInteraction {
            chatDocumentView.beginScrollInteraction(scrollerKnob: knobScrollActive)
            return
        }
        if scrollSettlePending { return }
        DispatchQueue.main.async { [weak self] in self?.updateJumpButtonVisibility(animated: true) }
        thumbViewportGeneration += 1
        thumbViewportUpdateScheduled = false
        commitWarmedHeightsPreservingViewport(restartWarmup: true)
        // Materialize only the actual landing viewport. A normal half-screen
        // runway can include several huge cold Markdown rows and synchronously
        // stall the first settled frame for hundreds of milliseconds.
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds, runwayOverride: 0)
        adoptStableGeometryAnchorIfNeeded()
        let settledHealth = chatDocumentView.presentationHealth(in: contentView.bounds)
        if !settledHealth.unresolvedSeqs.isEmpty {
            emitPresentationLog(reason: "settled-unresolved", force: true)
            schedulePresentationHealthCheck()
        }
        if deferredEdgePaging {
            deferredEdgePaging = false
            driveEdgePagingIfNeeded(in: contentView)
        }
        scrollPolicy.endUserInteraction()
    }

    /// Keyboard focus for scrolling when the clicked bubble's text goes away
    /// (its cell is recycled): an invisible view whose keys reach `keyDown`.
    func takeKeyboardFocus() {
        if keyboardFocusView.superview !== self { addSubview(keyboardFocusView) }
        window?.makeFirstResponder(keyboardFocusView)
    }

    override func keyDown(with event: NSEvent) {
        let page = max(40, contentView.bounds.height - max(verticalPageScroll, 40))
        let line = max(verticalLineScroll * 3, 36)
        guard let action = MacChatKeyboardScroll.action(keyCode: event.keyCode, modifiers: event.modifierFlags,
                                                        page: page, line: line) else {
            super.keyDown(with: event)
            return
        }
        keyboardScroll(action)
    }

    func keyboardScroll(_ action: MacChatKeyboardScroll) {
        cancelScrollAnimation()
        switch action {
        case .bottom:
            scrollToBottom(animated: true)
        case .top:
            discreteScroll(to: -contentInsets.top, direction: .older)
        case .by(let delta):
            discreteScroll(to: contentView.bounds.minY + delta, direction: delta < 0 ? .older : .newer)
        }
    }

    /// One discrete move (a key, or an automation wheel tick), clamped to
    /// the document.
    func discreteScroll(to proposedY: CGFloat, direction: ChatScrollPolicy.Direction) {
        geometryAnchorLock = nil
        hasUserScrolled = true
        if direction == .older { sendTailLock = false }
        scrollPolicy.beginUserInteraction(
            offset: contentView.bounds.minY,
            distanceToBottom: distanceToBottom
        )
        scrollPolicy.recordUserIntent(
            direction,
            offset: contentView.bounds.minY,
            distanceToBottom: distanceToBottom
        )
        resetSmoothWheelAnimation()
        let minimumY = -contentInsets.top
        let maximumY = max(
            minimumY,
            chatDocumentView.frame.height - contentView.bounds.height
        )
        discreteWheelActive = true
        chatDocumentView.beginScrollInteraction(scrollerKnob: false)
        contentView.bounds.origin.y = min(maximumY, max(minimumY, proposedY))
        reflectScrolledClipView(contentView)
        discreteWheelActive = false
        settleScrollInteractionIfIdle()
    }

    #if DEBUG
    func automationSimulateMissingLiveScrollEnd(overlapScrollerKnob: Bool = false) {
        beginScrollInteraction(scrollerKnob: false)
        notePreciseScrollActivity()
        guard overlapScrollerKnob else { return }
        beginScrollInteraction(scrollerKnob: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) { [weak self] in
            self?.endScrollInteraction(scrollerKnob: true)
        }
    }
    #endif

    func preparePreciseScrollDelta(_ deltaY: CGFloat) {
        cancelScrollAnimation()
        if abs(deltaY) > 0.01 { sendTailLock = false }
        geometryAnchorLock = nil
        hasUserScrolled = true
        if !liveScrollActive { beginScrollInteraction(scrollerKnob: false) }
        if deltaY > 0.01 {
            scrollPolicy.recordUserIntent(
                .older,
                offset: contentView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
        } else if deltaY < -0.01 {
            scrollPolicy.recordUserIntent(
                .newer,
                offset: contentView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
        }
        notePreciseScrollActivity()
    }

    #if DEBUG
    /// Drives one pixel-precise packet through the production interaction,
    /// paging, virtualization, and watchdog paths without posting a global
    /// CGEvent or taking keyboard/mouse focus from the operator. AppKit ignores
    /// an unattached synthetic precise NSEvent on its native scroll path, so
    /// the Debug gate applies the same clamped offset that NSClipView would.
    func automationPreciseScrollPacket(deltaY: CGFloat) -> (before: CGFloat, after: CGFloat) {
        preparePreciseScrollDelta(deltaY)
        let before = contentView.bounds.minY
        let minimumY = -contentInsets.top
        let maximumY = max(
            minimumY,
            chatDocumentView.frame.height - contentView.bounds.height
        )
        contentView.bounds.origin.y = min(
            maximumY,
            max(minimumY, before - deltaY)
        )
        reflectScrolledClipView(contentView)
        return (before, contentView.bounds.minY)
    }
    #endif

    @discardableResult
    func automationScrollToBubble(seq: Int, screenY: CGFloat = 96) -> Bool {
        guard let frame = chatDocumentView.frame(forSeq: seq) else { return false }
        geometryAnchorLock = nil
        hasUserScrolled = true
        resetSmoothWheelAnimation()
        scrollPolicy.leaveTailForUserNavigation(offset: contentView.bounds.minY)
        let minimumY = -contentInsets.top
        let maximumY = max(minimumY, chatDocumentView.tailHeight - contentView.bounds.height)
        contentView.bounds.origin.y = min(maximumY, max(minimumY, frame.minY - screenY))
        super.reflectScrolledClipView(contentView)
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds, runwayOverride: 0)
        return true
    }

    func automationScroll(direction: String, ticks: Int) -> (before: CGFloat, after: CGFloat) {
        let before = contentView.bounds.minY
        let distance = CGFloat(max(ticks, 1)) * max(verticalLineScroll * 3, 36)
        if direction == "up" || direction == "down" {
            discreteScroll(to: before + (direction == "down" ? distance : -distance),
                           direction: direction == "down" ? .newer : .older)
        }
        return (before, contentView.bounds.minY)
    }

    override func scrollWheel(with event: NSEvent) {
        cancelScrollAnimation()
        geometryAnchorLock = nil
        hasUserScrolled = true
        let hasScrollDelta = abs(event.scrollingDeltaY) > 0.01
            || abs(event.scrollingDeltaX) > 0.01
        if hasScrollDelta {
            sendTailLock = false
            scrollPolicy.beginUserInteraction(
                offset: contentView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
        }
        if event.hasPreciseScrollingDeltas, hasScrollDelta {
            preparePreciseScrollDelta(event.scrollingDeltaY)
        } else if event.scrollingDeltaY > 0.01 {
            scrollPolicy.recordUserIntent(
                .older,
                offset: contentView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
        } else if event.scrollingDeltaY < -0.01 {
            scrollPolicy.recordUserIntent(
                .newer,
                offset: contentView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
        }
        super.scrollWheel(with: event)
    }

    override func reflectScrolledClipView(_ clipView: NSClipView) {
        guard !isDeallocating else {
            super.reflectScrolledClipView(clipView)
            return
        }
        let started = CACurrentMediaTime()
        if NSApp.currentEvent?.type == .leftMouseDragged {
            // Knob-start captured the comparison baseline. Reflection may run
            // once per drag packet, so only release entry protection here.
            scrollPolicy.unlockForUserInteraction()
        }
        super.reflectScrolledClipView(clipView)
        // `MacChatDocumentView.apply` changes the document frame before the
        // representable restores its anchor. Ignore AppKit's synchronous
        // reflection of that intermediate geometry; the atomic snapshot emits
        // one final reflect after the anchor and cells are settled.
        if snapshotApplyActive { return }
        if chatDocumentView.scrollerKnobTracking {
            scrollPolicy.observeUserOffset(
                clipView.bounds.minY,
                distanceToBottom: distanceToBottom
            )
            scheduleThumbViewportUpdate()
            deferredEdgePaging = true
            scrollPolicy.refreshFollowingTail(distanceToBottom: distanceToBottom)
            updateJumpButtonVisibility(animated: false)
            return
        }
        let oldHeight = chatDocumentView.frame.height
        let runwayOverride: CGFloat? = suppressRunwayForNextReflect ? 0 : nil
        suppressRunwayForNextReflect = false
        let anchorShift = chatDocumentView.updateVisibleCells(
            in: clipView.bounds,
            runwayOverride: runwayOverride
        )
        if (followingBottom || isEntryBottomLocked) && !bottomGlideActive {
            let delta = chatDocumentView.frame.height - oldHeight
            if abs(delta) > 0.5 {
                clipView.bounds.origin.y += delta
                super.reflectScrolledClipView(clipView)
            }
        } else if abs(anchorShift) > 0.5 {
            clipView.bounds.origin.y += anchorShift
            super.reflectScrolledClipView(clipView)
        }
        if clipView === contentView { applyUnreadEntryAfterGeometryChange() }
        if isScrollInteractionActive {
            // Prefetch as soon as a live trackpad/wheel gesture reaches the
            // edge. Waiting for didEndLiveScroll makes long momentum gestures
            // appear stuck at the top even though history is available.
            deferredEdgePaging = true
            driveEdgePagingIfNeeded(in: clipView)
        } else {
            driveEdgePagingIfNeeded(in: clipView)
        }
        scrollPolicy.rememberOffset(clipView.bounds.minY)
        scrollPolicy.refreshFollowingTail(distanceToBottom: distanceToBottom)
        updateJumpButtonVisibility(animated: true)
        let elapsedMs = (CACurrentMediaTime() - started) * 1_000
        if elapsedMs >= 8 {
            MacChatPerf.log(
                "reflect interaction=\(isScrollInteractionActive ? 1 : 0) "
                    + "offset=\(Int(clipView.bounds.minY)) document=\(Int(chatDocumentView.frame.height)) "
                    + "ms=\(String(format: "%.1f", elapsedMs))"
            )
        }
    }

    func scheduleThumbViewportUpdate() {
        guard !thumbViewportUpdateScheduled else { return }
        thumbViewportUpdateScheduled = true
        let generation = thumbViewportGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 60.0) { [weak self] in
            guard let self else { return }
            self.thumbViewportUpdateScheduled = false
            guard generation == self.thumbViewportGeneration,
                  self.chatDocumentView.scrollerKnobTracking else { return }
            _ = self.chatDocumentView.updateVisibleCells(in: self.contentView.bounds)
        }
    }

    func prefetchOlderIfNeeded(proposedY: CGFloat) {
        let distanceToOlderEdge = max(0, proposedY + contentInsets.top)
        if scrollPolicy.shouldRequestOlderPage(
            distanceToOlderEdge: distanceToOlderEdge,
            viewportLength: contentView.bounds.height,
            hasOlder: !diagnosticAtOldest,
            isLoading: loadingOlder
        ) {
            onScrolledNearTop?()
        }
    }

    func driveEdgePagingIfNeeded(in clipView: NSClipView) {
        // A completed prepend should move the preserved anchor safely away from
        // the trigger band. Require that departure before another page can
        // fire; this prevents store expansion from releasing its single-flight
        // guard and immediately loading a second page against stale geometry.
        prefetchOlderIfNeeded(proposedY: clipView.bounds.minY)
        if scrollPolicy.shouldRequestNewerPage(
            distanceToNewerEdge: distanceToBottom,
            hasNewer: hasUnloadedNewer,
            isLoading: loadingNewer
        ) {
            onScrolledNearBottom?()
        }
    }

    #if DEBUG
    var automationControlsVisible: (up: Bool, down: Bool) {
        (jumpButtonVisibilityTargets[ObjectIdentifier(latestStartButton)] == true,
         jumpButtonVisibilityTargets[ObjectIdentifier(jumpButton)] == true)
    }
    var automationUnseenDotVisible: Bool { !unseenDot.isHidden }
    var automationUpTargetKey: String? { previousReplyTarget() }
    var automationControlFrames: (up: NSRect, down: NSRect, dot: NSRect) {
        (latestStartButton.frame, jumpButton.frame, unseenDot.frame)
    }
    func automationTapUp() { latestStartTapped() }
    /// Clicks a question choice through the same window-point hit test and
    /// dispatch a real mouse click uses.
    func automationClickQuestionChoice(_ answer: String) -> Bool {
        for (_, cell) in chatDocumentView.automationVisibleCells {
            guard let point = cell.automationChoiceWindowPoint(answer),
                  let target = chatDocumentView.actionHitTarget(atWindowPoint: point) else { continue }
            dispatchBubbleAction(target)
            return true
        }
        return false
    }
    func automationTapDown() { jumpTapped() }
    var automationWindowRange: (top: Int, bottom: Int)? {
        guard diagnosticWindowTop > 0,
              diagnosticWindowBottom >= diagnosticWindowTop else { return nil }
        return (diagnosticWindowTop, diagnosticWindowBottom)
    }
    #endif

    var edgePagingDiagnostics: [String: Any] {
        var result: [String: Any] = [
            "allowsEdgePaging": allowsEdgePaging,
            "windowTop": diagnosticWindowTop,
            "windowBottom": diagnosticWindowBottom,
            "atOldest": diagnosticAtOldest,
            "atNewest": diagnosticAtNewest,
            "olderEdgeArmed": olderEdgeArmed,
            "olderPageConsumed": scrollPolicy.olderPageConsumed,
            "policyInteractionActive": scrollPolicy.interactionActive,
            "policyInteractionGeneration": scrollPolicy.interactionGeneration,
            "navigationActive": scrollPolicy.navigationActive,
            "loadingOlder": loadingOlder,
            "loadingNewer": loadingNewer,
            "hasUnloadedNewer": hasUnloadedNewer,
            "suppressNewerPagingAfterOlder": suppressNewerPagingAfterOlder,
            "hasUserScrolled": hasUserScrolled,
            "discreteWheelActive": discreteWheelActive,
            "liveScrollActive": liveScrollActive,
            "scrollSettlePending": scrollSettlePending,
            "scrollWatchdogPending": scrollInteractionWatchdogWorkItem != nil,
        ]
        if let geometryAnchorLock,
           let frame = chatDocumentView.frame(forKey: geometryAnchorLock.key) {
            result["geometryAnchorDelta"] = Double(geometryAnchorLock.delta)
            result["geometryAnchorScreenY"] = Double(frame.minY - contentView.bounds.minY)
        }
        return result
    }

    var distanceToBottom: CGFloat {
        max(0, chatDocumentView.tailHeight - contentView.bounds.maxY)
    }

    var isPinnedToBottom: Bool {
        sendTailLock || scrollPolicy.isPinnedToTail(distanceToBottom: distanceToBottom)
    }
    var isEntryBottomLocked: Bool { entryBottomLocked }
}
/// Page Up/Down, Home/End and ↑/↓ in the chat (no modifier).
enum MacChatKeyboardScroll: Equatable {
    case by(CGFloat)
    case top
    case bottom

    static func action(keyCode: UInt16, modifiers: NSEvent.ModifierFlags, page: CGFloat, line: CGFloat) -> Self? {
        guard modifiers.intersection([.command, .option, .control, .shift]).isEmpty else { return nil }
        switch keyCode {
        case 116: return .by(-page)
        case 121: return .by(page)
        case 126: return .by(-line)
        case 125: return .by(line)
        case 115: return .top
        case 119: return .bottom
        default: return nil
        }
    }
}
/// Takes keyboard focus for the chat without taking clicks or a Tab stop.
final class MacChatKeyboardFocusView: NSView {
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
#endif
