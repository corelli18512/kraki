#if os(iOS)
import SwiftUI
import UIKit
import os

// =====================================================================
// The production iOS chat list (used by ChatView).
//
// Despite the "Perf" name (it began as a scroll-performance harness), this
// is the real conversation list: a newest-at-bottom UICollectionView that
// windows the session's flat spine through MessageProvider / MessageStore.
//
//   • ChatPerfListVC  — UICollectionView with a flow layout, an explicit
//     cached-height sizer, a manual data source driven by
//     performBatchUpdates, and inline header/footer pagination spinners.
//   • Heights come from the offscreen TextKit self-size path, pre-warmed by
//     HeightMeasurementScheduler so scrolling never measures on the frame.
//   • chatPerfLog — debug-only perf logging (frame drops, apply timings).
//
// Model swaps around performBatchUpdates are order-sensitive; read the
// comments at each `items =` assignment before changing them.
// =====================================================================

// MARK: - View controller (clean-room collection view)

final class ChatPerfListVC: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {

    let sizer = RealCellSizer()

    /// Upgrades only the currently visible height cache after entry or scroll
    /// settling, ≤budget ms per frame. Pending jobs are discarded as soon as a
    /// gesture or navigation transition begins so exact measurement never owns
    /// an interaction frame.
    let warmer = HeightMeasurementScheduler(budgetMs: 4.0)

    /// Dedicated scheduler for the ONE page a pending paginate is about to
    /// prepend/append. Unlike `warmer` it is NEVER paused: a loadOlder's
    /// anchor correction NEEDS those heights, and we'd rather budget-slice
    /// the measurement across a few frames behind the spinner than pay it as
    /// one synchronous ~60ms freeze on the apply frame. Runs only during the
    /// brief load window, so the reduced scroll headroom is barely felt.
    let pager = HeightMeasurementScheduler(budgetMs: 4.0)

    /// Injected identity. The real session id + agent so cells render the
    /// production TextKit bubble with correct tint, and so the view model can
    /// preload this session's history from GRDB.
    let sessionId: String
    let agentName: String
    var bottomContentInset: CGFloat
    /// How far the floating composer rises above its resting footprint. Added
    /// to the scrollable range only, so the bubbles it covers can be scrolled
    /// into view; the newest edge (follow, ↓, distance-to-bottom) keeps resting
    /// on the resting composer, so its growth never moves the conversation.
    var composerOverlayInset: CGFloat = 0
    /// Shared product policy. UIKit still owns gesture delivery, geometry,
    /// anchoring, and animation; entry/follow/intent/paging rules are identical
    /// to the AppKit adapter through this platform-neutral state machine.
    var scrollPolicy = ChatScrollPolicy()
    var underfilledHistory = IOSUnderfilledHistoryState()
    /// Read position this Session was entered with (new messages / notification).
    let unreadEntryBoundary: Int?
    /// The entry had a real red dot (SessionStore.entryUnreadGaps).
    let unreadEntryHadGap: Bool
    /// The first new message held under the top glass (UnreadEntry.anchored).
    var unreadAnchorID: String?
    var followingBottom: Bool { scrollPolicy.followingTail }
    private var entryBottomLocked: Bool { scrollPolicy.entryBottomLocked }
    var allowsEdgePaging: Bool { scrollPolicy.allowsEdgePaging }
    private var scrollingTowardOlder: Bool { scrollPolicy.scrollingTowardOlder }
    var lastPinnedViewportSize: CGSize = .zero
    var lastPinnedAdjustedInsets: UIEdgeInsets = .zero
    var isPinningBottom = false
    static let liveCardID = "__live_card__"

    // MARK: New bubble entrance (parity with Mac `MacChatDocumentView`)

    /// Bubbles newly added at the tail that should make an entrance the first
    /// time they are displayed: the user's from the trailing edge, the AI's
    /// from the leading edge. Expire if never shown.
    var pendingEntrances: [String: (fromTrailing: Bool, deadline: CFTimeInterval)] = [:]
    static let entranceDuration: CFTimeInterval = 0.32
    static let entranceOffset: CGFloat = 48
    static let entranceTiming = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
    #if DEBUG
    var entranceLog: [(id: String, fromTrailing: Bool)] = []
    var arrivalGlideLog: [CGFloat] = []
    #endif
    var onResolvePermission: (String, String?, String) -> Void = { _, _, _ in }
    var onAnswerQuestion: (String, String) -> Void = { _, _ in }
    var onOpenImage: (IOSImagePreviewSelection) -> Void = { _ in }
    var onOpenHTMLArtifact: (ContentRef) -> Void = { _ in }

    /// Flat pure-spine data source. `vm.displayMessages` contains one item per renderable persisted message; paging moves the raw seq window,
    /// then `refreshSpineSnapshot()` snapshots it off the scroll frame.
    let vm: ChatViewModel
    let appState: AppState
    private(set) var collectionView: UICollectionView!
    private let scrollIndicator = IOSTransientScrollIndicator()

    /// The shared message store (window data layer). Held so the view can inject
    /// its rendered-height oracle for the PX-based window cap (`heightForSeq` /
    /// `maxWindowPx`) — see `refreshSpineSnapshot()`/`seqToTurnId` and the init wiring.
    private let store: MessageStore
    /// Target max rendered height (px) of the in-memory window. Ported from the
    /// validated ScrollPerfTest engine (~14 screens): keeps the window large
    /// enough that both paging edges stay far apart (incremental applies, no
    /// older↔newer ping-pong) regardless of how TALL the turns are — the count
    /// cap collapsed tall-turn windows below one screen and self-oscillated.
    private let maxWindowPx: CGFloat = 12_000
    /// Maps each rendered message seq to its item id. The store's px-window
    /// oracle reads the cached TextKit height through this map.
    private var seqToTurnId: [Int: String] = [:]

