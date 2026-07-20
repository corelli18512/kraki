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

    // MARK: - Debug surface (spinner visibility tracking)

    /// True while UIKit reports the top supplementary view is
    /// currently in the visible viewport. Flipped by
    /// `willDisplaySupplementaryView` / `didEndDisplayingSupplementaryView`.
    /// Drives the on-device debug overlay so we can see what the
    /// collection view thinks the spinner state is in real time.
    @Published private(set) var headerSpinnerVisible: Bool = false

    /// Mirror of the above for the bottom supplementary view.
    @Published private(set) var footerSpinnerVisible: Bool = false

    /// Setters for the controller to drive the spinner-visibility
    /// debug flags. The spinners are now scroll-content subviews (not
    /// supplementary views), so visibility is computed by the
    /// controller's `updateEdgeSpinnerViewportState`, not UIKit's
    /// supplementary display callbacks.
    func setHeaderSpinnerVisible(_ visible: Bool) {
        if headerSpinnerVisible != visible { headerSpinnerVisible = visible }
    }
    func setFooterSpinnerVisible(_ visible: Bool) {
        if footerSpinnerVisible != visible { footerSpinnerVisible = visible }
    }

    // MARK: - Configuration

    /// Distance from the bottom edge (in points) within which the
    /// list is still considered "at the bottom". A small fudge keeps
    /// the jump button from flickering on a 1pt rubber-band overshoot
    /// and roughly matches the sticky region of the SwiftUI list's
    /// `.defaultScrollAnchor(.bottom)`.
    private let bottomThreshold: CGFloat = 40

    // MARK: - Load-trigger hooks (driven by edge-spinner visibility)

    /// Invoked on every `scrollViewDidScroll` so the controller can
    /// keep the scroll-content edge spinners positioned (bottom one
    /// tracks `contentSize.height`) and recompute their viewport
    /// visibility / load triggers.
    var onScroll: (() -> Void)?

    /// Fired when the user begins a drag. The controller uses this to
    /// pause idle height-warming so an expensive measurement can't land
    /// on a scroll frame.
    var onWillBeginScroll: (() -> Void)?

    /// Fired when all scroll motion (drag + deceleration) has stopped,
    /// so the controller can resume idle height-warming.
    var onDidEndScroll: (() -> Void)?

    /// Explicit per-item height provider (flow-layout `sizeForItemAt`).
    /// The list uses a plain `UICollectionViewFlowLayout` with
    /// `estimatedItemSize = .zero` (NO self-sizing), exactly like the
    /// validated scroll-perf harness: every cell's height is an
    /// authoritative value from the sizing cache, so all geometry
    /// (`contentSize`, `frame.minY`) is exact at apply time. That is what
    /// makes prepend anchoring jump-free — a self-sizing layout only
    /// *estimates* off-screen cells, which corrupts both the anchor
    /// restore and the at-bottom check. Returns the row height for the
    /// item at `indexPath`; the controller wires it to the height cache.
    var heightForItemAt: ((IndexPath) -> CGFloat)?

    /// Inline loading-spinner row heights (flow-layout section header =
    /// top / loadOlder, footer = bottom / loadNewer). The controller
    /// returns `spinnerRowHeight` while that edge is loading, else 0 —
    /// exactly the scroll-perf harness's `referenceSizeForHeader/Footer`.
    /// Toggling the flag + invalidating delegate metrics grows/collapses
    /// the inline spinner row inside the scroll content.
    var headerHeight: (() -> CGFloat)?
    var footerHeight: (() -> CGFloat)?

    /// When set, `publishIsAtBottom` is short-circuited. The controller
    /// raises this around synchronous viewport edits (`applyEdges`,
    /// `fullReload`, `reconfigureVisible`) that run INSIDE SwiftUI's
    /// view-update phase: any `setContentOffset` there fires
    /// `scrollViewDidScroll` → `publishIsAtBottom`, mutating an
    /// `@Published` property mid-update ("Publishing changes from within
    /// view updates is not allowed"). The controller does the real
    /// at-bottom recompute on a deferred runloop hop instead.
    var suppressBottomPublish = false

    /// Fired so the controller can flush any apply it deferred while the
    /// list was decelerating (see `applyWhenStable`). Wired to the
    /// scroll-end / drag-begin transitions so a stashed window edit lands
    /// the instant natural motion settles.
    var onFlushPendingApply: (() -> Void)?

    // MARK: - Collection view reference

    /// Weak ref to the collection view this coordinator is driving.
    /// Set by the list controller after it has installed the
    /// coordinator as its delegate. Used by the public scroll-action
    /// API (e.g. `scrollToBottom`) so SwiftUI overlays don't need a
    /// path back through the representable to trigger UIKit work.
    weak var collectionView: UICollectionView?

    // MARK: - Public scroll API (called from SwiftUI overlays)

    /// Scroll to the very last item (newest), pinning it to the visual
    /// bottom. No-op if the list is empty or the collection view has
    /// been torn down. Used by the jump-to-latest button.
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

