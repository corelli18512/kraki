#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

struct MacChatPresentationHealth {
    let itemCount: Int
    let intersectingSeqs: [Int]
    let realSeqs: [Int]
    let placeholderSeqs: [Int]
    let unmaterializedSeqs: [Int]
    let preparedContentCount: Int
    let exactHeightCount: Int
    let pendingHeightCount: Int
    let warmActive: Bool
    let viewportFillScheduled: Bool

    var unresolvedSeqs: [Int] {
        Array(Set(placeholderSeqs + unmaterializedSeqs)).sorted()
    }
}

/// Debug-only per-stage main-thread cost accumulator (tests enable it).
enum MacChatCost {
    #if DEBUG
    static var enabled = false
    static var buckets: [String: (count: Int, total: Double, max: Double)] = [:]
    #endif
    @inline(__always)
    static func measure<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        #if DEBUG
        guard enabled, Thread.isMainThread else { return try body() }
        let t0 = CACurrentMediaTime()
        defer {
            let ms = (CACurrentMediaTime() - t0) * 1000
            var b = buckets[label] ?? (0, 0, 0)
            b.count += 1; b.total += ms; b.max = max(b.max, ms)
            buckets[label] = b
        }
        #endif
        return try body()
    }
}

enum MacChatPerf {
    private static let logger = OSLog(subsystem: "chat.kraki.ios", category: "mac-chat-perf")
    static let enabled: Bool = {
        #if DEBUG
        ProcessInfo.processInfo.environment["KRAKI_MAC_CHAT_PERF"] == "1"
        #else
        false
        #endif
    }()

    private static var lastSlowLogTime: CFTimeInterval = 0

    static func slow(_ message: @autoclosure () -> String) {
        #if DEBUG
        let now = CACurrentMediaTime()
        guard now - lastSlowLogTime >= 0.2 else { return }
        lastSlowLogTime = now
        let line = "[SLOW][MacChat] \(message())"
        os_log("%{public}s", log: logger, type: .default, line)
        #endif
    }

    static func log(_ message: @autoclosure () -> String) {
        guard enabled else { return }
        let line = "[PERF][MacChat] \(message())"
        print(line)
        os_log("%{public}s", log: logger, type: .default, line)
    }
}

