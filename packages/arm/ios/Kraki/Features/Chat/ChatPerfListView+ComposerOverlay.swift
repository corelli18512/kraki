#if os(iOS)
import UIKit

/// The floating composer rising above its resting footprint (dictation, a
/// multi-line draft): see docs/chat-composer-overlay.md. Its growth extends how
/// far the list can scroll so the bubbles it covers can be revealed by hand;
/// the newest edge (follow, ↓, distance-to-bottom) keeps resting on the
/// resting composer, so the growth never moves the conversation.
extension ChatPerfListVC {
    /// Insets the newest edge rests against: everything except the floating
    /// composer's growth above its resting footprint.
    var tailAdjustedInsets: UIEdgeInsets {
        var insets = collectionView.adjustedContentInset
        insets.bottom -= composerOverlayInset
        return insets
    }

    /// The furthest the reader can scroll (includes the composer's growth).
    private var reachOffsetY: CGFloat {
        max(-collectionView.adjustedContentInset.top,
            collectionView.contentSize.height - collectionView.bounds.height
                + collectionView.adjustedContentInset.bottom)
    }

    /// Where a follow pin lands. Normally the newest edge. While the composer
    /// is raised the reader may have scrolled the bubbles it covers into view:
    /// keep that (never pull them back under the glass), but never chase the
    /// composer either. Explicit jumps (↓, a send) go to the newest edge.
    func followPinOffset(keepingRevealed: Bool) -> CGFloat {
        let tail = maximumOffsetY()
        guard keepingRevealed, composerOverlayInset > 0 else { return tail }
        return min(max(tail, reachOffsetY), max(tail, collectionView.contentOffset.y))
    }

    /// The floating composer grew or shrank. Growth only extends how far the
    /// list can scroll (the covered bubbles stay reachable); the offset is not
    /// touched, so nothing moves under the rising glass. Shrinking pulls back
    /// only what is no longer reachable, together with the collapsing glass.
    func updateComposerOverlayInset(_ value: CGFloat) {
        let value = max(0, value)
        guard abs(value - composerOverlayInset) > 0.5 else { return }
        composerOverlayInset = value
        let offset = collectionView.contentOffset
        collectionView.contentInset.bottom = bottomContentInset + value
        collectionView.verticalScrollIndicatorInsets.bottom = bottomContentInset + value
        // Setting contentInset can nudge the offset; growth must not move anything.
        if collectionView.contentOffset != offset { collectionView.contentOffset = offset }
        let reach = reachOffsetY
        if offset.y > reach + 0.5, !collectionView.isDragging, !collectionView.isDecelerating {
            let settle = { self.collectionView.contentOffset.y = reach }
            if view.window != nil {
                UIView.animate(withDuration: 0.34, delay: 0, usingSpringWithDamping: 0.9,
                               initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState],
                               animations: settle)
            } else {
                settle()
            }
            scrollPolicy.rememberOffset(reach)
        }
        updateJumpButtonVisibility()
    }
}
#endif