    /// View-local flat-spine snapshot, refreshed only outside scroll frames so
    /// cell and size lookup stay O(1).
    var messages: [ChatMessage] = []
    private var byId: [String: ChatMessage] = [:]

    init(sessionId: String, appState: AppState, agent: String, bottomContentInset: CGFloat,
         onResolvePermission: @escaping (String, String?, String) -> Void = { _, _, _ in },
         onAnswerQuestion: @escaping (String, String) -> Void = { _, _ in },
         onOpenImage: @escaping (IOSImagePreviewSelection) -> Void = { _ in },
         onOpenHTMLArtifact: @escaping (ContentRef) -> Void = { _ in }) {
        self.sessionId = sessionId
        self.agentName = agent
        self.bottomContentInset = bottomContentInset
        self.onResolvePermission = onResolvePermission
        self.onAnswerQuestion = onAnswerQuestion
        self.onOpenImage = onOpenImage
        self.onOpenHTMLArtifact = onOpenHTMLArtifact
        self.vm = ChatViewModel(sessionId: sessionId, appState: appState)
        self.unreadEntryBoundary = appState.sessionStore.entryUnreadBoundaries[sessionId]
        self.unreadEntryHadGap = appState.sessionStore.entryUnreadGaps.contains(sessionId)
        self.appState = appState
        self.store = appState.messageStore
        super.init(nibName: nil, bundle: nil)
        scrollPolicy.resetForEntry(unreadBoundary: unreadEntryBoundary)
        sizer.sessionId = sessionId
        sizer.agent = agent
        sizer.contentBuilder = { [weak self] message in
            guard let self else {
                return TKBubbleContent.make(message: message, sessionId: sessionId, agent: agent)
            }
            return self.bubbleContent(for: message)
        }
        sizer.onHeightReady = { [weak self] id in
            self?.scheduleHeightRefresh(for: id)
        }
        // PX window cap: feed the store the rendered height of each turn (keyed
        // by end seq) so `expandWindow` trims the far edge by SCREEN HEIGHT, not
        // message count. Reads the live sizer cache via `seqToTurnId` (built in
        // `refreshSpineSnapshot`); unwarmed turns report 0 (safe — under-trims transiently).
        store.maxWindowPx = maxWindowPx
        store.heightForSeq = { [weak self] _, seq in
            guard let self, let id = self.seqToTurnId[seq] else { return 0 }
            return self.sizer.cached(id) ?? 0
        }
        // Materialise the seq window from DB (idempotent), then snapshot it.
        _ = appState.messageProvider?.openSession(sessionId)
        refreshSpineSnapshot()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // MARK: - Data snapshot

    /// Turn ids in the current snapshot (oldest→newest). The engine's diff key.
    var ids: [String] {
        var result = messages.map(\.id)
        // Last, or above a steer the agent has not read yet (MessageStore+SteerPlacement).
        if let card = vm.card, !card.text.isEmpty || card.action != nil { result.insert(Self.liveCardID, at: card.rowIndex(in: messages)) }
        return result
    }
    var messageCount: Int { messages.count }
    /// Edge indicators describe pagination of an already materialized window.
    /// They must stay off during the empty initial bootstrap; otherwise the
    /// unknown window is rendered as two permanent loading states.
    var hasLoadedWindow: Bool { !items.isEmpty && vm.windowTopSeq > 0 }
    func message(_ id: String) -> ChatMessage? { byId[id] }
    var atOldest: Bool { vm.atHistoryStart }
    var atNewest: Bool { vm.atHead }
    /// The bottom spinner means "newer rows from this device's own history
    /// are being paged in". Messages still arriving from the network land at
    /// the tail silently, as in any chat app, so they never show it.
    var showsNewerSpinner: Bool { hasLoadedWindow && vm.hasNewerLocalRows }

    /// Refresh the flat message snapshot at rest, never on a scroll frame.
    func refreshSpineSnapshot() {
        vm.refreshMessageCache()
        // Pure spine is already flat: every renderable persisted message is one
        // standalone bubble. Tool/narration/action detail lives off-spine and
        // must never be reconstructed as grouped block cells here.
        messages = vm.displayMessages
        byId = Dictionary(messages.lazy.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        // One rendered item maps to one persisted spine seq.
        var seqMap: [Int: String] = [:]
        seqMap.reserveCapacity(messages.count)
        for message in messages {
            seqMap[message.seq] = message.id
        }
        seqToTurnId = seqMap
        lastLiveCardSignature = liveCardSignature
        lastSyncedSignature = "\(vm.filteredMessages.count)|\(vm.windowTopSeq)|\(vm.windowBottomSeq)|\(vm.sessionLastSeq)|\(lastLiveCardSignature)|\(vm.pendingSignature)"
        lastPendingSignature = vm.pendingSignature
    }

    // MARK: - Correctness checks (log-based debug)

    var nextTxnId = 0
    /// Manual model array (window seqs). Replaces the diffable data
    /// source: a sliding window shifts every retained item's index, which
    /// diffable interprets as ~70 "moves" per page (~20ms apply). Manual
    /// front/back insert+delete lets UIKit shift the middle implicitly —
    /// no move enumeration — which is what makes fast paging silky.
    var items: [String] = []
    /// Signature of the last refresh the spine snapshot (window count + bottom seq + streaming).
    /// `updateUIViewController` compares it to detect new live messages.
    var lastSyncedSignature = ""
    var lastPendingSignature = ""
    var lastLiveCardSignature = ""
    var lastEntryDiagnosticSignature = ""
    #if DEBUG
    var alignmentRevision = 0
    #endif
    /// One live-card content object per card revision. sizeForItemAt, cell
    /// configuration and geometry invalidation all read the same instance, so
    /// its height is measured once per revision.
    var liveContentMemo: (signature: String, width: CGFloat, content: TKBubbleContent)?
    /// In-flight guards, per edge. While a page is being "fetched"
    /// (simulated latency) we keep the edge gated so scrolling doesn't
    /// spawn duplicate loads, and we show that edge's spinner.
    ///
    /// `loadingOlder`/`loadingNewer` are now the PERSISTENT edge "loading
    /// earlier/newer messages" spinners — shown exactly while history remains
    /// undisplayed on that side (`!atOldest`/`!atNewest`), living as a section
    /// header/footer beyond the loaded rows, and auto-managed inside
    /// `applyEdges` (no longer fetch gates). Serialising the fetches are
    /// `fetchingOlder`/`fetchingNewer` below.
    var loadingOlder = false
    var loadingNewer = false
    /// A fetch round-trip is in flight (serializes fetches per edge, one at a
    /// time). Separate from the now-persistent edge spinners.
    var fetchingOlder = false
    var fetchingNewer = false
    /// A fetched page is still queued for exact measurement. Keep this state
    /// separate from the DB read so live synchronization cannot reveal cold
    /// rows in the gap between fetch completion and the pager barrier.
    var measuringOlderPage = false
    var measuringNewerPage = false
    private var paginationResumeScheduled = false
    /// The model snapshot has advanced past `items`, but those edge rows are
    /// intentionally buffered until measurement and a stable anchored apply.
    var paginationSnapshotDeferred = false
    var didInitialScroll = false
    /// Bumped on every re-anchor (jump-to-latest) so a fetch that was already
    /// in flight when the window was reset can detect it is stale and bail
    /// instead of applying against the fresh window. (The provider's DB read
    /// already re-validates `topSeq`, so it won't mutate the store across a
    /// reset; this token guards the grouping/flush that follows.)
    var pagingGeneration = 0
    /// Two floating navigation controls share the same lower-right rail:
    /// "latest message start" places the newest bubble below the top chrome,
    /// while "latest" keeps the existing live-tail behavior. They are UIKit
    /// siblings of the collection view so the SwiftUI wrapper stays simple.
    let jumpButton = UIButton(type: .system)
    let latestMessageStartButton = UIButton(type: .system)
    var jumpButtonBlur: UIVisualEffectView?
    var latestMessageStartButtonBlur: UIVisualEffectView?
    var jumpButtonBottomConstraint: NSLayoutConstraint?
    /// ↑ rests in ↓'s slot while ↓ is hidden and is pushed up when ↓ appears.
    var latestStartBottomConstraint: NSLayoutConstraint?
    var jumpButtonVisibilityTargets: [ObjectIdentifier: Bool] = [:]
    var jumpButtonVisibilityGenerations: [ObjectIdentifier: Int] = [:]
    let unseenBadge = UIView()
    /// Flip to `true` for the spinner-free local-seamless experiment.
    /// `false` = the robust, production-style experience: show a loading
    /// spinner at the edge the moment pagination triggers, keep it up through
    /// fetch + measure, and only hide it when the page is anchored in. The
    /// spinner row sits above/below the viewport, so a fling that outruns the
    /// load lands on the spinner (a real loading indicator) instead of blank.
    private let localSeamless = false
    // The status-bar "tap to scroll to top" gesture animates contentOffset to
    // 0. In a paginated list that target keeps chasing the top, so each
    // prepend is immediately undone by the animation and the trigger band is
    // re-entered → runaway loadOlder. While this gesture is in flight we
    // suppress pagination entirely: it simply glides to the top of the
    // currently-loaded content and stops.
    var scrollingToTop = false
    /// A page that "arrived" while the list was coasting on natural
    /// momentum. We must NOT re-base contentOffset under an in-flight
    /// deceleration (its absolute target would snap the content), so we
    /// stash the apply here and run it the moment the slide settles
    /// (didEndDecelerating) — keeping the fling perfectly natural.
    var pendingApply: (() -> Void)?
    // Frame-time monitor.
    var displayLink: CADisplayLink?
    var warmKickWork: DispatchWorkItem?
    var isLeavingView = false
    var lastFrameTs: CFTimeInterval = 0
    var hitchCount = 0
    var worstFrameMs: Double = 0
    let overlay = UILabel()
    var codeHighlightObserver: NSObjectProtocol?
    private var composerSubmitObserver: NSObjectProtocol?
    var textSizeObserver: NSObjectProtocol?
    /// The text size this list's rows were laid out for (see TKTextSize).
    var laidOutTextSize = ""
    /// The list width the rows were laid out for. iPhone Duo fold/unfold,
    /// iPad resizing and rotation change it while the chat is open.
    var laidOutWidth: CGFloat = 0
    /// What the reader was looking at while the width was `laidOutWidth`.
    /// Kept up to date on scroll and layout: by the time a width change is
    /// noticed, UIKit has already resized the list, so it can't be read then.
    var lastReadingAnchor: ReadingAnchor?
    var widthRelayoutScheduled = false
    /// Bumped on a re-layout, on every user scroll and on ↑/↓ navigation:
    /// late anchor corrections stop as soon as the user takes over.
    var widthAnchorGeneration = 0
    var codeHighlightSettleWork: DispatchWorkItem?
    var pendingCodeHighlightRefresh = false
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        chatPerfLog.log("[cfg] renderer=textkit localSeamless=\(localSeamless)")
        chatPerfLog.log("[diag] viewDidLoad turns=\(messages.count) ids=\(items.count) winTop=\(vm.windowTopSeq) winBot=\(vm.windowBottomSeq) sessionLast=\(vm.sessionLastSeq) filtered=\(vm.filteredMessages.count)")
        TKTextSize.refresh()
        laidOutTextSize = TKTextSize.key
        setupCollectionView()
        let endSelection = UITapGestureRecognizer(target: self, action: #selector(endTextSelectionTap(_:)))
        endSelection.cancelsTouchesInView = false
        endSelection.delegate = textSelectionTapDelegate
        collectionView.addGestureRecognizer(endSelection)
        installRelayoutObservers()
        setupJumpButton()
        composerSubmitObserver = NotificationCenter.default.addObserver(
            forName: .krakiComposerSubmitted,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  note.userInfo?["sessionId"] as? String == self.sessionId else { return }
            self.returnToNewestAfterLocalSubmit()
        }
        if Self.perfOverlayEnabled {
            setupOverlay()
        }
        applyInitial()
        logEntryState("viewDidLoad")
        if Self.perfOverlayEnabled {
            startFrameMonitor()
        } else {
            startHitchMonitor()
        }
    }

    deinit {
        if let composerSubmitObserver {
            NotificationCenter.default.removeObserver(composerSubmitObserver)
        }
        if let textSizeObserver {
            NotificationCenter.default.removeObserver(textSizeObserver)
        }
        displayLink?.invalidate()
        warmKickWork?.cancel()
        codeHighlightSettleWork?.cancel()
        if let codeHighlightObserver {
            NotificationCenter.default.removeObserver(codeHighlightObserver)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        isLeavingView = false
        settleInitialVisibleGeometryBeforePresentation()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        isLeavingView = false
        pager.resume()
        resumeBufferedPageMeasurements()
        logEntryState("viewDidAppear")
        // Catch rows that materialized after viewWillAppear (for example an
        // empty DB window filled by the provider), then start the delayed
        // look-ahead pass. Ordinary loaded entry rows were already settled
        // before the navigation transition was presented.
        warmWindow(radius: 0)
        scheduleWarmKick()
        scheduleUnderfilledHistoryCheck()
    }

    override func viewWillDisappear(_ animated: Bool) {
        scrollIndicator.hide()
        isLeavingView = true
        warmKickWork?.cancel()
        warmKickWork = nil
        cancelPendingWarm()
        cancelPageMeasurements()
        chatPerfLog.log("[lifecycle] willDisappear movingFromParent=\(isMovingFromParent ? 1 : 0)")
        super.viewWillDisappear(animated)
    }

    override func viewDidDisappear(_ animated: Bool) {
        logEntryState("viewDidDisappear")
        super.viewDidDisappear(animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollIndicator.updateGeometry()
        handleWidthChangeIfNeeded()
        scheduleUnderfilledHistoryCheck()
        // A hidden/zero-width page may have deferred starting a barrier. Retry
        // after layout, never re-enter a collection batch from inside layout.
        if !isLeavingView, view.window != nil, collectionView.bounds.width > 0,
           paginationSnapshotDeferred || pendingApply != nil,
           !measuringOlderPage, !measuringNewerPage, !paginationResumeScheduled {
            paginationResumeScheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.paginationResumeScheduled = false
                self.resumeBufferedPageMeasurements()
            }
        }
        logEntryState("layout")
        guard collectionView != nil,
              didInitialScroll,
              (entryBottomLocked || followingBottom || scrollPolicy.unreadEntry == .anchored),
              !scrollingTowardOlder,
              !isPinningBottom else { return }
        let viewportChanged = collectionView.bounds.size != lastPinnedViewportSize
        let insetsChanged = tailAdjustedInsets != lastPinnedAdjustedInsets
        guard viewportChanged || insetsChanged else { return }
        // Keyboard presentation, safe-area resolution and multiline composer
        // growth can all happen after the data's initial scroll. Re-pin after
        // UIKit has resolved the final viewport/insets for this layout pass.
        pinToBottom(reason: "layout")
    }

    // MARK: Setup

    private func setupCollectionView() {
        // Flow layout with EXPLICIT per-item heights from the sizer
        // cache (estimatedItemSize=.zero disables self-sizing). Frames
        // are pure arithmetic over cached heights, so a 100-row apply
        // doesn't re-measure cells — the whole point of the height cache.
        let layout = ChatFlowLayout()
        layout.scrollDirection = .vertical
        layout.minimumLineSpacing = 0
        layout.minimumInteritemSpacing = 0
        layout.sectionInset = .zero
        layout.estimatedItemSize = .zero

        collectionView = UICollectionView(frame: view.bounds, collectionViewLayout: layout)
        collectionView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.register(TKBubbleCell.self,
                                forCellWithReuseIdentifier: TKBubbleCell.reuseID)
        collectionView.register(SpinnerReusableView.self,
                                forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
                                withReuseIdentifier: SpinnerReusableView.reuseID)
        collectionView.register(SpinnerReusableView.self,
                                forSupplementaryViewOfKind: UICollectionView.elementKindSectionFooter,
                                withReuseIdentifier: SpinnerReusableView.reuseID)
        collectionView.alwaysBounceVertical = true
        // Scrolling the conversation dismisses the keyboard. `.onDrag` rather
        // than `.interactive`: the SwiftUI composer follows the keyboard safe
        // area, not the finger, so interactive dismissal would visibly tear
        // the keyboard away from the floating composer.
        collectionView.keyboardDismissMode = .onDrag
        collectionView.contentInset.bottom = bottomContentInset
        collectionView.verticalScrollIndicatorInsets.bottom = bottomContentInset
        // Breathing room under the navigation glass when a conversation is
        // shorter than the screen (a new Session's first message otherwise
        // sits flush against the bar).
        collectionView.contentInset.top = Self.topContentPadding
        collectionView.verticalScrollIndicatorInsets.top = Self.topContentPadding
        view.addSubview(collectionView)
        scrollIndicator.attach(to: collectionView)

        // Install the offscreen sizer container so its trait environment
        // (Dynamic Type, interface style) matches the live list — otherwise
        // measured heights drift from rendered ones. Pinned but invisible.
        view.addSubview(sizer.container)
        NSLayoutConstraint.activate([
            sizer.container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            sizer.container.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            sizer.container.topAnchor.constraint(equalTo: view.topAnchor),
            sizer.container.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    let spinnerRowHeight: CGFloat = 44
    /// Headroom (pt from the top edge) that defines the "near top" reveal line
    /// for older pagination. Mirrors the test page's `pageTriggerHeadroom`.
    let pageTriggerHeadroom = ChatScrollPolicy.edgeTriggerDistance

    // MARK: Data source (manual)

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        items.count
    }

    var hasLiveCardItem: Bool { items.contains(Self.liveCardID) }
    private func isLiveCard(_ index: Int) -> Bool { index < items.count && items[index] == Self.liveCardID }

    /// A frozen card (`turn_status` / `interrupted_turn`, or a question)
    /// reuses the SAME bubble as the streaming card — frozen read-only with
    /// the action slot set to the terminal outcome or the question's choices
    /// (`ChatMessage.frozenCard`). Mirrors web `MessageBubble`
    /// (#162/#164/#168): no separate chrome, just the live card stopped.
    func frozenRow(_ index: Int) -> (message: ChatMessage, card: MessageStore.SessionCard)? {
        guard index < items.count, let message = message(items[index]),
              let card = message.frozenCard else { return nil }
        return (message, card)
    }

    /// Build the same content description used by a visible cell and by the
    /// offscreen warm sizer. Frozen terminal messages use the live-card path.
    private func bubbleContent(for message: ChatMessage) -> TKBubbleContent {
        if let card = message.frozenCard {
            return TKBubbleContent.live(
                card: card,
                agent: agentName,
                sessionId: sessionId,
                steps: message.steps ?? 0,
                isFrozen: true,
                frozenTimestamp: message.finishedAt ?? message.timestamp,
                attachments: message.contentRefAttachments
            )
        }
        return TKBubbleContent.make(message: message, sessionId: sessionId, agent: agentName)
    }

    private let textSelectionTapDelegate = SimultaneousTapDelegate()

    /// A tap outside the selected text ends an in-bubble selection.
    @objc private func endTextSelectionTap(_ gesture: UITapGestureRecognizer) {
        TKBubbleCell.endActiveTextSelection(unlessAt: gesture.location(in: nil))
    }

    /// Toggle body text selection/links on visible TextKit cells. Off during
    /// scroll (the UITextInteraction is the only per-cell fling cost), on at rest.
    private func setVisibleBodiesInteractive(_ on: Bool) {
        for c in collectionView.visibleCells { (c as? TKBubbleCell)?.setBodyInteractive(on) }
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let t0 = CFAbsoluteTimeGetCurrent()
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: TKBubbleCell.reuseID, for: indexPath) as! TKBubbleCell
        configureCell(cell, at: indexPath)
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        if ms > 3 { chatPerfLog.log("[cell] slow configure item=\(indexPath.item) ms=\(String(format: "%.1f", ms))") }
        return cell
    }

    /// Configure `cell` for the row at `indexPath`. Shared by dequeue and by
    /// in-place tail updates (which re-point an existing visible cell at a new
    /// row identity instead of reloading the list).
    func configureCell(_ cell: TKBubbleCell, at indexPath: IndexPath) {
        cell.sessionMode = vm.session?.mode ?? .auto
        cell.attachmentStore = appState.attachmentStore
        cell.onResolvePermission = onResolvePermission
        cell.onAnswerQuestion = onAnswerQuestion
        cell.onOpenImage = onOpenImage
        cell.onOpenHTMLArtifact = onOpenHTMLArtifact
        cell.onShowTable = { [weak self] layout in
            let table = TKTableSheetViewController(layout: layout)
            let navigation = UINavigationController(rootViewController: table)
            navigation.modalPresentationStyle = .pageSheet
            self?.present(navigation, animated: true)
        }
        cell.onPendingAction = { [weak self] clientId, action in
            self?.handlePendingAction(clientId: clientId, action: action)
        }
        cell.onActionHeightChange = { [weak self, weak cell] in
            guard let self, let cell else { return }
            // SwiftUI action/image UI resized (permission state or lazy image).
            // Preserve the cell and animate only its geometry from the current
            // presentation state; a reload would flash reused TextKit surfaces.
            if let content = cell.contentSnapshot {
                TKBubbleContent.bust(content.message.id)
            }
            self.animateHeightChange(for: cell)
        }
        if isLiveCard(indexPath.item), let card = vm.card {
            // Streaming tail: ONE component — same TKBubbleCell as a completed
            // bubble, with the card's draft as the body and card.action as the
            // action slot. No separate live-card component.
            let content = liveContent(card)
            cell.configure(content, cellWidth: collectionView.bounds.width)
            cell.onOpenSteps = { [weak self] _ in self?.presentLiveSteps() }
        } else if let (message, card) = frozenRow(indexPath.item) {
            // Frozen card: the SAME bubble as streaming, frozen with a real
            // timestamp + terminal outcome / question choices.
            let content = TKBubbleContent.live(card: card, agent: agentName,
                                                sessionId: sessionId,
                                                steps: message.steps ?? 0,
                                                isFrozen: true,
                                                frozenTimestamp: message.finishedAt ?? message.timestamp,
                                                attachments: message.contentRefAttachments)
            cell.configure(content, cellWidth: collectionView.bounds.width)
            cell.onOpenSteps = { [weak self] _ in self?.presentSteps(for: message) }
        } else if indexPath.item < items.count, let message = message(items[indexPath.item]) {
            let content = TKBubbleContent.make(message: message, sessionId: sessionId, agent: agentName)
            cell.configure(content, cellWidth: collectionView.bounds.width)
            cell.onOpenSteps = { [weak self] message in
                self?.presentSteps(for: message)
            }
            cell.setBodyInteractive(!collectionView.isDragging && !collectionView.isDecelerating)
        } else {
            chatPerfLog.log("[cell] OOB guard item=\(indexPath.item) count=\(items.count)")
        }
    }

    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        sizeForItemAt indexPath: IndexPath) -> CGSize {
        let w = collectionView.bounds.width
        if isLiveCard(indexPath.item) {
            if let card = vm.card {
                let height = liveContent(card).cellHeight(cellWidth: w)
                lastLiveCardHeight = height
                return CGSize(width: w, height: height)
            }
            // The card was just cleared but the row is still in the model
            // (the answer replaces it in the next update): keep its geometry
            // rather than collapsing it, which clamped the scroll offset.
            if let lastLiveCardHeight { return CGSize(width: w, height: lastLiveCardHeight) }
        }
        guard indexPath.item < items.count, let message = message(items[indexPath.item]) else {
            return CGSize(width: w, height: 44)
        }
        sizer.prepare(width: w)
        // Cold rows use a cheap estimate. Exact TextKit geometry is upgraded
        // by warmWindow() in display-link budget slices and invalidated in a
        // coalesced layout pass, so initial reloadData never measures the whole
        // loaded window synchronously on the main thread.
        let height = sizer.cached(message.id)
            ?? sizer.estimatedHeight(for: message, width: w)
        return CGSize(width: w, height: height)
    }

    func presentLiveSteps() {
        guard let userSeq = vm.lastUserMessage?.seq else { return }
        // Running turn: request now so the trace starts loading while the sheet
        // animates up; the sheet's `.onAppear` also re-pulls on every open so
        // the steps reflect the current tail.
        vm.requestSteps(forBubbleSeq: userSeq)
        let view = StepsSheetView(
            sessionId: sessionId,
            targetSeq: userSeq,
            live: true,
            agent: agentName,
            store: store
        )
        .environment(appState)
        let host = UIHostingController(rootView: view)
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(host, animated: true)
    }

    private func presentSteps(for message: ChatMessage) {
        guard message.seq > 0 else { return }
        vm.requestSteps(forBubbleSeq: message.seq)
        let view = StepsSheetView(
            sessionId: sessionId,
            targetSeq: message.seq,
            agent: agentName,
            store: store
        )
        .environment(appState)
        let host = UIHostingController(rootView: view)
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
        }
        present(host, animated: true)
    }

    // Inline spinner as section header (top / loadOlder) and footer
    // (bottom / loadNewer): zero size unless that edge is loading.
    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForHeaderInSection section: Int) -> CGSize {
        loadingOlder ? CGSize(width: collectionView.bounds.width, height: spinnerRowHeight) : .zero
    }

    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        referenceSizeForFooterInSection section: Int) -> CGSize {
        loadingNewer ? CGSize(width: collectionView.bounds.width, height: spinnerRowHeight) : .zero
    }

