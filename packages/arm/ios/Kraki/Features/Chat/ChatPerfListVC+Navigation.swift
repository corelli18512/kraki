/// Navigation targets: stepping back through AI replies, returning to the tail, unread-entry landing.

#if os(iOS)
import SwiftUI
import UIKit
import os

extension ChatPerfListVC {
    // MARK: Navigation targets (confirmed rule: step back through AI replies)

    /// Rows that count as "AI replies" for upward navigation: completed agent
    /// answers, frozen terminal cards and the streaming live card. User
    /// messages, system notices and errors are skipped.
    func isReplyItem(_ id: String) -> Bool {
        if id == Self.liveCardID { return true }
        guard let message = message(id) else { return false }
        return message.type == "agent_message"
            || message.type == "turn_status"
            || message.type == "interrupted_turn"
    }

    /// Content-space y of the reading line just below the top navigation glass.
    var readableTopY: CGFloat {
        collectionView.contentOffset.y + Self.latestMessageTopPadding - 8
    }

    func maximumOffsetY() -> CGFloat {
        max(-collectionView.adjustedContentInset.top,
            collectionView.contentSize.height - collectionView.bounds.height
                + tailAdjustedInsets.bottom)
    }

    func landingOffset(forRowStart minY: CGFloat) -> CGFloat {
        min(maximumOffsetY(), max(-collectionView.adjustedContentInset.top,
                                  minY - Self.latestMessageTopPadding))
    }

    /// Index of the reply whose start the ↑ control goes to: the nearest AI
    /// reply whose start lies above the reading line. If the reply being read
    /// has its start cut off, that is this reply; if its start is visible, it
    /// is the previous reply. Nil when no loaded reply qualifies.
    func previousReplyTarget() -> Int? {
        let line = readableTopY - 2
        var index = items.count - 1
        while index >= 0 {
            if isReplyItem(items[index]),
               let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame,
               frame.minY < line,
               landingOffset(forRowStart: frame.minY) < collectionView.contentOffset.y - 1 {
                return index
            }
            index -= 1
        }
        return nil
    }

    /// Distance to the end of the WHOLE conversation (not just the loaded
    /// window). Unloaded newer history counts as "not at bottom".
    var isAtConversationBottom: Bool {
        atNewest && distanceToBottom() <= 8
    }

    func noteArrivalsWhileAway(old: [String], new: [String]) {
        let known = Set(old)
        // Count replies the reader has not seen; the reader's own echoed
        // sends are not "new".
        let arrived = new.filter { id in
            guard !known.contains(id), id != Self.liveCardID, !id.contains(":pending:"),
                  let message = message(id) else { return false }
            return message.type != "user_message" && message.type != "send_input"
        }
        guard !arrived.isEmpty else { return }
        unseenArrivals += arrived.count
        refreshJumpButtonTitle()
    }

    func refreshJumpButtonTitle() {
        if unseenArrivals > 0 {
            unseenBadge.layer.borderColor = UIColor.systemBackground
                .resolvedColor(with: traitCollection).cgColor
            unseenBadge.isHidden = false
            jumpButton.accessibilityValue = String(localized: "\(unseenArrivals) new")
        } else {
            unseenBadge.isHidden = true
            jumpButton.accessibilityValue = nil
        }
    }

    /// The ↑/↓ controls keep the state they had before the list started
    /// moving (finger drag, momentum, a jump glide or its history load) and
    /// are re-evaluated once it settles, so they never flicker mid-scroll.
    var jumpControlsFrozen: Bool {
        collectionView.isDragging || collectionView.isDecelerating || scrollingToTop
            || scrollPolicy.navigationActive || navigationLoadInFlight
    }

