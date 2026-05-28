#if os(iOS)
/// ChatScrollCoordinator — owns scroll-derived state for the UIKit
/// chat list and republishes it to SwiftUI overlays via @Published.
///
/// Stage 2 of the UIKit refactor establishes the coordinator surface
/// so overlays (jump-to-latest button, future sticky pill, etc.) can
/// observe scroll position through one Combine source instead of the
/// scattered `@State` flags that lived on `ChatView` for the SwiftUI
/// path.
///
/// What this coordinator publishes:
///   • `isAtBottom`     — true when the collection view's last item
///                        is roughly on screen. Drives the
///                        jump-to-latest button visibility.
///   • `growMode`       — R1 growing-reply state machine. Default
///                        `.idle`. Stage 5 will drive transitions.
///   • `lockedMsgId`    — id of the user bubble currently being
///                        tracked by R1. Stage 5.
///   • `anchoredUserMsgId` / `anchoredScreenY` — idle-anchor lock
///                        target. Stage 6 captures these on
///                        sessionIdle and enforces them on snapshot
///                        apply.
///
/// Stage 2 wires only `isAtBottom` for real; the other properties
/// exist with their default values so call sites can observe them
/// without a second migration when their logic lands.
///
/// `weak var collectionView` is held so the SwiftUI overlay can
/// trigger `scrollToBottom(animated:)` without a round-trip back
/// through the representable.

import UIKit
import Combine

/// Not marked @MainActor: UIScrollViewDelegate is an Objective-C
/// protocol and `scrollViewDidScroll(_:)` is invoked by UIKit via
/// dynamic dispatch. Making the class @MainActor forces the
/// conformance method to be `nonisolated` to satisfy the protocol's
/// non-isolated witness signature, which in practice prevents the
/// Obj-C runtime from finding the selector under Swift 6 strict
/// concurrency. UIKit guarantees delegate methods run on the main
/// thread, so explicit @Published mutations from those callbacks
/// are already on the right thread.
final class ChatScrollCoordinator: NSObject, ObservableObject {

    // MARK: - R1 Growing-Reply State (mirrors ChatView.GrowMode)

    /// State machine for the post-send growing-reply animation. The
    /// semantics match the SwiftUI path's existing `GrowMode` so the
    /// migration in Stage 5 is a straight move, not a redesign.
    enum GrowMode {
        /// No automatic anchoring. Default on session entry / after
        /// manual scroll / session-idle.
        case idle
        /// Content stays pinned to the bottom while the agent reply
        /// grows; the user bubble drifts up the viewport.
        case followBottom
        /// User bubble has reached the viewport top and is now
        /// locked there; further growth extends off the bottom.
        case lockedAtTop
    }

    // MARK: - Published surface

    /// True when the collection view's bottom edge is roughly on
    /// screen. Drives jump-to-latest button visibility. Defaults to
    /// `true` because a freshly loaded chat opens at the bottom and
    /// we don't want the button flashing on during initial layout.
    @Published private(set) var isAtBottom: Bool = true

    /// Current R1 phase. Stage 2 leaves this at `.idle`; Stage 5
    /// drives transitions from `scrollViewDidScroll` and from
    /// snapshot-apply hooks in the controller.
    @Published var growMode: GrowMode = .idle

    /// ChatMessage.id of the user bubble currently being tracked by
    /// R1. Stage 5.
    @Published var lockedMsgId: String? = nil

    /// id of the user bubble whose screen Y is being held fixed
    /// during the idle anchor lock. Stage 6.
    @Published var anchoredUserMsgId: String? = nil

    /// Screen-space Y at which `anchoredUserMsgId`'s bubble top is
    /// being held. Stage 6.
    @Published var anchoredScreenY: CGFloat? = nil

    // MARK: - Configuration

    /// Distance from the bottom edge (in points) within which the
    /// list is still considered "at the bottom". A small fudge keeps
    /// the jump button from flickering on a 1pt rubber-band overshoot
    /// and roughly matches the sticky region of the SwiftUI list's
    /// `.defaultScrollAnchor(.bottom)`.
    private let bottomThreshold: CGFloat = 40

    /// Distance from the top edge (in points) within which we should
    /// dispatch a load-older request. Set generously enough that the
    /// fetch starts before the user sees an empty top, but not so
    /// generous that it fires on first paint while the list is still
    /// laying out from offset 0.
    private let topLoadOlderThreshold: CGFloat = 200

    // MARK: - Load-older handshake

    /// SwiftUI-side hook for "the user has scrolled near the top —
    /// please ensure older messages are loaded". Invoked at most
    /// once per "approach to top" — we de-bounce by latching on
    /// `isNearTop` so a steady dwell at offset=0 doesn't spam
    /// `ensureOlderLoaded`. Reset to "may fire again" once the user
    /// scrolls back past the threshold.
    var onNearTopReached: (() -> Void)?

    /// True between the moment the user crosses below
    /// `topLoadOlderThreshold` and the moment they scroll back above
    /// it. Used to debounce `onNearTopReached`. Public read for
    /// diagnostics; mutated only inside `publishIsAtBottom`.
    private(set) var isNearTop: Bool = false

