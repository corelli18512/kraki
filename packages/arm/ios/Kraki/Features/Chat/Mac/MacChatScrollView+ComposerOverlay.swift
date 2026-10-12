#if os(macOS)
import AppKit

/// The floating Composer rising above its resting footprint (dictation, a
/// multi-line draft): see docs/chat-composer-overlay.md. Its growth extends the
/// document so the bubbles it covers can be scrolled into view, but is not part
/// of the newest edge (`tailHeight`): following, ↓ and distance-to-bottom
/// ignore it, so the Composer's growth never moves the conversation.
extension MacChatDocumentView {
    /// Document height up to the newest edge (excludes `composerOverlay`).
    var tailHeight: CGFloat { max(0, frame.height - composerOverlay) }

    func setComposerOverlay(_ height: CGFloat) {
        let clamped = max(0, height)
        guard abs(composerOverlay - clamped) > 0.5 else { return }
        composerOverlay = clamped
        rebuildFrames()
    }
}

extension MacChatScrollView {
    func setBottomContentInset(_ inset: CGFloat, composerOverlay: CGFloat) {
        setBottomContentInset(inset)
        setComposerOverlay(composerOverlay)
    }

    /// The floating Composer grew or shrank. Growth only extends how far the
    /// Chat can scroll (the bubbles it covers stay reachable); the viewport is
    /// not moved, so nothing follows the rising glass. Shrinking gives back
    /// only the space that is no longer reachable.
    func setComposerOverlay(_ height: CGFloat) {
        guard abs(chatDocumentView.composerOverlay - max(0, height)) > 0.5 else { return }
        let origin = contentView.bounds.origin
        chatDocumentView.setComposerOverlay(height)
        let reach = max(-topContentInset, chatDocumentView.frame.height - contentView.bounds.height)
        contentView.bounds.origin = NSPoint(x: origin.x, y: min(origin.y, reach))
        reflectScrolledClipView(contentView)
        updateJumpButtonVisibility(animated: false)
    }

    /// Where following the newest edge lands. While the Composer is raised the
    /// reader may have scrolled the bubbles it covers into view: keep that
    /// (never pull them back under the glass), but never chase the Composer.
    func followTailTarget() -> CGFloat {
        let tail = max(-topContentInset, chatDocumentView.tailHeight - contentView.bounds.height)
        guard chatDocumentView.composerOverlay > 0 else { return tail }
        let reach = max(tail, chatDocumentView.frame.height - contentView.bounds.height)
        return min(reach, max(tail, contentView.bounds.minY))
    }
}
#endif
