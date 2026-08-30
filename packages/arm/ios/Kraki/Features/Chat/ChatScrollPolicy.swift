import CoreGraphics

/// Platform-neutral product rules for native Chat scrolling.
///
/// UIKit and AppKit keep ownership of gesture delivery, viewport geometry,
/// anchoring, animation, and pagination execution. Both adapters feed those
/// native observations into this value type so Session entry, user intent,
/// tail-following, edge-paging, and navigation-control rules cannot drift by
/// platform.
struct ChatScrollPolicy: Equatable {
    enum Direction: Equatable {
        case none
        case older
        case newer
    }

    struct NavigationControlVisibility: Equatable {
        let showTail: Bool
        let showLatestMessageStart: Bool
    }

    static let defaultBottomTolerance: CGFloat = 24
    static let defaultMovementEpsilon: CGFloat = 0.5
    static let edgeTriggerDistance: CGFloat = 320
    static let olderPrefetchViewportMultiplier: CGFloat = 2
    static let tailControlViewportMultiplier: CGFloat = 1.5
    static let navigationControlAnimationDurationSeconds: Double = 0.2
    static let navigationSafetyTimeoutSeconds: Double = 0.6

    let bottomTolerance: CGFloat
    let movementEpsilon: CGFloat

    private(set) var entryBottomLocked = true
    private(set) var allowsEdgePaging = false
    private(set) var followingTail = true
    private(set) var direction: Direction = .none
    private(set) var lastObservedOffset: CGFloat?

    /// One native drag/deceleration, trackpad momentum sequence, wheel
    /// animation, knob drag, or discrete semantic scroll is one interaction.
    private(set) var interactionActive = false
    private(set) var interactionGeneration = 0

    /// macOS's validated pagination contract: at most one older request per
    /// continuous interaction. Newer recovery remains available after explicit
    /// newer intent, matching the existing native Mac behavior.
    private(set) var olderPageArmed = false
    private(set) var olderPageConsumed = false
    private(set) var suppressesNewerPagingAfterOlder = false

    /// User-initiated animated navigation temporarily suppresses edge paging
    /// and hides both navigation controls until it lands or is cancelled.
    private(set) var navigationActive = false

    init(
        bottomTolerance: CGFloat = Self.defaultBottomTolerance,
        movementEpsilon: CGFloat = Self.defaultMovementEpsilon
    ) {
        self.bottomTolerance = bottomTolerance
        self.movementEpsilon = movementEpsilon
    }

    var scrollingTowardOlder: Bool { direction == .older }
    var suppressesEdgePaging: Bool { navigationActive }

    /// Semantic follow state used when content or viewport geometry changes.
    /// Explicit older-history intent always wins over the geometric tolerance.
    func shouldFollowTail(distanceToBottom: CGFloat) -> Bool {
        entryBottomLocked
            || followingTail
            || (!scrollingTowardOlder && isNearTail(distanceToBottom))
    }

    /// Current pinned state for controls that need a lightweight geometry
    /// fallback in addition to the explicit follow latch.
    func isPinnedToTail(distanceToBottom: CGFloat) -> Bool {
        followingTail
            || (!scrollingTowardOlder && isNearTail(distanceToBottom))
    }

    func olderPrefetchDistance(viewportLength: CGFloat) -> CGFloat {
        max(
            Self.edgeTriggerDistance,
            Self.olderPrefetchViewportMultiplier * max(viewportLength, 0)
        )
    }

    func navigationControlVisibility(
        distanceToBottom: CGFloat,
        viewportLength: CGFloat,
        hasUnloadedNewer: Bool,
        currentOffset: CGFloat,
        latestMessageStartOffset: CGFloat?
    ) -> NavigationControlVisibility {
        guard !navigationActive else {
            return NavigationControlVisibility(
                showTail: false,
                showLatestMessageStart: false
            )
        }
        let farFromBottom = distanceToBottom
            > Self.tailControlViewportMultiplier * max(viewportLength, 1)
        let showStart = latestMessageStartOffset.map {
            abs(currentOffset - $0) > bottomTolerance
        } == true
        return NavigationControlVisibility(
            showTail: farFromBottom || hasUnloadedNewer,
            showLatestMessageStart: showStart
        )
    }

    mutating func resetForEntry() {
        entryBottomLocked = true
        allowsEdgePaging = false
        followingTail = true
        direction = .none
        lastObservedOffset = nil
        interactionActive = false
        interactionGeneration = 0
        olderPageArmed = false
        olderPageConsumed = false
        suppressesNewerPagingAfterOlder = false
        navigationActive = false
    }

    /// Releases entry protection when a native callback proves user ownership,
    /// without replacing an offset baseline captured by an earlier begin event.
    mutating func unlockForUserInteraction() {
        entryBottomLocked = false
        allowsEdgePaging = true
        navigationActive = false
    }

    /// Marks the beginning (or overlap) of a native continuous interaction.
    /// Re-grabbing a still-settling gesture does not create a second older-page
    /// allowance; a fully settled next gesture does.
    mutating func beginUserInteraction(
        offset: CGFloat,
        distanceToBottom: CGFloat
    ) {
        unlockForUserInteraction()
        if !interactionActive {
            interactionActive = true
            interactionGeneration += 1
            olderPageArmed = false
            olderPageConsumed = false
        }
        lastObservedOffset = offset
        if !scrollingTowardOlder {
            followingTail = isNearTail(distanceToBottom)
        }
    }

    mutating func endUserInteraction() {
        interactionActive = false
    }