    // MARK: - Collection view reference

    /// Weak ref to the collection view this coordinator is driving.
    /// Set by `ChatListViewController` after it has installed the
    /// coordinator as its delegate. Used by the public scroll-action
    /// API (e.g. `scrollToBottom`) so SwiftUI overlays don't need a
    /// path back through the representable to trigger UIKit work.
    weak var collectionView: UICollectionView?

    // MARK: - Public scroll API (called from SwiftUI overlays)

    /// Scroll to the very last item. No-op if the list is empty or
    /// the collection view has been torn down. Used by the
    /// jump-to-latest button in the UIKit branch.
    func scrollToBottom(animated: Bool) {
        guard let cv = collectionView else { return }
        let lastSection = cv.numberOfSections - 1
        guard lastSection >= 0 else { return }
        let lastItem = cv.numberOfItems(inSection: lastSection) - 1
        guard lastItem >= 0 else { return }
        let indexPath = IndexPath(item: lastItem, section: lastSection)
        cv.scrollToItem(at: indexPath, at: .bottom, animated: animated)
    }

    /// Force-publish the current bottom proximity by sampling the
    /// collection view immediately. Called by the controller after
    /// snapshot applies so a content-size jump (e.g. the very first
    /// apply, when the list was empty and `isAtBottom` was still its
    /// default `true`) re-syncs the published value with the real
    /// scroll position.
    func recomputeIsAtBottom() {
        guard let cv = collectionView else { return }
        publishIsAtBottom(for: cv)
    }

    // MARK: - Idle anchor lock (Stage 6)

    /// Store an active idle anchor on the latest user bubble.
    /// `screenY` is the bubble's current top-edge Y in viewport
    /// coordinates (i.e. content-Y minus contentOffset.y). The
    /// controller will use the pair on subsequent `apply` calls to
    /// shift contentOffset so the bubble stays at the same screenY,
    /// preventing tool-entry expansions or late image decodes from
    /// drifting the visible user message.
    ///
    /// Called by the controller after it samples the cell — the
    /// coordinator publishes the values for SwiftUI observability
    /// but doesn't sample them itself (it has no view of cells).
    func setIdleAnchor(itemId: String, screenY: CGFloat) {
        anchoredUserMsgId = itemId
        anchoredScreenY = screenY
    }

    /// Clear the idle anchor. Called when:
    ///   • Session leaves idle (new turn starts) — anchor is for
    ///     idle quiet-period; once growth begins, anchor preservation
    ///     and follow-bottom take over.
    ///   • User starts dragging — explicit scroll intent overrides
    ///     any auto-positioning.
    ///   • Session switch — controller is torn down.
    func clearIdleAnchor() {
        anchoredUserMsgId = nil
        anchoredScreenY = nil
    }
}

// MARK: - UICollectionViewDelegate

extension ChatScrollCoordinator: UICollectionViewDelegate {
    /// `UIScrollViewDelegate` callback. UIKit invariant: called on
    /// the main thread, so direct `@Published` mutation is safe.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard let cv = scrollView as? UICollectionView else { return }
        publishIsAtBottom(for: cv)
        checkNearTop(for: cv)
    }

    /// User has started a drag — release the idle anchor so the
    /// controller stops auto-correcting. Without this the apply
    /// after the user lifts their finger would yank the scroll
    /// back to the captured Y, fighting the user's gesture.
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        clearIdleAnchor()
    }
}

// MARK: - Internals

private extension ChatScrollCoordinator {
    func publishIsAtBottom(for scrollView: UIScrollView) {
        let offset = scrollView.contentOffset.y
        let inset = scrollView.adjustedContentInset
        let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
        let contentHeight = scrollView.contentSize.height
        // Content shorter than the viewport ⇒ trivially "at bottom".
        guard contentHeight > visibleHeight else {
            if !isAtBottom { isAtBottom = true }
            return
        }
        let distanceFromBottom = contentHeight - (offset + visibleHeight)
        let near = distanceFromBottom <= bottomThreshold
        if isAtBottom != near {
            isAtBottom = near
        }
    }

    /// Edge-triggered near-top detection. Fires `onNearTopReached`
    /// once on the transition from "above threshold" → "below
    /// threshold". Resets when the user scrolls back above the
    /// threshold so a subsequent re-approach can dispatch another
    /// load. Ignores the trivial case where the content is shorter
    /// than the viewport (no scrolling possible, no older content
    /// implicitly worth fetching from a scroll trigger).
    func checkNearTop(for scrollView: UIScrollView) {
        let contentHeight = scrollView.contentSize.height
        let viewportHeight = scrollView.bounds.height - scrollView.adjustedContentInset.top - scrollView.adjustedContentInset.bottom
        guard contentHeight > viewportHeight else {
            if isNearTop { isNearTop = false }
            return
        }
        let offset = scrollView.contentOffset.y + scrollView.adjustedContentInset.top
        let nearTopNow = offset < topLoadOlderThreshold
        if nearTopNow && !isNearTop {
            isNearTop = true
            onNearTopReached?()
        } else if !nearTopNow && isNearTop {
            isNearTop = false
        }
    }
}
#endif
