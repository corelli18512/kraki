/// Landing on the first unread message, following the tail, and programmatic scroll glides.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatScrollView {
    /// After a height change was added to the offset directly (streaming
    /// growth, warmed heights): check the landing again in the same step.
    func applyUnreadEntryAfterGeometryChange() {
        guard scrollPolicy.unreadEntry != .none else { return }
        _ = landOnFirstUnreadIfNeeded()
    }

    func landOnFirstUnreadIfNeeded() -> Bool {
        guard !applyingUnreadEntry else { return false }
        applyingUnreadEntry = true
        defer { applyingUnreadEntry = false }
        let tail = max(-topContentInset, chatDocumentView.tailHeight - contentView.bounds.height)
        switch scrollPolicy.unreadEntry {
        case .none:
            return false
        case .anchored:
            // A concluded turn folds its mid-turn messages into Steps: then
            // the first new row still shown takes over.
            var frame = unreadEntryKey.flatMap { chatDocumentView.frame(forKey: $0) }
            if frame == nil, let boundary = heldUnreadBoundary,
               let first = chatDocumentView.firstItem(afterSeq: boundary, latestReplyFallback: unreadEntryHadGap && !hasUnloadedNewer) {
                unreadEntryKey = first.key
                frame = first.frame
            }
            guard let frame else { return false }
            let held = landingOffset(forRowStart: frame.minY)
            if held >= tail - 1, let boundary = heldUnreadBoundary {
                // Measured: it fits after all. Follow the tail again.
                scrollPolicy.releaseUnreadAnchor(boundary: boundary)
                unreadEntryKey = nil
                return false
            }
            cancelScrollAnimation()
            contentView.bounds.origin.y = held
        case .armed(let boundary):
            guard let first = chatDocumentView.firstItem(afterSeq: boundary, latestReplyFallback: unreadEntryHadGap && !hasUnloadedNewer),
                  let landing = ChatScrollPolicy.unreadEntryLanding(
                    rowStartLanding: landingOffset(forRowStart: first.frame.minY),
                    tailOffset: tail
                  ) else { return false }
            cancelScrollAnimation()
            contentView.bounds.origin.y = landing
            unreadEntryKey = first.key
            heldUnreadBoundary = boundary
            scrollPolicy.anchorAtFirstUnread(offset: landing)
            KLog.chat("📌 [chat-entry] first-unread session=\(representedSessionId?.prefix(12) ?? "") boundary=\(boundary) row=\(first.key.prefix(16)) landing=\(Int(landing)) tail=\(Int(tail))")
        }
        scrollPolicy.rememberOffset(contentView.bounds.minY)
        updateJumpButtonVisibility(animated: false)
        super.reflectScrolledClipView(contentView)
        return true
    }

    #if DEBUG
    var automationUnreadEntry: ChatScrollPolicy.UnreadEntry { scrollPolicy.unreadEntry }
    #endif

    /// The newest bubble grew while the bottom is followed: the conversation
    /// eases toward the bottom every frame (one continuous motion that keeps
    /// re-targeting while lines keep arriving, instead of restarting a glide
    /// per line).
    func followTailSmoothly() {
        guard landOnFirstUnreadIfNeeded() == false else { return }
        if let running = scrollAnimation {
            // Already following; or a long glide to the bottom (↓, a send)
            // that re-targets anyway — following takes over only near the
            // end, so the long glide is never cut into a jump.
            if running.follow || distanceToBottom > 3 * MacTailMotion.maxLag { return }
        }
        animateScroll(follow: true, to: { [weak self] in
            guard let self else { return 0 }
            return self.followTailTarget()
        }, completion: { [weak self] in
            guard let self else { return }
            self.scrollPolicy.pinToTail(observedOffset: self.contentView.bounds.minY)
        })
        bottomGlideActive = true
        scrollPolicy.pinToTail(observedOffset: contentView.bounds.minY)
    }

    /// True once the Session's first frame is on screen (entry establishment
    /// stays instant and hidden; motion starts after that).
    var hasPresentedFirstFrame: Bool { alphaValue > 0.99 && window != nil }

    func scrollToBottom(animated: Bool) {
        geometryAnchorLock = nil
        guard chatDocumentView.frame.height > 0 else { return }
        // Arrival glides are animated too; only ↓ and sending end the landing
        // (they cancel it before getting here).
        if landOnFirstUnreadIfNeeded() { return }
        // A running glide to the bottom re-targets every frame; a streaming
        // pin must not cut it short into a jump.
        if !animated, bottomGlideActive {
            scrollPolicy.pinToTail(observedOffset: contentView.bounds.minY)
            return
        }
        if animated {
            // Re-targets every frame, so content appended during the glide
            // (the message just sent, a landing answer) is still reached.
            animateScroll(to: { [weak self] in
                guard let self else { return 0 }
                return self.chatDocumentView.tailHeight - self.contentView.bounds.height
            }, completion: { [weak self] in
                guard let self else { return }
                self.scrollPolicy.pinToTail(observedOffset: self.contentView.bounds.minY)
                self.updateJumpButtonVisibility(animated: true)
            })
            bottomGlideActive = true
        } else {
            cancelScrollAnimation()
            contentView.bounds.origin = NSPoint(x: 0, y: followTailTarget())
        }
        scrollPolicy.pinToTail(observedOffset: contentView.bounds.minY)
        updateJumpButtonVisibility(animated: animated)
        reflectScrolledClipView(contentView)
    }

    var isProgrammaticScrollActive: Bool { scrollAnimation != nil }

    func animateScroll(
        duration: CFTimeInterval = 0.28,
        follow: Bool = false,
        to target: @escaping () -> CGFloat,
        completion: (() -> Void)? = nil
    ) {
        cancelScrollAnimation()
        resetSmoothWheelAnimation()
        let now = CACurrentMediaTime()
        scrollAnimation = (now, duration, contentView.bounds.minY, target, completion, follow, now)
        let timer = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.advanceScrollAnimation() }
        }
        RunLoop.main.add(timer, forMode: .common)
        scrollAnimationTimer = timer
    }

    func cancelScrollAnimation() {
        bottomGlideActive = false
        scrollAnimationTimer?.invalidate()
        scrollAnimationTimer = nil
        scrollAnimation = nil
    }

    func advanceScrollAnimation() {
        guard let animation = scrollAnimation else { return }
        let now = CACurrentMediaTime()
        var progress = min(1, (now - animation.start) / animation.duration)
        let eased = 1 - pow(1 - progress, 3)
        let minimumY = -contentInsets.top
        let maximumY = max(minimumY, chatDocumentView.frame.height - contentView.bounds.height)
        let target = min(maximumY, max(minimumY, animation.target()))
        var y = animation.from + (target - animation.from) * CGFloat(eased)
        if animation.follow {
            let current = contentView.bounds.minY
            let step = MacTailMotion.followStep(remaining: target - current, elapsed: now - animation.last)
            y = current + step
            scrollAnimation?.last = now
            progress = abs(target - y) <= 0.5 ? 1 : 0
            if progress >= 1 { y = target }
        }
        geometryAnchorLock = nil
        contentView.bounds.origin = NSPoint(x: contentView.bounds.origin.x, y: y)
        reflectScrolledClipView(contentView)
        if progress >= 1 {
            let completion = animation.completion
            cancelScrollAnimation()
            completion?()
            updateJumpButtonVisibility(animated: true)
        }
    }
}
#endif