    /// Records native content-offset movement. Both adapters use coordinates
    /// that increase toward the newest tail, so a negative delta means older.
    mutating func observeUserOffset(
        _ offset: CGFloat,
        distanceToBottom: CGFloat
    ) {
        unlockForUserInteraction()

        guard let previous = lastObservedOffset else {
            lastObservedOffset = offset
            if !scrollingTowardOlder {
                followingTail = isNearTail(distanceToBottom)
            }
            return
        }

        lastObservedOffset = offset
        let delta = offset - previous
        if delta < -movementEpsilon {
            applyUserDirection(
                .older,
                distanceToBottom: distanceToBottom,
                armOlderPaging: true
            )
        } else if delta > movementEpsilon {
            applyUserDirection(
                .newer,
                distanceToBottom: distanceToBottom,
                armOlderPaging: false
            )
        } else if !scrollingTowardOlder {
            followingTail = isNearTail(distanceToBottom)
        }
    }

    /// Records direction supplied directly by a native wheel/key/automation
    /// event before its resulting offset is reflected by the scroll container.
    mutating func recordUserIntent(
        _ newDirection: Direction,
        offset: CGFloat? = nil,
        distanceToBottom: CGFloat? = nil,
        armOlderPaging: Bool = true
    ) {
        unlockForUserInteraction()
        if let offset { lastObservedOffset = offset }
        applyUserDirection(
            newDirection,
            distanceToBottom: distanceToBottom,
            armOlderPaging: armOlderPaging
        )
    }

    /// Consumes the single older-page allowance for this continuous gesture.
    /// Platform-specific buffering/attachment guards should be checked before
    /// calling this method; common direction, edge, loading, and navigation
    /// rules are enforced here.
    mutating func shouldRequestOlderPage(
        distanceToOlderEdge: CGFloat,
        viewportLength: CGFloat,
        hasOlder: Bool,
        isLoading: Bool,
        externallySuppressed: Bool = false
    ) -> Bool {
        guard allowsEdgePaging,
              !navigationActive,
              !externallySuppressed,
              scrollingTowardOlder,
              olderPageArmed,
              !olderPageConsumed,
              hasOlder,
              !isLoading,
              distanceToOlderEdge <= olderPrefetchDistance(viewportLength: viewportLength)
        else { return false }

        olderPageArmed = false
        olderPageConsumed = true
        suppressesNewerPagingAfterOlder = true
        return true
    }

    func shouldRequestNewerPage(
        distanceToNewerEdge: CGFloat,
        hasNewer: Bool,
        isLoading: Bool,
        externallySuppressed: Bool = false
    ) -> Bool {
        allowsEdgePaging
            && !navigationActive
            && !externallySuppressed
            && !suppressesNewerPagingAfterOlder
            && hasNewer
            && !isLoading
            && distanceToNewerEdge <= Self.edgeTriggerDistance
    }

    /// Programmatic navigation initiated by the user, where the resulting
    /// offset may be animated and must not be inferred as an entry callback.
    mutating func beginLatestMessageStartNavigation() {
        beginNavigation(direction: .older, followingTail: false)
    }

    mutating func beginTailNavigation(
        offset: CGFloat,
        distanceToBottom: CGFloat
    ) {
        lastObservedOffset = offset
        beginNavigation(
            direction: .newer,
            followingTail: isNearTail(distanceToBottom)
        )
    }

    mutating func endNavigation() {
        navigationActive = false
    }

    /// Leaves tail-following for a user-selected arbitrary anchor whose
    /// direction is not known (for example a Debug semantic scroll target).
    mutating func leaveTailForUserNavigation(offset: CGFloat? = nil) {
        entryBottomLocked = false
        allowsEdgePaging = true
        followingTail = false
        direction = .none
        lastObservedOffset = offset
        navigationActive = false
        interactionActive = false
        olderPageArmed = false
    }

    /// Explicitly pins native geometry to the newest tail. This deliberately
    /// does not release the entry lock: initial layout uses the same operation.
    mutating func pinToTail(observedOffset: CGFloat? = nil) {
        followingTail = true
        direction = .newer
        lastObservedOffset = observedOffset
        olderPageArmed = false
        suppressesNewerPagingAfterOlder = false
    }

    /// Adopts a follow decision captured before a platform geometry mutation.
    mutating func setFollowingTail(_ following: Bool) {
        followingTail = following
        if following {
            direction = .newer
            olderPageArmed = false
            suppressesNewerPagingAfterOlder = false
        }
    }

    /// Recomputes follow state after native geometry is stable without treating
    /// a programmatic reflection as user movement.
    mutating func refreshFollowingTail(distanceToBottom: CGFloat) {
        followingTail = entryBottomLocked
            || (!scrollingTowardOlder && isNearTail(distanceToBottom))
    }

    /// Updates the comparison baseline after a programmatic pin or reflected
    /// AppKit geometry change without changing semantic direction.
    mutating func rememberOffset(_ offset: CGFloat?) {
        lastObservedOffset = offset
    }

    private mutating func applyUserDirection(
        _ newDirection: Direction,
        distanceToBottom: CGFloat?,
        armOlderPaging: Bool
    ) {
        direction = newDirection
        switch newDirection {
        case .older:
            followingTail = false
            if armOlderPaging, !olderPageConsumed {
                olderPageArmed = true
            }
        case .newer:
            followingTail = distanceToBottom.map(isNearTail) ?? false
            suppressesNewerPagingAfterOlder = false
        case .none:
            followingTail = false
        }
    }

    private mutating func beginNavigation(
        direction: Direction,
        followingTail: Bool
    ) {
        entryBottomLocked = false
        allowsEdgePaging = true
        self.direction = direction
        self.followingTail = followingTail
        interactionActive = false
        olderPageArmed = false
        olderPageConsumed = false
        suppressesNewerPagingAfterOlder = false
        navigationActive = true
    }

    private func isNearTail(_ distanceToBottom: CGFloat) -> Bool {
        distanceToBottom <= bottomTolerance
    }
}
