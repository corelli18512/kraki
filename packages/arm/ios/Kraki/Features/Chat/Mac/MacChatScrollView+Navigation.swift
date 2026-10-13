/// The ↑/↓ jump controls: stepping back through replies, returning to the newest edge, the unseen dot, initial bottom.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatScrollView {
    /// Anything submitted from the composer is a new message (as on iOS):
    /// return to the newest edge so the user sees what they just sent.
    func returnToNewestAfterLocalSubmit() {
        scrollPolicy.cancelUnreadEntry()
        sendTailLock = true
        jumpTapped()
        // The controls must not ride over the message being sent: ↓ goes now
        // (we are heading to the bottom) and ↑ rests in the low slot, hidden
        // while the latest item is the user's own message.
        setJumpButtonVisibility(jumpButton, material: jumpMaterial, shouldShow: false, animated: true)
        setJumpButtonVisibility(latestStartButton, material: latestStartMaterial, shouldShow: false, animated: true)
        placeLatestStart(raised: false, animated: false)
        syncUnseenDot()
    }

    @objc func jumpTapped() {
        unseenReplies = 0
        cancelNavigationLoad()
        geometryAnchorLock = nil
        scrollPolicy.beginTailNavigation(
            offset: contentView.bounds.minY,
            distanceToBottom: distanceToBottom
        )
        // Always act on the live AppKit list immediately. Previously the button
        // only set a flag for the next SwiftUI update; when the model was already
        // at authoritative head no update occurred, so the button did nothing.
        scrollToBottom(animated: true)
        onJumpToLatest?()
        DispatchQueue.main.asyncAfter(
            deadline: .now() + ChatScrollPolicy.navigationSafetyTimeoutSeconds
        ) { [weak self] in
            guard let self else { return }
            self.scrollPolicy.endNavigation()
            self.updateJumpButtonVisibility(animated: false)
        }
    }

    @objc func latestStartTapped() {
        sendTailLock = false
        navigateToPreviousReplyStart()
    }

    // MARK: Navigation targets (confirmed rule, as on iOS: step back through AI replies)

    /// Content-space y of the reading line just below the top chrome.
    var readableTopY: CGFloat {
        contentView.bounds.minY + latestMessageTopPadding - 8
    }

    func landingOffset(forRowStart minY: CGFloat) -> CGFloat {
        let minimumY = -topContentInset
        let maximumY = max(minimumY, chatDocumentView.tailHeight - contentView.bounds.height)
        return min(maximumY, max(minimumY, minY - latestMessageTopPadding))
    }

    /// The reply whose start ↑ goes to: the nearest AI reply whose start lies
    /// above the reading line. If the reply being read has its start cut off,
    /// that is this reply; if its start is visible, it is the previous one.
    func previousReplyTarget() -> String? {
        let line = readableTopY - 2
        let current = contentView.bounds.minY
        for reply in chatDocumentView.replyFrames.reversed()
        where reply.frame.minY < line && landingOffset(forRowStart: reply.frame.minY) < current - 1 {
            return reply.key
        }
        return nil
    }

    func cancelNavigationLoad() {
        navigationLoadGeneration &+= 1
        navigationLoadInFlight = false
    }

    /// ↑ control. When no loaded reply qualifies, older history is loaded
    /// first ("not loaded" is never treated as "none"), then the glide lands
    /// on the reply start.
    func navigateToPreviousReplyStart() {
        if let key = previousReplyTarget() {
            glideToReplyStart(key)
            return
        }
        guard !diagnosticAtOldest, !navigationLoadInFlight else {
            updateJumpButtonVisibility(animated: true)
            return
        }
        navigationLoadInFlight = true
        navigationLoadGeneration &+= 1
        updateJumpButtonVisibility(animated: true)
        pollNavigationLoad(generation: navigationLoadGeneration, pagesRequested: 0, lastTop: diagnosticWindowTop, waited: 0)
    }

    func pollNavigationLoad(generation: Int, pagesRequested: Int, lastTop: Int, waited: Int) {
        guard generation == navigationLoadGeneration, navigationLoadInFlight else { return }
        if let key = previousReplyTarget() {
            navigationLoadInFlight = false
            glideToReplyStart(key)
            return
        }
        var pages = pagesRequested
        var top = lastTop
        var waitedMs = waited
        if pages == 0 || (diagnosticWindowTop != top && !loadingOlder) {
            // Request (another) older page: the previous one landed without a
            // qualifying reply, or this is the first request.
            guard !diagnosticAtOldest, pages < 8 else {
                navigationLoadInFlight = false
                updateJumpButtonVisibility(animated: true)
                return
            }
            top = diagnosticWindowTop
            pages += 1
            waitedMs = 0
            onScrolledNearTop?()
        } else if waitedMs > 3_000 {
            navigationLoadInFlight = false
            updateJumpButtonVisibility(animated: true)
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.pollNavigationLoad(generation: generation, pagesRequested: pages, lastTop: top, waited: waitedMs + 50)
        }
    }

    func glideToReplyStart(_ key: String) {
        geometryAnchorLock = nil
        scrollPolicy.beginLatestMessageStartNavigation()
        updateJumpButtonVisibility(animated: true)
        animateScroll(to: { [weak self] in
            guard let self, let frame = self.chatDocumentView.frame(forKey: key) else {
                return self?.contentView.bounds.minY ?? 0
            }
            return self.landingOffset(forRowStart: frame.minY)
        }, completion: { [weak self] in
            guard let self else { return }
            self.scrollPolicy.endNavigation()
            self.updateJumpButtonVisibility(animated: true)
        })
    }

    func completeLatestStartJump() {
        latestStartJumpPending = false
        scrollPolicy.endNavigation()
        navigateToPreviousReplyStart()
    }

    func latestMessageStartTarget() -> CGFloat? {
        guard let frame = chatDocumentView.latestItemFrame() else { return nil }
        let minimumY = -topContentInset
        let maximumY = max(
            minimumY,
            chatDocumentView.tailHeight - contentView.bounds.height
        )
        let desired = frame.minY - latestMessageTopPadding
        return min(maximumY, max(minimumY, desired))
    }

    func syncUnseenDot() {
        unseenDot.isHidden = unseenReplies == 0
            || jumpButtonVisibilityTargets[ObjectIdentifier(jumpButton)] != true
    }

    func noteAppendedReplies(_ count: Int, readerWasAtBottom: Bool) {
        guard count > 0, !readerWasAtBottom else { return }
        unseenReplies += count
    }

    /// End of the WHOLE conversation (unloaded newer history counts as not).
    /// While the list is following the newest edge it is (or is gliding to
    /// be) at the bottom; content that just arrived must not flash ↓/↑ for
    /// the few frames before the pin or arrival glide catches up.
    var isAtConversationBottom: Bool {
        !hasUnloadedNewer && (distanceToBottom <= 8 || followingBottom)
    }

    /// The ↑/↓ controls keep their pre-motion state while the list moves
    /// (wheel/trackpad, momentum, a jump glide or its history load) and are
    /// re-evaluated once it settles.
    func updateJumpButtonVisibility(animated: Bool) {
        guard !isDeallocating else { return }
        if isAtConversationBottom, unseenReplies > 0 { unseenReplies = 0 }
        let moving = scrollPolicy.navigationActive || navigationLoadInFlight || isProgrammaticScrollActive
            || isScrollInteractionActive || isResizingControls
        let hasContent = !chatDocumentView.itemKeys.isEmpty
        guard !moving || !hasContent || jumpButtonVisibilityTargets.isEmpty else { syncUnseenDot(); return }
        let showTail = hasContent && !isAtConversationBottom
        // ↑ stays available at the bottom (resting in ↓'s slot, which lies in
        // the Composer band below the last bubble) unless the newest item is
        // the user's own message: there is nothing new to read back to yet.
        let showUp = hasContent
            && !(isAtConversationBottom && chatDocumentView.latestItemIsUser)
            && (previousReplyTarget() != nil || !diagnosticAtOldest)
        setJumpButtonVisibility(jumpButton, material: jumpMaterial, shouldShow: showTail, animated: animated)
        setJumpButtonVisibility(latestStartButton, material: latestStartMaterial, shouldShow: showUp, animated: animated)
        placeLatestStart(raised: showTail, animated: animated)
        syncUnseenDot()
    }

    func setJumpButtonVisibility(
        _ button: NSButton,
        material: NSView,
        shouldShow: Bool,
        animated: Bool
    ) {
        let key = ObjectIdentifier(button)
        guard jumpButtonVisibilityTargets[key] != shouldShow else { return }
        jumpButtonVisibilityTargets[key] = shouldShow
        let generation = (jumpButtonVisibilityGenerations[key] ?? 0) + 1
        jumpButtonVisibilityGenerations[key] = generation
        button.layer?.removeAllAnimations()
        material.layer?.removeAllAnimations()
        if shouldShow {
            button.isHidden = false
            material.isHidden = false
        }
        let changes = {
            button.alphaValue = shouldShow ? 1 : 0
            // Glass stays fully opaque-in-alpha; it appears via isHidden.
            if !Self.isGlass(material) { material.alphaValue = shouldShow ? 1 : 0 }
        }
        let completion = { [weak self, weak button, weak material] in
            guard let self, let button, let material,
                  self.jumpButtonVisibilityTargets[key] == shouldShow,
                  self.jumpButtonVisibilityGenerations[key] == generation else { return }
            if !shouldShow {
                button.isHidden = true
                material.isHidden = true
            }
        }
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = ChatScrollPolicy.navigationControlAnimationDurationSeconds
                changes()
            } completionHandler: { completion() }
        } else {
            changes()
            completion()
        }
    }

    /// Establish Session entry atomically: position the estimated document at
    /// latest, materialize/layout the bottom cells, then position again using
    /// their promoted exact heights. Callers keep the list hidden until this
    /// returns, so users never see an intermediate anchor or corrective jump.
    func establishInitialBottom(allowColdContent: Bool) {
        guard contentView.bounds.width > 1, contentView.bounds.height > 1 else { return }
        let mayBuildColdEntry = allowColdContent && !allowsEdgePaging
        // A Session transition is a hidden presentation transaction. Fully
        // establish only the actual viewport, commit exact CoreText heights,
        // and re-anchor before exposing the list. Ordinary scrolling still
        // installs at most one cold cell per frame.
        for _ in 0..<12 {
            scrollToBottom(animated: false)
            _ = chatDocumentView.updateVisibleCells(
                in: contentView.bounds,
                runwayOverride: 0,
                allowColdContent: mayBuildColdEntry,
                maxConfigurations: .max
            )
            _ = chatDocumentView.commitWarmedHeights()
            scrollToBottom(animated: false)
            chatDocumentView.layoutSubtreeIfNeeded()
            contentView.layoutSubtreeIfNeeded()
            if chatDocumentView.initialViewportIsReady(contentView.bounds) { break }
        }
    }
}
#endif