    func collectionView(_ collectionView: UICollectionView,
                        viewForSupplementaryElementOfKind kind: String,
                        at indexPath: IndexPath) -> UICollectionReusableView {
        collectionView.dequeueReusableSupplementaryView(
            ofKind: kind,
            withReuseIdentifier: SpinnerReusableView.reuseID,
            for: indexPath)
    }

    static let perfOverlayEnabled =
        ProcessInfo.processInfo.environment["KRAKI_CHAT_PERF_OVERLAY"] == "1"

    private func setupOverlay() {
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.numberOfLines = 0
        overlay.font = .monospacedSystemFont(ofSize: 11, weight: .medium)
        overlay.textColor = .white
        overlay.backgroundColor = UIColor.black.withAlphaComponent(0.62)
        overlay.layer.cornerRadius = 6
        overlay.layer.masksToBounds = true
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            overlay.widthAnchor.constraint(lessThanOrEqualToConstant: 230),
        ])
    }

    /// Replies/messages that landed below while the reader was away from the
    /// bottom; shown on the ↓ control and cleared on reaching the bottom.
    var unseenArrivals = 0
    var navigationLoadInFlight = false
    var navigationLoadTask: Task<Void, Never>?
    /// Keep existing content visually pinned after the height ABOVE the
    /// viewport changes by `delta` (older items prepended/trimmed, or the
    /// top spinner row toggled). We move `contentOffset` by the same amount
    /// so the anchor bubble stays put — but a bare offset write fights an
    /// in-flight scroll:
    ///   • While DRAGGING, the pan recognizer still holds the start offset
    ///     it captured at touch-down (non-linear in the top rubber-band), so
    ///     it snaps back. We bounce the recognizer (disable→enable) to
    ///     cancel the stale gesture and re-base it to the shifted content.
    ///   • While DECELERATING, momentum animates toward a fixed ABSOLUTE
    ///     target; re-basing the offset under it makes it lurch ~|delta|px to
    ///     that stale target. We halt the momentum in place so it re-bases.
    /// When fully at rest, the plain offset write is already jump-free.
    /// Last laid-out live card height (see sizeForItemAt).
    var lastLiveCardHeight: CGFloat?
    /// True while this controller writes contentOffset to keep content
    /// anchored; such writes must not be read as user scroll direction.
    var applyingProgrammaticShift = false
    /// Pre-measure heights OFF the scroll critical path. Warm the loaded
    /// window's turns during idle so on-screen scrolling never pays a
    /// synchronous self-size. Unlike the old preload-everything provider we
    /// only have the current seq-window in memory; the NEXT page's heights are
    /// measured by `pager` behind the spinner after `loadOlder`/`loadNewer`
    /// brings them in. Paused while the finger or momentum is moving.
    var warmEnqueued = Set<String>()
    var appliedHeightIDs = Set<String>()
    var lastWarmWidth: CGFloat = 0
    var initialVisibleGeometrySettled = false
    var isSettlingInitialVisibleGeometry = false
    var pendingHeightRefreshIDs = Set<String>()
    var heightRefreshScheduled = false
    func collectionView(_ collectionView: UICollectionView, willDisplay cell: UICollectionViewCell,
                        forItemAt indexPath: IndexPath) {
        // A reused cell must not carry another row's unfinished entrance.
        cell.layer.removeAnimation(forKey: "kraki.entrance")
        guard !pendingEntrances.isEmpty, indexPath.item < items.count else { return }
        runEntranceIfPending(cell, id: items[indexPath.item])
    }
    // MARK: Streaming render pacing

    var liveRenderScheduled = false
    var lastLiveRenderAt: CFTimeInterval = 0
    var lastLiveRenderCost: CFTimeInterval = 0
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        scrollIndicator.didScroll()
        // Finger drag AND its momentum are the user's scroll (momentum toward
        // older keeps loading history); our own anchor compensation is not.
        var userDriven = scrollView.isDragging || scrollView.isTracking || scrollView.isDecelerating
        #if DEBUG
        userDriven = userDriven || automationUserScrollActive
        #endif
        if userDriven, !applyingProgrammaticShift {
            noteUserScrollOffset(scrollView.contentOffset.y)
            widthAnchorGeneration += 1
            rememberReadingAnchor(force: true)
        } else {
            rememberReadingAnchor(force: false)
        }
        // UIKit owns fetch buffering, exact-height barriers, and anchored
        // batch application; the shared policy decides when to page.
        driveEdges()
    }
    // A page that arrived mid-fling was stashed in `pendingApply`; run it
    // the instant the natural slide settles, so the window grows without
    // ever interrupting the user's momentum.
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        scrollIndicator.endScrolling()
        KLog.chat("📜 [scroll] settle session=\(sessionId.prefix(12)) off=\(Int(scrollView.contentOffset.y)) distBottom=\(Int(distanceToBottom())) following=\(followingBottom) items=\(items.count)")
        scheduleCodeHighlightRefreshIfNeeded()
        flushPendingApply()
        // Motion fully stopped → resume idle height warming AND the page
        // measurer. The list is now static, so the (possibly expensive)
        // markdown self-size for a pending page runs here behind the spinner
        // — never on a scroll frame. The apply (barrier) fires once every
        // height is measured, so the page is fully rendered before it lands.
        warmWindow()
        pager.resume()
        setVisibleBodiesInteractive(true)
        scrollPolicy.endUserInteraction()
        settleEdges()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        scrollIndicator.endDragging(willDecelerate: decelerate)
        KLog.chat("📜 [scroll] drag-end session=\(sessionId.prefix(12)) decelerate=\(decelerate) off=\(Int(scrollView.contentOffset.y)) distBottom=\(Int(distanceToBottom())) following=\(followingBottom)")
        // Finger lifted with no momentum → settle immediately (no
        // didEndDecelerating will follow).
        if !decelerate {
            scheduleCodeHighlightRefreshIfNeeded()
            flushPendingApply()
            warmWindow()
            pager.resume()
            setVisibleBodiesInteractive(true)
            scrollPolicy.endUserInteraction()
            settleEdges()
            // `isDragging` can still read true inside this callback.
            DispatchQueue.main.async { [weak self] in self?.updateJumpButtonVisibility() }
        }
    }
    #if DEBUG
    /// Focus-free integration probe equivalent of the first real drag packet.
    /// It changes only the production follow-state latch; pagination, sizing,
    /// batch updates, and anchor correction still run through their normal paths.
    /// Unit tests: treat offset changes as a user drag (isDragging is not settable).
    var automationUserScrollActive = false
    #endif
    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        scrollIndicator.beginScrolling()
        KLog.chat("📜 [scroll] drag-begin session=\(sessionId.prefix(12)) off=\(Int(scrollView.contentOffset.y)) content=\(Int(scrollView.contentSize.height)) following=\(followingBottom)")
        scrollPolicy.beginUserInteraction(
            offset: scrollView.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
        codeHighlightSettleWork?.cancel()
        // NOTE: we deliberately do NOT flush a pending page here. The pending
        // work is the heavy STEP-2 snapshot refresh+apply; running it at the instant the
        // finger touches down would hitch the drag's first frames. It stays
        // stashed and applies when THIS new gesture settles (the spinner covers
        // the wait). Cheap mid-fling re-grabs are no longer a special case.
        // User touched the list → any in-flight scroll-to-top is cancelled,
        // so re-enable pagination (safety net if didScrollToTop never fires).
        scrollingToTop = false
        // `beginUserInteraction` also cancels any active navigation glide.
        // Re-sample after cancelling programmatic glide state. The shared
        // policy preserves a harmless tail grab until movement establishes
        // explicit older/newer intent.
        scrollPolicy.refreshFollowingTail(distanceToBottom: distanceToBottom())
        // Stand down warming AND page measurement for the duration of the
        // gesture/fling so no expensive self-size competes with scroll frames.
        // Discard stale visible-height jobs from the old viewport; the new visible
        // band is enqueued when motion settles. Page work is preserved because
        // its barrier owns a pending pagination apply.
        cancelPendingWarm()
        pager.pause()
        setVisibleBodiesInteractive(false)
    }

    // The ↓-to-latest programmatic glide finished — lift its paging gate and
    // settle both edges at rest.
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        endBottomGlide()
        updateJumpButtonVisibility()
    }

    // Status-bar tap → scroll-to-top. Suppress pagination for its duration so
    // it glides to the top of the loaded content instead of triggering an
    // endless prepend cascade as the animation chases contentOffset 0.
    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        scrollIndicator.beginScrolling()
        scrollPolicy.beginUserInteraction(
            offset: scrollView.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
        scrollPolicy.recordUserIntent(
            .older,
            offset: scrollView.contentOffset.y,
            distanceToBottom: distanceToBottom()
        )
        scrollingToTop = true
        return true
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        scrollIndicator.endScrolling()
        scrollingToTop = false
        scrollPolicy.endUserInteraction()
        updateJumpButtonVisibility()
        KLog.chat("📜 [scroll] to-top session=\(sessionId.prefix(12))")
        // The animation has parked at the top of the loaded content; reveal any
        // pending/buffered older page (jump-free, at rest) then top up.
        flushPendingApply()
        maybeFlushOlder(reason: "scrolledTop")
        prefetchOlderIfNeeded()
    }
    // MARK: Frame-time monitor

    var lastApplyMs: Double = 0
    var lastReason: String = "initial"
}