extension ChatScrollCoordinator: UICollectionViewDelegateFlowLayout {
    /// Authoritative per-item height. With `estimatedItemSize = .zero`
    /// the flow layout never self-sizes — it lays every cell out at the
    /// height returned here, computed from the sizing cache. This makes
    /// `contentSize` and every `frame.minY` exact the instant a snapshot
    /// applies, which is the precondition for jump-free prepend
    /// anchoring (mirrors the scroll-perf harness).
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        sizeForItemAt indexPath: IndexPath) -> CGSize {
        let width = collectionView.bounds.width
        guard width > 0 else { return CGSize(width: max(width, 1), height: 1) }
        let h = heightForItemAt?(indexPath) ?? 0
        // Guard against a degenerate 0 height (uncached + measure failed)
        // — a 1pt placeholder keeps layout valid; the cell re-measures.
        return CGSize(width: width, height: max(h, 1))
    }

    /// Inline top spinner row (loadOlder). Zero unless that edge is
    /// loading — mirrors the harness's `referenceSizeForHeaderInSection`.
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForHeaderInSection section: Int) -> CGSize {
        let h = headerHeight?() ?? 0
        guard h > 0 else { return .zero }
        return CGSize(width: collectionView.bounds.width, height: h)
    }

    /// Inline bottom spinner row (loadNewer).
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForFooterInSection section: Int) -> CGSize {
        let h = footerHeight?() ?? 0
        guard h > 0 else { return .zero }
        return CGSize(width: collectionView.bounds.width, height: h)
    }

    /// `UIScrollViewDelegate` callback. UIKit invariant: called on
    /// the main thread, so direct `@Published` mutation is safe.
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard let cv = scrollView as? UICollectionView else { return }
        publishIsAtBottom(for: cv)
        onScroll?()
    }

    /// User has started a drag — release the idle anchor so the
    /// controller stops auto-correcting. Without this the apply
    /// after the user lifts their finger would yank the scroll
    /// back to the captured Y, fighting the user's gesture.
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        clearIdleAnchor()
        onWillBeginScroll?()
        onFlushPendingApply?()
    }

    /// Drag ended without momentum — motion is over, resume warming.
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate {
            onDidEndScroll?()
            onFlushPendingApply?()
        }
    }

    /// Momentum scroll finished — motion is over, resume warming.
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        onDidEndScroll?()
        onFlushPendingApply?()
    }
}

// MARK: - Internals

private extension ChatScrollCoordinator {
    func publishIsAtBottom(for scrollView: UIScrollView) {
        guard !suppressBottomPublish else { return }
        let offset = scrollView.contentOffset.y
        let inset = scrollView.adjustedContentInset
        let visibleHeight = scrollView.bounds.height - inset.top - inset.bottom
        let contentHeight = scrollView.contentSize.height
        // Content shorter than the viewport ⇒ trivially "at bottom".
        guard contentHeight > visibleHeight else {
            if !isAtBottom { isAtBottom = true }
            return
        }
        // The newest message lives at the bottom of the content, so
        // "at bottom" (following live) means the scroll position is near
        // the content's end. distanceFromBottom = 0 there.
        let distanceFromBottom = contentHeight - (offset + visibleHeight)
        let near = distanceFromBottom <= bottomThreshold
        if isAtBottom != near {
            isAtBottom = near
        }
    }
}
#endif