    func updateJumpButtonVisibility() {
        guard collectionView != nil else { return }
        if isAtConversationBottom, unseenArrivals > 0 {
            unseenArrivals = 0
            refreshJumpButtonTitle()
        }
        guard !jumpControlsFrozen else { return }
        let showTail = !isAtConversationBottom
        // ↑ stays available at the bottom (resting in ↓'s slot) unless the
        // newest item is the user's own message: there is nothing new to read
        // back to yet, and a right-aligned user bubble sits under the slot.
        // Accepted trade-off (user-confirmed): at rest it may cover the bottom
        // trailing corner of a full-width AI reply. Mac parity (#330).
        let showUp = !(isAtConversationBottom && latestItemIsUser)
            && (previousReplyTarget() != nil || (!atOldest && hasLoadedWindow))
        let slotChanged = jumpButtonVisibilityTargets[ObjectIdentifier(jumpButton)] != showTail
        setJumpButtonVisibility(jumpButton, material: jumpButtonBlur, shouldShow: showTail)
        setJumpButtonVisibility(latestMessageStartButton, material: latestMessageStartButtonBlur,
                                shouldShow: showUp)
        if slotChanged { placeLatestStartButton(aboveTail: showTail) }
    }

    /// ↑ sits in ↓'s slot when ↓ is hidden; ↓ appearing pushes it up (and it
    /// drops back down when ↓ leaves), with a gentle spring.
    func placeLatestStartButton(aboveTail: Bool) {
        let constant = aboveTail ? -(Self.jumpControlSize + 8) : 0
        guard let constraint = latestStartBottomConstraint, constraint.constant != constant else { return }
        constraint.constant = constant
        guard view.window != nil,
              jumpButtonVisibilityTargets[ObjectIdentifier(latestMessageStartButton)] == true else {
            view.layoutIfNeeded(); return
        }
        UIView.animate(withDuration: 0.38, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0,
                       options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.view.layoutIfNeeded()
        }
    }

    func setJumpButtonVisibility(
        _ button: UIButton,
        material: UIVisualEffectView?,
        shouldShow: Bool
    ) {
        let key = ObjectIdentifier(button)
        guard jumpButtonVisibilityTargets[key] != shouldShow else { return }
        jumpButtonVisibilityTargets[key] = shouldShow
        let generation = (jumpButtonVisibilityGenerations[key] ?? 0) + 1
        jumpButtonVisibilityGenerations[key] = generation
        button.layer.removeAllAnimations()
        material?.layer.removeAllAnimations()
        if shouldShow {
            material?.isHidden = false
            button.isHidden = false
        }
        UIView.animate(
            withDuration: ChatScrollPolicy.navigationControlAnimationDurationSeconds
        ) { [weak button, weak material] in
            button?.alpha = shouldShow ? 1 : 0
            // Glass keeps its effect and full alpha (a faded glass view
            // renders opaque); it only appears/disappears via isHidden.
            if #available(iOS 26.0, *) {} else { material?.alpha = shouldShow ? 1 : 0 }
        } completion: { [weak self, weak button, weak material] finished in
            guard let self, let button,
                  finished,
                  self.jumpButtonVisibilityTargets[key] == shouldShow,
                  self.jumpButtonVisibilityGenerations[key] == generation else { return }
            if !shouldShow {
                button.isHidden = true
                material?.isHidden = true
            }
        }
    }

    @objc func onBottomTapped() {
        unseenArrivals = 0
        refreshJumpButtonTitle()
        jumpToLiveBottom(animated: true)
    }

    @objc func onLatestMessageStartTapped() {
        navigateToPreviousReplyStart()
    }