// MARK: - SwiftUI bridge

struct ChatPerfListView: UIViewControllerRepresentable {
    let sessionId: String
    let agent: String
    let bottomContentInset: CGFloat
    var composerOverlayInset: CGFloat = 0
    let onResolvePermission: (String, String?, String) -> Void
    let onAnswerQuestion: (String, String) -> Void
    let onOpenImage: (IOSImagePreviewSelection) -> Void
    let onOpenHTMLArtifact: (ContentRef) -> Void
    @Environment(AppState.self) private var appState

    func makeUIViewController(context: Context) -> ChatPerfListVC {
        ChatPerfListVC(
            sessionId: sessionId,
            appState: appState,
            agent: agent,
            bottomContentInset: bottomContentInset,
            onResolvePermission: onResolvePermission,
            onAnswerQuestion: onAnswerQuestion,
            onOpenImage: onOpenImage,
            onOpenHTMLArtifact: onOpenHTMLArtifact
        )
    }

    func updateUIViewController(_ vc: ChatPerfListVC, context: Context) {
        vc.updateBottomContentInset(bottomContentInset)
        vc.updateComposerOverlayInset(composerOverlayInset)
        vc.onResolvePermission = onResolvePermission
        vc.onAnswerQuestion = onAnswerQuestion
        vc.onOpenImage = onOpenImage
        vc.onOpenHTMLArtifact = onOpenHTMLArtifact
        vc.syncLiveUpdates()
    }
}

/// FlowLayout whose batch updates land on an explicitly requested offset.
final class ChatFlowLayout: UICollectionViewFlowLayout {
    var pendingUpdateOffsetY: CGFloat?

    override func targetContentOffset(forProposedContentOffset proposedContentOffset: CGPoint) -> CGPoint {
        if let y = pendingUpdateOffsetY {
            return CGPoint(x: proposedContentOffset.x, y: y)
        }
        return super.targetContentOffset(forProposedContentOffset: proposedContentOffset)
    }
}

/// Lets the "end selection" tap observe touches without blocking anything.
private final class SimultaneousTapDelegate: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
#endif