final class MacChatScrollView: MacSmoothScrollView {
    let chatDocumentView = MacChatDocumentView()

    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set { super.scrollerStyle = .overlay }
    }

    /// Shared product policy. AppKit still owns native event delivery,
    /// virtualization, anchor restoration, and animation.
    var scrollPolicy = ChatScrollPolicy()
    var followingBottom: Bool { sendTailLock || scrollPolicy.followingTail }
    /// A local send follows the newest edge until the user scrolls. Without
    /// this latch the just-inserted bubble (and a still-streaming reply) put
    /// the geometry momentarily >24 pt from the bottom, the distance rule
    /// dropped tail-following, and the Chat stopped short of the bottom.
    var sendTailLock = false
    var entryBottomLocked: Bool { scrollPolicy.entryBottomLocked }
    var allowsEdgePaging: Bool { scrollPolicy.allowsEdgePaging }
    private var bottomContentInset: CGFloat = 0
    /// The list extends under the floating header; the first message rests
    /// below it instead of colliding with the title.
    let topContentInset: CGFloat = MacChatHeaderMetrics.listTopInset
    var loadingOlder = false
    var loadingNewer = false
    var hasUnloadedNewer = false
    var suppressNewerPagingAfterOlder: Bool {
        scrollPolicy.suppressesNewerPagingAfterOlder
    }
    /// Programmatic initial layout / reanchoring must not masquerade as a user
    /// scroll at the top edge. The shared policy enables paging only after a
    /// real user interaction or navigation command.
    private var lastDocumentWidth: CGFloat = 0
    var isDeallocating = false
    private var composerSubmitObserver: NSObjectProtocol?
    private var liveScrollObserver: NSObjectProtocol?
    private var liveScrollEndObserver: NSObjectProtocol?
    var liveScrollActive = false
    var knobScrollActive = false
    var discreteWheelActive = false
    var scrollSettlePending = false
    var scrollSettleWorkItem: DispatchWorkItem?
    var scrollInteractionWatchdogWorkItem: DispatchWorkItem?
    var scrollActivityGeneration = 0
    var deferredEdgePaging = false
    var thumbViewportUpdateScheduled = false
    var thumbViewportGeneration = 0
    var snapshotApplyActive = false
    var suppressRunwayForNextReflect = false
    var olderEdgeArmed: Bool { scrollPolicy.olderPageArmed }
    var hasUserScrolled = false
    private var initialTailTrimRequested = false
    private var underfilledHistoryCheckScheduled = false
    private var underfilledHistoryPagesRequested = 0
    private var underfilledHistoryRequestedTop: Int?
    private(set) var representedSessionId: String?
    private var presentationEpoch = 0
    var diagnosticWindowTop = 0
    var diagnosticWindowBottom = 0
    private var diagnosticRawCount = 0
    private var diagnosticBubbleCount = 0
    var diagnosticAtOldest = false
    var diagnosticAtNewest = false
    private var lastPresentationLogSignature = ""
    private var presentationHealthWorkItem: DispatchWorkItem?
    var geometryAnchorLock: (key: String, delta: CGFloat)?
    var latestStartJumpPending = false
    private var bubbleActionMouseMonitor: Any?
    var pendingBubbleActionClick: (
        target: MacBubbleActionHitTarget?,
        capture: MacBubbleActionCapture,
        start: NSPoint,
        cancelled: Bool
    )?

    let jumpMaterial = MacChatScrollView.makeJumpControlMaterial()
    let jumpButton = NSButton()
    let latestStartMaterial = MacChatScrollView.makeJumpControlMaterial()
    let latestStartButton = NSButton()
    var jumpButtonVisibilityTargets: [ObjectIdentifier: Bool] = [:]
    var jumpButtonVisibilityGenerations: [ObjectIdentifier: Int] = [:]
    /// ↑ lands a reply start where the first message rests at the top.
    let latestMessageTopPadding: CGFloat = MacChatHeaderMetrics.listTopInset
    /// Round navigation controls (pointer target; iOS uses 44pt for touch).
    static let jumpControlSize: CGFloat = 36
    /// The ↑/↓ controls use the same regular Liquid Glass as the composer
    /// capsule (they only show away from the conversation bottom).
    static func isGlass(_ view: NSView) -> Bool {
        if #available(macOS 26.0, *) { return view is NSGlassEffectView }
        return false
    }

    static func makeJumpControlMaterial() -> NSView {
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.cornerRadius = jumpControlSize / 2
            return glass
        }
        let material = NSVisualEffectView()
        material.material = .hudWindow
        material.blendingMode = .withinWindow
        material.state = .active
        return material
    }
    /// ↓ sits directly above the composer's send circle (same size and
    /// column), at a fixed height: a growing composer never pushes it up.
    private var jumpFrame: NSRect {
        let size = Self.jumpControlSize
        let bottom = bottomContentInset > 0 ? MacComposerMetrics.jumpControlBottom : 16
        return NSRect(x: bounds.width - 16 - size, y: bounds.height - bottom - size, width: size, height: size)
    }
    /// ↑ rests in ↓'s slot while ↓ is hidden and is pushed up when ↓ shows.
    private var latestStartRaised = false
    /// Window resize counts as motion: reflow can carry the list across the
    /// "at bottom" line mid-drag, so ↑/↓ keep their state until it settles.
    var isResizingControls = false
    private var controlsLayoutWidth: CGFloat = 0
    private var resizeSettleGeneration = 0
    private var latestStartMoveGeneration = 0
    private var latestStartFrame: NSRect {
        let jump = jumpFrame
        let lift = latestStartRaised ? Self.jumpControlSize + MacComposerMetrics.controlGap : 0
        return jump.offsetBy(dx: 0, dy: -lift)
    }
    func placeLatestStart(raised: Bool, animated: Bool) {
        guard latestStartRaised != raised else { return }
        latestStartRaised = raised
        let target = latestStartFrame
        guard animated, window != nil, jumpButtonVisibilityTargets[ObjectIdentifier(latestStartButton)] == true else {
            latestStartMaterial.frame = target
            latestStartButton.frame = target
            return
        }
        latestStartMoveGeneration += 1
        let generation = latestStartMoveGeneration
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.3
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
            latestStartMaterial.animator().frame = target
            latestStartButton.animator().frame = target
        } completionHandler: { [weak self] in
            guard let self, self.latestStartMoveGeneration == generation else { return }
            self.latestStartMoveGeneration = 0
        }
    }
    /// A width change starts (or extends) a resize: ↑ drops any in-flight move
    /// so it is placed with ↓ every frame, and visibility is re-evaluated only
    /// after the window has held still.
    private func noteControlsWidth(_ width: CGFloat) {
        defer { controlsLayoutWidth = width }
        guard controlsLayoutWidth > 0, abs(width - controlsLayoutWidth) > 0.5 else { return }
        if latestStartMoveGeneration != 0 {
            latestStartMoveGeneration = 0
            latestStartMaterial.layer?.removeAllAnimations()
            latestStartButton.layer?.removeAllAnimations()
        }
        isResizingControls = true
        resizeSettleGeneration &+= 1
        let generation = resizeSettleGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self, self.resizeSettleGeneration == generation, self.window?.inLiveResize != true else { return }
            self.settleControlsAfterResize()
        }
    }

    private func settleControlsAfterResize() {
        guard isResizingControls else { return }
        isResizingControls = false
        updateJumpButtonVisibility(animated: true)
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        resizeSettleGeneration &+= 1
        settleControlsAfterResize()
    }

    static let unseenDotSize: CGFloat = 11
    let unseenDot = NSView()

    var onJumpToLatest: (() -> Void)?
    var onRequestLatestTail: (() -> Void)?
    var hasPendingLatestStartJump: Bool { latestStartJumpPending }
    var onScrolledNearTop: (() -> Void)?
    var onScrolledNearBottom: (() -> Void)?
    var onRenderedHeightsSettled: (() -> Void)?
    var onFirstUsableLayout: (() -> Void)?
    var canTrimTailWindow = false {
        didSet { requestInitialTailTrimIfReady() }
    }

    private func requestInitialTailTrimIfReady() {
        guard canTrimTailWindow,
              !hasUserScrolled,
              !initialTailTrimRequested,
              chatDocumentView.isFullWindowGeometryReady else { return }
        initialTailTrimRequested = true
        onRenderedHeightsSettled?()
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        drawsBackground = true
        backgroundColor = NSColor(Color.surfacePrimary)
        borderType = .noBorder
        let chatScroller = MacChatScroller()
        chatScroller.onKnobTrackingChanged = { [weak self] tracking in
            if tracking {
                self?.beginScrollInteraction(scrollerKnob: true)
            } else {
                self?.endScrollInteraction(scrollerKnob: true)
            }
        }
        verticalScroller = chatScroller
        scrollerStyle = .overlay
        hasVerticalScroller = true
        autohidesScrollers = false
        verticalPageScroll = 40
        onSmoothWheelActivityChanged = { [weak self] active in
            guard let self else { return }
            self.discreteWheelActive = active
            if active {
                self.scrollPolicy.beginUserInteraction(
                    offset: self.contentView.bounds.minY,
                    distanceToBottom: self.distanceToBottom
                )
                self.chatDocumentView.beginScrollInteraction(scrollerKnob: self.knobScrollActive)
            } else {
                self.settleScrollInteractionIfIdle()
            }
        }
        onSmoothWheelTargetChanged = { [weak self] targetY in
            self?.prefetchOlderIfNeeded(proposedY: targetY)
        }
        automaticallyAdjustsContentInsets = false
        contentInsets.top = topContentInset
        scrollerInsets.top = topContentInset
        documentView = chatDocumentView
        chatDocumentView.frame = NSRect(x: 0, y: 0, width: frameRect.width, height: 0)
        configureTransientOverlayScroller()

        liveScrollObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.willStartLiveScrollNotification,
            object: self,
            queue: .main
        ) { [weak self] _ in
            self?.beginScrollInteraction(scrollerKnob: false)
        }
        liveScrollEndObserver = NotificationCenter.default.addObserver(
            forName: NSScrollView.didEndLiveScrollNotification,
            object: self,
            queue: .main
        ) { [weak self] _ in
            self?.endScrollInteraction(scrollerKnob: false)
        }

        chatDocumentView.onWarmedHeightsReady = { [weak self] in
            guard let self else { return }
            self.commitWarmedHeightsPreservingViewport()
            _ = self.chatDocumentView.updateVisibleCells(
                in: self.contentView.bounds,
                runwayOverride: 0
            )
        }
        chatDocumentView.onAnimatedGeometryStep = { [weak self] delta in
            self?.applyAnimatedLiveHeightStep(delta)
        }
        chatDocumentView.onFullWindowGeometryReady = { [weak self] in
            self?.requestInitialTailTrimIfReady()
            self?.scheduleUnderfilledHistoryCheck()
        }
        composerSubmitObserver = NotificationCenter.default.addObserver(
            forName: .krakiComposerSubmitted,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let sessionId = note.userInfo?["sessionId"] as? String,
                  sessionId == self.representedSessionId else { return }
            self.returnToNewestAfterLocalSubmit()
        }

        for material in [jumpMaterial, latestStartMaterial] {
            // Glass shapes itself (cornerRadius); clipping or stroking its
            // layer makes it render as an opaque fill.
            if !Self.isGlass(material) {
                material.wantsLayer = true
                material.layer?.cornerRadius = Self.jumpControlSize / 2
                material.layer?.masksToBounds = true
                material.layer?.borderWidth = 0.5
            }
            material.isHidden = true
            addSubview(material)
        }

        // Double chevron = "all the way to the newest"; drawn smaller so its
        // footprint matches the single ↑ chevron.
        jumpButton.image = NSImage(systemSymbolName: "chevron.down.2", accessibilityDescription: "Jump to latest")?
            .withSymbolConfiguration(.init(pointSize: 11.5, weight: .semibold))
        jumpButton.imagePosition = .imageOnly
        jumpButton.isBordered = false
        jumpButton.target = self
        jumpButton.action = #selector(jumpTapped)
        jumpButton.isHidden = true
        jumpButton.setAccessibilityLabel("Jump to latest", toolTip: MacControlHelp.jumpToLatest)
        addSubview(jumpButton)

        latestStartButton.image = NSImage(
            systemSymbolName: "chevron.up",
            accessibilityDescription: "Jump to previous reply start"
        )?.withSymbolConfiguration(.init(pointSize: 14, weight: .semibold))
        latestStartButton.imagePosition = .imageOnly
        latestStartButton.isBordered = false
        latestStartButton.target = self
        latestStartButton.action = #selector(latestStartTapped)
        latestStartButton.isHidden = true
        latestStartButton.setAccessibilityLabel("Jump to previous reply start", toolTip: MacControlHelp.jumpToReplyStart)
        addSubview(latestStartButton)

        unseenDot.wantsLayer = true
        unseenDot.layer?.backgroundColor = NSColor.systemRed.cgColor
        unseenDot.layer?.cornerRadius = Self.unseenDotSize / 2
        unseenDot.layer?.borderWidth = 1.5
        unseenDot.isHidden = true
        unseenDot.setAccessibilityElement(false)
        addSubview(unseenDot)

        bubbleActionMouseMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp]
        ) { [weak self] event in
            EventMonitorForwarding.forward(event, owner: self) { owner, event in
                owner.interceptBubbleActionMouseEvent(event)
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let composerSubmitObserver {
            NotificationCenter.default.removeObserver(composerSubmitObserver)
        }
        scrollInteractionWatchdogWorkItem?.cancel()
        presentationHealthWorkItem?.cancel()
        scrollAnimationTimer?.invalidate()
        // tearDown (and detaching the document) resizes the document; the clip
        // view then reflects into this deallocating scroll view, whose control
        // logic forms weak references to self -> objc fatal abort. Everything
        // that runs from reflection is inert from here on.
        isDeallocating = true
        chatDocumentView.tearDown()
        if let bubbleActionMouseMonitor {
            NSEvent.removeMonitor(bubbleActionMouseMonitor)
        }
        if let liveScrollObserver {
            NotificationCenter.default.removeObserver(liveScrollObserver)
        }
        if let liveScrollEndObserver {
            NotificationCenter.default.removeObserver(liveScrollEndObserver)
        }
    }

    func prepareForSession(_ sessionId: String, unreadBoundary: Int? = nil, hadUnreadGap: Bool = false) {
        guard representedSessionId != sessionId else { return }
        representedSessionId = sessionId
        unreadEntryHadGap = hadUnreadGap
        unreadEntryKey = nil
        heldUnreadBoundary = nil
        pendingUnreadBoundary = unreadBoundary
        presentationEpoch += 1
        diagnosticWindowTop = 0
        diagnosticWindowBottom = 0
        diagnosticRawCount = 0
        diagnosticBubbleCount = 0
        diagnosticAtOldest = false
        diagnosticAtNewest = false
        lastPresentationLogSignature = ""
        presentationHealthWorkItem?.cancel()
        presentationHealthWorkItem = nil
        KLog.chatEntry(
            "mac-page reason=prepare session=\(sessionId.prefix(12)) epoch=\(presentationEpoch)"
        )
        resetSmoothWheelAnimation()
        scrollSettleWorkItem?.cancel()
        scrollSettleWorkItem = nil
        scrollInteractionWatchdogWorkItem?.cancel()
        scrollInteractionWatchdogWorkItem = nil
        scrollActivityGeneration += 1
        scrollSettlePending = false
        liveScrollActive = false
        knobScrollActive = false
        discreteWheelActive = false
        deferredEdgePaging = false
        thumbViewportGeneration += 1
        thumbViewportUpdateScheduled = false
        pendingBubbleActionClick = nil
        latestStartJumpPending = false
        jumpButtonVisibilityTargets.removeAll(keepingCapacity: true)
        jumpButtonVisibilityGenerations.removeAll(keepingCapacity: true)
        snapshotApplyActive = false
        suppressRunwayForNextReflect = false
        scrollPolicy.resetForEntry(unreadBoundary: pendingUnreadBoundary)
        pendingUnreadBoundary = nil
        sendTailLock = false
        hasUserScrolled = false
        initialTailTrimRequested = false
        underfilledHistoryCheckScheduled = false
        underfilledHistoryPagesRequested = 0
        underfilledHistoryRequestedTop = nil
        loadingOlder = false
        loadingNewer = false
        hasUnloadedNewer = false
        canTrimTailWindow = false
        geometryAnchorLock = nil
        onFirstUsableLayout = nil
        chatDocumentView.resetForSessionReuse()
        contentView.bounds.origin = NSPoint(x: 0, y: -topContentInset)
        alphaValue = 0
        setAgentTint(sessionId: sessionId)
        updateJumpButtonVisibility(animated: false)
    }

    /// Apply a SwiftUI snapshot as one visual transaction. NSScrollView can
    /// synchronously reflect a document-frame mutation before the caller has
    /// restored its visible anchor; suppress those intermediate callbacks so a
    /// prepend cannot commit one frame at the unanchored offset.
    func performAtomicSnapshot(_ updates: () -> Void) {
        snapshotApplyActive = true
        NSAnimationContext.beginGrouping()
        NSAnimationContext.current.duration = 0
        NSAnimationContext.current.allowsImplicitAnimation = false
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        updates()
        if chatDocumentView.lastApplyPrepended {
            // The preserved viewport consists of already-existing cells. Do not
            // synchronously configure the newly-prepended half-screen runway on
            // the pagination landing frame; the idle warmer prepares it after
            // the anchor is visible and stable.
            suppressRunwayForNextReflect = true
        }
        chatDocumentView.layoutSubtreeIfNeeded()
        contentView.layoutSubtreeIfNeeded()
        layoutSubtreeIfNeeded()
        snapshotApplyActive = false
        CATransaction.commit()
        NSAnimationContext.endGrouping()
        reflectScrolledClipView(contentView)
    }

    var isScrollInteractionActive: Bool {
        liveScrollActive || knobScrollActive || discreteWheelActive || scrollSettlePending
    }

    var hasDirectScrollInteraction: Bool {
        liveScrollActive || knobScrollActive || discreteWheelActive
    }

    func commitWarmedHeightsPreservingViewport(restartWarmup: Bool = false) {
        let viewport = contentView.bounds
        let fallbackAnchor = chatDocumentView.stableVisibleAnchor(in: viewport)
            ?? chatDocumentView.visibleAnchor(at: viewport.minY)
        let anchor = geometryAnchorForMutation(fallback: fallbackAnchor)
        let oldHeight = chatDocumentView.frame.height
        let oldLatestHeight = chatDocumentView.growingItemFrame()?.height ?? 0
        if restartWarmup {
            chatDocumentView.endScrollInteraction(in: viewport)
        } else {
            // Growth commits immediately (as on iOS): the bubble frame is
            // always exact, so its newest lines are never clipped.
            guard chatDocumentView.commitWarmedHeights() else { return }
        }
        let heightDelta = chatDocumentView.frame.height - oldHeight
        let following = (followingBottom || isEntryBottomLocked) && !bottomGlideActive
        // The newest bubble growing (a streamed line): the conversation glides
        // up to it instead of jumping a line in one frame. Rows above changing
        // height are compensated at once — that keeps what is on screen still.
        let tailGrowth = MacTailMotion.tailGrowth(
            documentDelta: heightDelta,
            latestHeightDelta: (chatDocumentView.growingItemFrame()?.height ?? 0) - oldLatestHeight
        )
        if following, abs(heightDelta) > 0.5 {
            contentView.bounds.origin.y += heightDelta - tailGrowth
            if tailGrowth > 0.5, hasPresentedFirstFrame {
                followTailSmoothly()
            } else {
                contentView.bounds.origin.y += tailGrowth
            }
        } else if (followingBottom || isEntryBottomLocked) && bottomGlideActive {
            // Gliding to the bottom already. A new line restarts the glide from
            // where it is now: re-targeting a nearly finished glide would cover
            // the whole line in its last frames (a jump).
            if tailGrowth > 0.5 { followTailSmoothly() }
        } else if let anchor,
                  let frame = chatDocumentView.frame(forKey: anchor.key) {
            contentView.bounds.origin.y = frame.minY + anchor.delta
        }
        applyUnreadEntryAfterGeometryChange()
        super.reflectScrolledClipView(contentView)
        adoptStableGeometryAnchorIfNeeded()
    }

    private func applyAnimatedLiveHeightStep(_ delta: CGFloat) {
        guard abs(delta) > 0.001 else { return }
        // A bottom glide re-targets every frame; compensating here as well
        // would push it past its interpolated position and pull it back.
        if (followingBottom || isEntryBottomLocked) && !bottomGlideActive {
            contentView.bounds.origin.y += delta
        }
        applyUnreadEntryAfterGeometryChange()
        chatDocumentView.layoutSubtreeIfNeeded()
        super.reflectScrolledClipView(contentView)
        updateJumpButtonVisibility(animated: false)
    }

    func geometryAnchorForMutation(
        fallback: (key: String, delta: CGFloat)?
    ) -> (key: String, delta: CGFloat)? {
        if let geometryAnchorLock,
           chatDocumentView.frame(forKey: geometryAnchorLock.key) != nil {
            return geometryAnchorLock
        }
        geometryAnchorLock = fallback
        return fallback
    }

    func adoptStableGeometryAnchorIfNeeded() {
        if let geometryAnchorLock,
           chatDocumentView.frame(forKey: geometryAnchorLock.key) != nil {
            return
        }
        geometryAnchorLock = chatDocumentView.stableVisibleAnchor(in: contentView.bounds)
    }

    override func layout() {
        MacChatCost.measure("scrollView.layout") { layoutBody() }
    }

    private func layoutBody() {
        super.layout()
        configureTransientOverlayScroller()
        let width = contentSize.width
        if abs(width - lastDocumentWidth) > 0.5 {
            lastDocumentWidth = width
        }
        chatDocumentView.setMinimumContentHeight(
            max(0, contentSize.height - topContentInset)
        )
        onFirstUsableLayout?()
        // Never cut a running glide to the bottom short: pinning here jumped to
        // the bottom for one frame, then the glide's next frame jumped back.
        if isEntryBottomLocked, !bottomGlideActive, distanceToBottom > 0.5 {
            let bottom = max(
                -topContentInset,
                chatDocumentView.tailHeight - contentView.bounds.height
            )
            contentView.bounds.origin.y = bottom
            scrollPolicy.pinToTail(observedOffset: bottom)
        }
        _ = chatDocumentView.updateVisibleCells(in: contentView.bounds)
        noteControlsWidth(bounds.width)
        let jumpFrame = self.jumpFrame
        jumpMaterial.frame = jumpFrame
        jumpButton.frame = jumpFrame
        if latestStartMoveGeneration == 0 {
            let latestStartFrame = self.latestStartFrame
            latestStartMaterial.frame = latestStartFrame
            latestStartButton.frame = latestStartFrame
        }
        let dot = Self.unseenDotSize
        unseenDot.frame = NSRect(x: jumpFrame.maxX - dot + 2, y: jumpFrame.minY - 2, width: dot, height: dot)
        var ring = NSColor.windowBackgroundColor.cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            ring = NSColor.windowBackgroundColor.cgColor
        }
        unseenDot.layer?.borderColor = ring
        scheduleUnderfilledHistoryCheck()
    }
    var navigationLoadInFlight = false
    var navigationLoadGeneration = 0

    func setBottomContentInset(_ inset: CGFloat) {
        guard abs(bottomContentInset - inset) > 0.5 else { return }
        let wasPinned = isPinnedToBottom || isEntryBottomLocked
        bottomContentInset = max(0, inset)
        // The Chat viewport and scrollbar remain full-height. The Composer is a
        // completely independent overlay; a fixed document footer reserves its
        // resting clearance (MacChatView.effectiveBottomInputHeight), which
        // already accounts for the visible gap and the last cell's padding.
        contentInsets.bottom = 0
        scrollerInsets.bottom = 0
        chatDocumentView.setBottomSafeArea(bottomContentInset)
        needsLayout = true
        if wasPinned { scrollToBottom(animated: false) }
        updateJumpButtonVisibility(animated: false)
    }

    func setLoading(
        older: Bool,
        newer: Bool,
        fetchingOlder: Bool,
        fetchingNewer: Bool,
        newerIsLocal: Bool = true
    ) {
        loadingOlder = fetchingOlder
        loadingNewer = fetchingNewer
        hasUnloadedNewer = newer
        // Newer rows still on their way from the network land silently at the
        // tail (like any chat app); only rows paged from this device's own
        // history get a bottom spinner.
        chatDocumentView.setEdgeSpinners(older: older, newer: newer && newerIsLocal)
        updateJumpButtonVisibility(animated: false)
    }

    func noteFirstUsableLayout() {
        let epoch = presentationEpoch
        DispatchQueue.main.async { [weak self] in
            guard let self, epoch == self.presentationEpoch else { return }
            // `notePresentationSnapshot` runs after the atomic AppKit apply.
            // Deferring one turn ensures initial-ready carries that window's
            // actual range/counts instead of the prepare-time zero values.
            self.emitPresentationLog(reason: "initial-ready", force: true)
        }
    }

    func notePresentationSnapshot(
        windowTop: Int,
        windowBottom: Int,
        rawCount: Int,
        bubbleCount: Int,
        atOldest: Bool,
        atNewest: Bool
    ) {
        diagnosticWindowTop = windowTop
        diagnosticWindowBottom = windowBottom
        diagnosticRawCount = rawCount
        diagnosticBubbleCount = bubbleCount
        diagnosticAtOldest = atOldest
        diagnosticAtNewest = atNewest
        scheduleUnderfilledHistoryCheck()
        emitPresentationLog(reason: "apply", force: false)
        if !chatDocumentView.presentationHealth(in: contentView.bounds).unresolvedSeqs.isEmpty {
            schedulePresentationHealthCheck()
        }
    }

    /// A compact raw tail can project to less than one screen (e.g. stopped
    /// turns). It cannot generate older scroll intent, so fill it at rest,
    /// independently of the normal user-driven edge-paging policy.
    func scheduleUnderfilledHistoryCheck() {
        guard !isDeallocating, !underfilledHistoryCheckScheduled else { return }
        underfilledHistoryCheckScheduled = true
        let epoch = presentationEpoch
        DispatchQueue.main.async { [weak self] in
            guard let self, epoch == self.presentationEpoch else { return }
            self.underfilledHistoryCheckScheduled = false
            guard !self.isDeallocating,
                  !self.snapshotApplyActive,
                  self.alphaValue > 0,
                  self.contentView.bounds.width > 1,
                  self.contentView.bounds.height > 1,
                  self.diagnosticWindowTop > 1,
                  !self.diagnosticAtOldest,
                  !self.loadingOlder, !self.loadingNewer,
                  !self.navigationLoadInFlight,
                  !self.hasPendingLatestStartJump,
                  !self.scrollPolicy.navigationActive,
                  !self.isScrollInteractionActive,
                  !self.isResizingControls, self.window?.inLiveResize != true,
                  !self.isProgrammaticScrollActive,
                  self.chatDocumentView.contents.isEmpty || self.chatDocumentView.isFullWindowGeometryReady,
                  self.underfilledHistoryPagesRequested < 8,
                  self.underfilledHistoryRequestedTop != self.diagnosticWindowTop,
                  let loadOlder = self.onScrolledNearTop else { return }
            // Do not count bottom-alignment padding, edge spinners, or composer
            // clearance as rendered history. Wait for exact row heights above.
            let frames = self.chatDocumentView.itemFrames
            let renderedHeight = (frames.last?.maxY ?? 0) - (frames.first?.minY ?? 0)
            let availableHeight = self.contentView.bounds.height - self.topContentInset
                - self.chatDocumentView.bottomSafeArea
            guard renderedHeight < availableHeight - 1 else { return }
            // Consume before dispatch: SwiftUI/provider loading flags can lag
            // one turn. A no-progress request must not spin on the same edge.
            self.underfilledHistoryRequestedTop = self.diagnosticWindowTop
            self.underfilledHistoryPagesRequested += 1
            loadOlder()
        }
    }

    func schedulePresentationHealthCheck() {
        // Streaming snapshots may arrive 10–20 times per second. Keep the first
        // deadline for this epoch instead of perpetually postponing diagnosis;
        // the work item reads the latest window metadata when it fires.
        guard presentationHealthWorkItem == nil else { return }
        let epoch = presentationEpoch
        let work = DispatchWorkItem { [weak self] in
            guard let self, epoch == self.presentationEpoch else { return }
            self.presentationHealthWorkItem = nil
            let health = self.chatDocumentView.presentationHealth(in: self.contentView.bounds)
            if !self.isScrollInteractionActive, !health.unresolvedSeqs.isEmpty {
                _ = self.chatDocumentView.updateVisibleCells(
                    in: self.contentView.bounds,
                    runwayOverride: 0
                )
            }
            let refreshed = self.chatDocumentView.presentationHealth(in: self.contentView.bounds)
            self.emitPresentationLog(
                reason: refreshed.unresolvedSeqs.isEmpty
                    ? "viewport-resolved"
                    : "viewport-stuck",
                force: true
            )
        }
        presentationHealthWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75, execute: work)
    }

    func emitPresentationLog(reason: String, force: Bool) {
        guard let representedSessionId else { return }
        let health = chatDocumentView.presentationHealth(in: contentView.bounds)
        let signature = "\(diagnosticWindowTop):\(diagnosticWindowBottom):\(health.itemCount):"
            + "\(health.realSeqs):\(health.placeholderSeqs):\(health.unmaterializedSeqs):"
            + "\(health.preparedContentCount):\(health.exactHeightCount):"
            + "\(health.pendingHeightCount):\(health.warmActive):"
            + "\(loadingOlder):\(loadingNewer):\(diagnosticAtOldest):\(diagnosticAtNewest)"
        guard force || signature != lastPresentationLogSignature else { return }
        lastPresentationLogSignature = signature
        KLog.chatEntry(
            "mac-page reason=\(reason) session=\(representedSessionId.prefix(12)) "
                + "epoch=\(presentationEpoch) window=[\(diagnosticWindowTop),\(diagnosticWindowBottom)] "
                + "raw=\(diagnosticRawCount) bubbles=\(diagnosticBubbleCount) "
                + "viewport=\(health.intersectingSeqs) real=\(health.realSeqs) "
                + "placeholders=\(health.placeholderSeqs) missing=\(health.unmaterializedSeqs) "
                + "prepared=\(health.preparedContentCount) "
                + "exact=\(health.exactHeightCount) pendingHeight=\(health.pendingHeightCount) "
                + "warm=\(health.warmActive ? 1 : 0) fill=\(health.viewportFillScheduled ? 1 : 0) "
                + "offset=\(Int(contentView.bounds.minY)) distanceBottom=\(Int(distanceToBottom)) "
                + "atOldest=\(diagnosticAtOldest ? 1 : 0) atNewest=\(diagnosticAtNewest ? 1 : 0) "
                + "fetchOlder=\(loadingOlder ? 1 : 0) fetchNewer=\(loadingNewer ? 1 : 0)"
        )
    }
    /// Replies that landed while the reader was away from the bottom; shown
    /// as a red dot on ↓ and cleared on reaching the bottom.
    var unseenReplies = 0 {
        didSet { syncUnseenDot() }
    }
    // MARK: Unread entry (ChatScrollPolicy.UnreadEntry, same rule as iPhone)

    private var pendingUnreadBoundary: Int?
    /// The first new message whose start is held at the top.
    var unreadEntryKey: String?
    var heldUnreadBoundary: Int?
    /// The entry had a real red dot (SessionStore.entryUnreadGaps).
    var unreadEntryHadGap = false
    /// Entered with new messages and the user hasn't scrolled: an entry pin
    /// lands on the first new message's start when it wouldn't be readable at
    /// the tail, and keeps holding it there while heights settle.
    var applyingUnreadEntry = false
    // MARK: Programmatic scroll animation

    /// Navigation glides are driven by our own timer (not `animator()`): the
    /// target is re-evaluated every frame (content may grow or be measured
    /// during the glide), any user scroll cancels it immediately, and it does
    /// not depend on the window being on screen.
    var scrollAnimationTimer: Timer?
    var scrollAnimation: (
        start: CFTimeInterval, duration: CFTimeInterval, from: CGFloat,
        target: () -> CGFloat, completion: (() -> Void)?, follow: Bool, last: CFTimeInterval
    )?
    var bottomGlideActive = false

    /// The glide keeps moving after the last wheel event; a reading-anchor
    /// lock captured earlier would pull the viewport back to that stale
    /// position on the next snapshot (seen as a ~30pt jump during history
    /// loading).
    override func smoothWheelWillMove() {
        geometryAnchorLock = nil
    }
}

#endif