    /// ↑ control. Loads older history first when no loaded reply qualifies
    /// ("not loaded" is never treated as "none"), then glides to the target on
    /// exact geometry.
    func navigateToPreviousReplyStart() {
        if let target = previousReplyTarget() {
            glideToReplyStart(target)
            return
        }
        guard !atOldest, !navigationLoadInFlight else {
            updateJumpButtonVisibility()
            return
        }
        navigationLoadInFlight = true
        updateJumpButtonVisibility()
        let generation = pagingGeneration
        navigationLoadTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                self.navigationLoadInFlight = false
                self.updateJumpButtonVisibility()
            }
            for _ in 0..<8 {
                guard generation == self.pagingGeneration, !self.isLeavingView,
                      !self.collectionView.isTracking else { return }
                var moved = await self.vm.pageOlderRaw()
                if !moved {
                    // DB exhausted: the Relay history request lands later.
                    let before = self.vm.windowTopSeq
                    for _ in 0..<30 where !moved && !self.atOldest {
                        try? await Task.sleep(for: .milliseconds(50))
                        moved = self.vm.windowTopSeq != before
                    }
                }
                guard moved, generation == self.pagingGeneration,
                      !self.collectionView.isTracking else { return }
                self.refreshSpineSnapshot()
                let buffered = self.bufferedOlderCount()
                if buffered > 0 {
                    let width = self.collectionView.bounds.width
                    for message in self.messages.prefix(buffered) {
                        self.sizer.prime(message, width: width, notify: false)
                    }
                    self.applyEdges(reason: "nav-older")
                }
                if let target = self.previousReplyTarget() {
                    self.navigationLoadInFlight = false
                    self.glideToReplyStart(target)
                    return
                }
                if self.atOldest { return }
            }
        }
    }

    func glideToReplyStart(_ index: Int) {
        let width = collectionView.bounds.width
        sizer.prepare(width: width)
        // Exact geometry at the landing viewport before moving: the target and
        // the rows that will fill the screen below it. Their height changes
        // above the current viewport are anchor-compensated.
        let anchor = readingAnchor()
        let anchorID = anchor.flatMap { $0.0.item < items.count ? items[$0.0.item] : nil }
        var covered: CGFloat = 0
        var i = index
        var changed = false
        while i < items.count, covered < collectionView.bounds.height * 1.2 {
            if let message = message(items[i]) {
                if sizer.cached(message.id) == nil { changed = true }
                sizer.prime(message, width: width, notify: false)
                appliedHeightIDs.insert(message.id)
                covered += sizer.cached(message.id) ?? 0
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
            collectionView.layoutIfNeeded()
            if let anchor, let anchorID, let row = items.firstIndex(of: anchorID),
               let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: row, section: 0))?.frame {
                collectionView.contentOffset.y += frame.minY - anchor.1
            }
        }
        guard let frame = collectionView.layoutAttributesForItem(at: IndexPath(item: index, section: 0))?.frame else {
            return
        }
        scrollPolicy.beginLatestMessageStartNavigation()
        widthAnchorGeneration += 1  // a pending re-layout anchor restore must not undo it
        let target = landingOffset(forRowStart: frame.minY)
        let distance = abs(collectionView.contentOffset.y - target)
        updateJumpButtonVisibility()
        if distance > collectionView.bounds.height * 2.5 {
            // Long hops: jump most of the way instantly, then glide the last
            // stretch so the motion stays legible without animating across
            // dozens of screens.
            let direction: CGFloat = target < collectionView.contentOffset.y ? 1 : -1
            collectionView.contentOffset.y = target + direction * collectionView.bounds.height * 0.6
        }
        collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: target), animated: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            self?.endBottomGlide()
        }
    }

    #if DEBUG
    var automationUpTargetItem: Int? { previousReplyTarget() }
    var automationItemIDs: [String] { items }
    func automationTapUp() { navigateToPreviousReplyStart() }
    func automationTapDown() { onBottomTapped() }
    var automationControlsVisible: (up: Bool, down: Bool) {
        (jumpButtonVisibilityTargets[ObjectIdentifier(latestMessageStartButton)] == true,
         jumpButtonVisibilityTargets[ObjectIdentifier(jumpButton)] == true)
    }
    var automationUnseenArrivals: Int { unseenArrivals }
    /// Control frames in the list controller's view.
    var automationControlFrames: (up: CGRect, down: CGRect) {
        view.layoutIfNeeded()
        return (latestMessageStartButton.convert(latestMessageStartButton.bounds, to: view),
                jumpButton.convert(jumpButton.bounds, to: view))
    }
    var automationJumpControlSizes: (up: CGSize, down: CGSize) {
        view.layoutIfNeeded()
        return (latestMessageStartButton.bounds.size, jumpButton.bounds.size)
    }
    var automationUnseenDotVisible: Bool { !unseenBadge.isHidden }
    var automationJumpControlFrames: (up: CGRect, down: CGRect) {
        view.layoutIfNeeded()
        return (latestMessageStartButton.frame, jumpButton.frame)
    }
    #endif

    /// Re-anchor at the chat's true newest end, then pin the viewport to the
    /// bottom. Without the window reset, ↓Bottom would only reach the bottom of
    /// whatever window paging happens to have loaded — not the whole chat's
    /// newest message. Mirrors the sim-validated test-page `reanchorNewest`.
    ///
    /// PREFER sliding the already-loaded tail UP to the head (`pageNewerRaw`
    /// extends the bottom while the px-cap trims the top): this keeps the warm,
    /// already-measured ~14-screen window, so the jump glides over real content
    /// with no cold-cell refill. `jumpToHead` (nuke + reload the compact tail)
    /// collapses the window to a 1-2 turn stub, and the paging engine then
    /// storms ~13 screens of cold older-refill (~20 × 30ms hitches) — so it's
    /// used only when there's no window yet or the gap is too big to bridge.
    static let reanchorSlideMaxGap = 2000     // seqs; bigger ⇒ jumpToHead
    static let reanchorSlideMaxPages = 12      // safety cap on the slide loop
    func reanchorNewest() {
        let head = vm.sessionLastSeq
        let bottom = vm.windowBottomSeq
        let gap = head - bottom
        if bottom > 0, head > 0, gap <= Self.reanchorSlideMaxGap {
            var iter = 0
            while vm.windowBottomSeq < head, iter < Self.reanchorSlideMaxPages {
                guard vm.pageNewerRaw() else { break }   // DB exhausted → WS will fill
                iter += 1
            }
            chatPerfLog.log("[reanchor] slide gap=\(gap) iters=\(iter)")
        } else {
            vm.jumpToHead()                              // no window / large gap → instant reload
            chatPerfLog.log("[reanchor] jumpToHead gap=\(gap)")
        }
        refreshSpineSnapshot()                       // rebuild turns/byId/seqMap from it
        items = ids
        // Drop any in-flight paging so the freshly-anchored window can't be
        // clobbered by a stale fetch/apply that targeted the old window.
        pagingGeneration += 1
        cancelPageMeasurements()
        pendingApply = nil
        fetchingOlder = false
        fetchingNewer = false
        loadingOlder = hasLoadedWindow && !atOldest
        loadingNewer = showsNewerSpinner
        collectionView.reloadData()
        primeTailViewport()
        warmWindow()
        lastReason = "reanchor"
        updateOverlay()
        chatPerfLog.log("[reanchor] win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] n=\(items.count) atNewest=\(atNewest)")
    }

    func jumpToLiveBottom(animated: Bool) {
        scrollPolicy.beginTailNavigation(
            offset: collectionView.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
        widthAnchorGeneration += 1  // a pending re-layout anchor restore must not undo it
        // Suppress edge paging for the duration of the glide: right after the
        // reanchor's reloadData the offset is 0 (tail window's TOP), and any
        // scroll callback there would fire an older-fetch that drags the window
        // back up before the animation reaches the bottom. Cleared on animation
        // end / user touch / a safety timeout.
        if !atNewest {
            reanchorNewest()
        } else {
            chatPerfLog.log("[bottom] already-newest scroll")
        }
        if animated {
            updateJumpButtonVisibility()
            if distanceToBottom() > collectionView.bounds.height * 2.5 {
                collectionView.contentOffset.y = maximumOffsetY() - collectionView.bounds.height * 0.6
            }
            scrollToBottom(animated: true)
            // Guarantee the gate lifts even if no didEndScrollingAnimation fires
            // (e.g. the target was already visible so UIKit skipped the anim).
            DispatchQueue.main.asyncAfter(
                deadline: .now() + 1.2
            ) { [weak self] in
                self?.endBottomGlide()
            }
        } else {
            scrollToBottom(animated: false)
            scrollPolicy.endNavigation()
            updateJumpButtonVisibility()
        }
    }

    /// Confirmed rule: sending a new message returns to the bottom of the whole
    /// conversation, regardless of where the reader was. The optimistic bubble
    /// is materialized first so the glide lands on it.
    func returnToNewestAfterLocalSubmit() {
        scrollPolicy.cancelUnreadEntry()
        navigationLoadTask?.cancel()
        navigationLoadInFlight = false
        syncLiveUpdates()
        // The controls must not ride over the message being sent: ↓ goes now
        // (we are heading to the bottom) and ↑ drops to the low slot, hidden
        // while the newest item is the user's own message. Applied before the
        // glide freezes control updates. Mac parity (#330).
        setJumpButtonVisibility(jumpButton, material: jumpButtonBlur, shouldShow: false)
        setJumpButtonVisibility(latestMessageStartButton, material: latestMessageStartButtonBlur, shouldShow: false)
        placeLatestStartButton(aboveTail: false)
        unseenArrivals = 0
        refreshJumpButtonTitle()
        if isAtConversationBottom {
            scrollPolicy.pinToTail(observedOffset: collectionView.contentOffset.y)
            return
        }
        jumpToLiveBottom(animated: true)
    }

    /// Lift the ↓Bottom paging gate and resume normal edge paging at rest.
    func endBottomGlide() {
        guard suppressPagingForBottom else { return }
        scrollPolicy.endNavigation()
        chatPerfLog.log("[bottom] glide-end win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] off=\(Int(collectionView.contentOffset.y))")
        settleEdges()
        updateOverlay()
        updateJumpButtonVisibility()
        updateJumpButtonVisibility()
    }

    func applyFrontShift(_ delta: CGFloat, gestureDelta: CGFloat? = nil) {
        let gestureDelta = gestureDelta ?? delta
        guard delta != 0 || gestureDelta != 0 else { return }
        let dragging = collectionView.isDragging || collectionView.isTracking
        applyingProgrammaticShift = true
        collectionView.contentOffset.y += delta
        applyingProgrammaticShift = false
        // Re-base the direction baseline: compensation is not user movement.
        scrollPolicy.rememberOffset(collectionView.contentOffset.y)
        if dragging {
            // Finger is down: next touch-move would recompute the offset as
            // (touchDownOffset − translation) and erase our write. Push the
            // translation baseline by the same delta so the recompute keeps
            // our shift — the gesture is never cut, the drag stays live.
            // (offset = touchDownOffset − translation ⇒ to raise offset by
            // delta we lower translation by delta.)
            // The gesture baseline must absorb the whole content shift, including
            // any part UIKit already applied to the offset during the batch.
            let pan = collectionView.panGestureRecognizer
            var t = pan.translation(in: collectionView)
            t.y -= gestureDelta
            pan.setTranslation(t, in: collectionView)
        }
    }

    /// Run `work` ONLY at true rest; otherwise stash it until the list fully
    /// settles. `work` here is the heavy STEP-2 path (full-window snapshot refresh +
    /// reconcile + measure + apply), so unlike a cheap offset write it must NOT
    /// run on a scroll frame — neither during an active finger drag NOR during
    /// coasting deceleration NOR under a status-bar scroll-to-top. Deferring to
    /// rest keeps the ~30-40ms grouping behind the spinner, off every scroll
    /// frame. The stash is flushed by the motion-stop delegates.
    func applyWhenStable(_ work: @escaping () -> Void) {
        if collectionView.isDragging || collectionView.isDecelerating || scrollingToTop {
            pendingApply = work
        } else {
            work()
        }
    }

    func flushPendingApply() {
        guard !isLeavingView, viewIfLoaded?.window != nil,
              collectionView.bounds.width > 0,
              !collectionView.isDragging,
              !collectionView.isDecelerating,
              !scrollingToTop,
              let work = pendingApply else { return }
        sizer.prepare(width: collectionView.bounds.width)
        // A Relay history response can extend the buffered edge after this
        // apply was first deferred. Never let that larger, colder buffer slip
        // through the old barrier and synchronously self-size in applyEdges.
        //
        // An in-flight edge owns the completion that will call us again. Do not
        // ask the opposite, already-warm edge to install another barrier here:
        // `measurePage` completes a warm page synchronously, which used to loop
        // back through finish → flush while the first edge was still measuring
        // and eventually overflow the main-thread stack.
        if measuringOlderPage || measuringNewerPage { return }
        if bufferedOlderNeedsMeasurement() || bufferedNewerNeedsMeasurement() {
            resumeBufferedPageMeasurements()
            return
        }
        pendingApply = nil
        work()
    }
}
#endif
