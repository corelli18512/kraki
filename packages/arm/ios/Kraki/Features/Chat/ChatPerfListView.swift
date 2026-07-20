#if os(iOS)
import SwiftUI
import UIKit
import os

// =====================================================================
// Production flat-spine scroll/windowing engine.
//
// Purpose: prove that a NORMAL-ORDER (正序, newest-at-bottom) chat list
// can scroll smoothly AND paginate jump-free, with ZERO dependence on
// the real ChatView list stack. Everything
// here is self-contained:
//
//   • MockMessageProvider — a pure in-memory sliding window over a
//     fixed backing array. No network, no Store, no Provider.
//   • ChatPerfListVC    — a clean-room UICollectionView (flow layout
//     with an explicit cached-height sizer, a MANUAL data source driven
//     by performBatchUpdates, and inline header/footer spinners).
//   • Frame-time monitor  — a CADisplayLink that flags dropped frames so
//     jank is visible on-screen, not just "feels laggy".
//
// Phase-2 scope: each seq maps to a REAL message cell. The cheap UILabel
// bubbles are replaced by the production TextKit bubble (markdown / code /
// the same SwiftUI hosting the real chat uses) so the harness exercises
// the ACTUAL expensive self-size (`systemLayoutSizeFitting`, 15–60 ms per
// rich cell) instead of a trivial label. Heights come from the same
// offscreen self-size path the real app uses, pre-warmed off the critical
// frame by the production `HeightMeasurementScheduler`. Goal: measure how
// much scroll jank real markdown adds on a 正序 (newest-at-bottom) list, and
// validate that measure-ahead keeps the scroll frames clean.
//
// Reached from: Settings → Diagnostics → "Scroll Perf Test".
// =====================================================================

/// Perf logger. Mirrors every line to BOTH the unified-logging store (for
/// `log stream` on the simulator) AND `print` (stdout) — the latter so
/// `devicectl device process launch --console` streams the lines live over
/// the CoreDevice tunnel on a physical device. (idevicesyslog can't see
/// `os.Logger`/`NSLog` output on modern iOS, and `log collect` needs root.)
/// Debug harness only.
private final class ChatPerfLog {
    private let logger = Logger(subsystem: "chat.kraki.ios", category: "chatperf")
    private let enabled = ProcessInfo.processInfo.environment["KRAKI_CHAT_PERF_OVERLAY"] == "1"
        || ProcessInfo.processInfo.environment["KRAKI_CHAT_PERF_LOG"] == "1"
    private let queue = DispatchQueue(label: "chatperf.filelog")
    private let handle: FileHandle?
    /// Sandbox path (pull with `devicectl device copy from`):
    /// Documents/chatperf.log — a durable sink that survives USB/syslog drops.
    static let fileURL: URL = {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("chatperf.log")
    }()

    init() {
        guard enabled else {
            handle = nil
            return
        }
        // Fresh file each diagnostic launch so a pull only sees this session.
        let url = Self.fileURL
        try? FileManager.default.removeItem(at: url)
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
    }

    func log(_ message: String) {
        guard enabled else { return }
        logger.log("\(message, privacy: .public)")
        let t = CFAbsoluteTimeGetCurrent().truncatingRemainder(dividingBy: 100)
        let line = "[chatperf] \(String(format: "%07.3f", t)) \(message)\n"
        print(line, terminator: "")
        queue.async { [handle] in
            if let data = line.data(using: .utf8) { handle?.write(data) }
        }
    }
}
private let chatPerfLog = ChatPerfLog()

// MARK: - Cells

/// Production chat uses one TextKit-backed cell path. Keeping a single
/// renderer prevents sizing and interaction drift.

// MARK: - Inline loading spinner (section header/footer)

/// A supplementary view holding a centered spinner. Used as the section
/// header (top / loadOlder) and footer (bottom / loadNewer) so the
/// loading indicator lives INSIDE the scroll content — level with the
/// bubbles and scrolling with them — instead of floating over the view.
private final class SpinnerReusableView: UICollectionReusableView {
    static let reuseID = "SpinnerReusableView"
    private let spinner = UIActivityIndicatorView(style: .medium)

    override init(frame: CGRect) {
        super.init(frame: frame)
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = false
        addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        spinner.startAnimating()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        spinner.startAnimating()
    }
}

// MARK: - Height cache (REAL self-size, measure once, reuse forever)

/// Computes a message's rendered height EXACTLY as the live cell self-sizes
/// it — by configuring a reusable offscreen `UICollectionViewListCell` with
/// the SAME `ChatPerfCellContent` hosting config and asking it to
/// `systemLayoutSizeFitting`. This is the production measurement path (see
/// the production TextKit sizer), so the cached height is identical
/// to what UIKit would self-size — no drift, no jump.
///
/// It is also the EXPENSIVE path (15–60 ms for a rich markdown cell), which
/// is the whole point of phase 2: we pay the real cost, then hide it behind
/// measure-ahead (the scheduler pre-warms the cache off the critical frame).
/// Because the flow layout uses `estimatedItemSize = .zero`, the height we
/// return is the cell's DEFINITIVE height — the layout and the anchor offset
/// correction both read this one source of truth.
///
/// `container` must be installed in the view hierarchy by the VC so traits
/// (Dynamic Type, interface style) resolve identically to the live list.
private final class RealCellSizer {
    private var cache: [String: CGFloat] = [:]
    private var measuredWidth: CGFloat = 0

    /// Real session id / agent so the offscreen measure renders the SAME
    /// TextKit config the live cell uses. Set by the VC right after init.
    var sessionId: String = "perf"
    var agent: String = "claude"

    /// Container whose safe-area insets are forced to zero — a real list
    /// cell self-sizes with none, but an offscreen view pinned into the VC
    /// inherits the screen insets, biasing every measurement. Mirrors the
    /// production safe-area-neutral sizer.
    private final class SafeAreaZeroingView: UIView {
        override var safeAreaInsets: UIEdgeInsets { .zero }
    }

    let container: UIView = {
        let v = SafeAreaZeroingView()
        v.alpha = 0
        v.isUserInteractionEnabled = false
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    /// The single cell reused for every measurement — a plain list cell, so
    /// it always runs the REAL self-size (never a cache short-circuit).
    /// Reused UILabel for the pure-UIKit A/B arm. Measuring with the SAME
    /// label config the live `ChatPerfUIKitCell` renders guarantees the cached
    /// height matches what's drawn — otherwise frontDelta (the anchor
    /// correction) is computed from SwiftUI-measured heights while UIKit lays
    /// out different ones, and every page insert visibly jumps.
    private let measureLabel: UILabel = {
        let l = UILabel()
        l.numberOfLines = 0
        l.font = .preferredFont(forTextStyle: .subheadline)
        return l
    }()

    init() {}

    /// Drop the cache when the measure width changes (rotation / split).
    private func resetIfWidthChanged(_ width: CGFloat) {
        if width != measuredWidth {
            cache.removeAll(keepingCapacity: true)
            measuredWidth = width
        }
    }

    func cached(_ id: String) -> CGFloat? { cache[id] }

    /// Cache-or-measure. A miss measures SYNCHRONOUSLY on the calling
    /// thread — when that caller is `sizeForItemAt` during a scroll, the
    /// cost lands on the scroll frame, so we log it as the key jank signal.
    func height(for t: ChatMessage, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 44 }
        resetIfWidthChanged(width)
        if let h = cache[t.id] { return h }
        let t0 = CFAbsoluteTimeGetCurrent()
        let h = measure(t, width: width)
        cache[t.id] = h
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        chatPerfLog.log("[size] sync-miss id=\(t.id) ms=\(String(format: "%.1f", ms))")
        return h
    }

    /// Warm path: measure + cache off the critical frame (called by the
    /// scheduler). Cheap no-op if already cached. No sync-miss log — this is
    /// the intended, budget-sliced measurement.
    func prime(_ t: ChatMessage, width: CGFloat) {
        guard width > 0 else { return }
        resetIfWidthChanged(width)
        if cache[t.id] != nil { return }
        let t0 = CFAbsoluteTimeGetCurrent()
        cache[t.id] = measure(t, width: width)
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        if ms > 8 {
            chatPerfLog.log("[prime] slow id=\(t.id) ms=\(String(format: "%.1f", ms))")
        }
    }

    /// The real self-size: configure the offscreen cell exactly like the
    /// live one and ask UIKit for its fitting height.
    private func measure(_ t: ChatMessage, width: CGFloat) -> CGFloat {
        TKBubbleContent.make(message: t, sessionId: sessionId, agent: agent)
            .cellHeight(cellWidth: width)
    }
}

// MARK: - Pagination transaction (txn) — log-based correctness/timing trace

/// One pagination cycle threaded across its async/deferred phases (trigger →
/// rawLoad → snapshot refresh → reconcile → measure → apply) so the log reads as a
/// single `[txn N]` transaction. `lap()` returns ms since the previous lap;
/// `mark()` resets the lap clock (used to drop idle wait between phases).
private final class PaginateTxn {
    let id: Int
    let kind: String
    private let t0: CFAbsoluteTime
    private var last: CFAbsoluteTime
    init(id: Int, kind: String) {
        self.id = id
        self.kind = kind
        let now = CFAbsoluteTimeGetCurrent()
        self.t0 = now
        self.last = now
    }
    func mark() { last = CFAbsoluteTimeGetCurrent() }
    func lap() -> Double {
        let now = CFAbsoluteTimeGetCurrent()
        let d = (now - last) * 1000
        last = now
        return d
    }
    func total() -> Double { (CFAbsoluteTimeGetCurrent() - t0) * 1000 }
}

// MARK: - View controller (clean-room collection view)

final class ChatPerfListVC: UIViewController, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {

    private let sizer = RealCellSizer()

    /// Pre-warms the height cache off the critical frame, ≤budget ms per
    /// frame, so a scroll into fresh markdown cells hits the cache instead
    /// of paying the self-size on the scroll frame. The real app's exact
    /// scheduler — reused verbatim. PAUSED during active gestures/momentum
    /// (it's only opportunistic look-ahead, must never fight a scroll frame).
    private let warmer = HeightMeasurementScheduler(budgetMs: 4.0)

    /// Dedicated scheduler for the ONE page a pending paginate is about to
    /// prepend/append. Unlike `warmer` it is NEVER paused: a loadOlder's
    /// anchor correction NEEDS those heights, and we'd rather budget-slice
    /// the measurement across a few frames behind the spinner than pay it as
    /// one synchronous ~60ms freeze on the apply frame. Runs only during the
    /// brief load window, so the reduced scroll headroom is barely felt.
    private let pager = HeightMeasurementScheduler(budgetMs: 4.0)

    /// Injected identity. The real session id + agent so cells render the
    /// production TextKit bubble with correct tint, and so the view model can
    /// preload this session's history from GRDB.
    private let sessionId: String
    private let agentName: String
    private var bottomContentInset: CGFloat
    /// Explicit tail-follow state. Geometry cannot reliably infer this from a
    /// 2pt distance sample while SwiftUI, the keyboard and safe-area insets are
    /// changing in separate layout passes. We follow from initial open until
    /// the user actually drags away; composer/keyboard/viewport changes then
    /// repin the exact UIScrollView bottom on every settled layout.
    private var followingBottom = true
    private var lastPinnedViewportSize: CGSize = .zero
    private var lastPinnedAdjustedInsets: UIEdgeInsets = .zero
    private var isPinningBottom = false
    private static let bottomFollowTolerance: CGFloat = 24
    private static let liveCardID = "__live_card__"
    var onResolvePermission: (String, String?, String) -> Void = { _, _, _ in }
    var onAnswerQuestion: (String, String) -> Void = { _, _ in }

    /// Flat pure-spine data source. `vm.displayMessages` contains one item per renderable persisted message; paging moves the raw seq window,
    /// then `refreshSpineSnapshot()` snapshots it off the scroll frame.
    private let vm: ChatViewModel
    private let appState: AppState
    private var collectionView: UICollectionView!

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
    private var messages: [ChatMessage] = []
    private var byId: [String: ChatMessage] = [:]

    init(sessionId: String, appState: AppState, agent: String, bottomContentInset: CGFloat,
         onResolvePermission: @escaping (String, String?, String) -> Void = { _, _, _ in },
         onAnswerQuestion: @escaping (String, String) -> Void = { _, _ in }) {
        self.sessionId = sessionId
        self.agentName = agent
        self.bottomContentInset = bottomContentInset
        self.onResolvePermission = onResolvePermission
        self.onAnswerQuestion = onAnswerQuestion
        self.vm = ChatViewModel(sessionId: sessionId, appState: appState)
        self.appState = appState
        self.store = appState.messageStore
        super.init(nibName: nil, bundle: nil)
        sizer.sessionId = sessionId
        sizer.agent = agent
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
    private var ids: [String] {
        var result = messages.map(\.id)
        if vm.card?.text.isEmpty == false || vm.card?.action != nil { result.append(Self.liveCardID) }
        return result
    }
    private var messageCount: Int { messages.count }
    /// Edge indicators describe pagination of an already materialized window.
    /// They must stay off during the empty initial bootstrap; otherwise the
    /// unknown window is rendered as two permanent loading states.
    private var hasLoadedWindow: Bool { !items.isEmpty && vm.windowTopSeq > 0 }
    private var hasAuthoritativeHead: Bool { vm.sessionLastSeq > 0 }
    private func message(_ id: String) -> ChatMessage? { byId[id] }
    private var atOldest: Bool { vm.atHistoryStart }
    private var atNewest: Bool { vm.atHead }

    /// Refresh the flat message snapshot at rest, never on a scroll frame.
    private func refreshSpineSnapshot() {
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
        lastSyncedSignature = "\(vm.filteredMessages.count)|\(vm.windowTopSeq)|\(vm.windowBottomSeq)|\(vm.sessionLastSeq)|\(lastLiveCardSignature)"
    }

    // MARK: - Correctness checks (log-based debug)

    private var nextTxnId = 0
    private func newTxn(_ kind: String) -> PaginateTxn {
        nextTxnId += 1
        return PaginateTxn(id: nextTxnId, kind: kind)
    }

    private func f1(_ d: Double) -> String { String(format: "%.1f", d) }
    private func yn(_ b: Bool) -> String { b ? "Y" : "N" }

    /// First index where two id slices differ (for the reconcile-invalid dump).
    private func firstMismatch(_ a: [String], _ b: [String]) -> (idx: Int, a: String, b: String) {
        let n = min(a.count, b.count)
        for i in 0..<n where a[i] != b[i] { return (i, a[i], b[i]) }
        return (n, a.count > n ? a[n] : "—", b.count > n ? b[n] : "—")
    }


    /// Manual model array (window seqs). Replaces the diffable data
    /// source: a sliding window shifts every retained item's index, which
    /// diffable interprets as ~70 "moves" per page (~20ms apply). Manual
    /// front/back insert+delete lets UIKit shift the middle implicitly —
    /// no move enumeration — which is what makes fast paging silky.
    private var items: [String] = []

    /// Signature of the last refresh the spine snapshot (window count + bottom seq + streaming).
    /// `updateUIViewController` compares it to detect new live messages.
    private var lastSyncedSignature = ""
    private var lastLiveCardSignature = ""
    private var lastEntryDiagnosticSignature = ""

    private func logEntryState(_ reason: String) {
        let collectionCount = collectionView?.numberOfItems(inSection: 0) ?? -1
        let signature = [
            "session=\(sessionId)",
            "attached=\(viewIfLoaded?.window == nil ? 0 : 1)",
            "hidden=\(viewIfLoaded?.isHidden == true ? 1 : 0)",
            "alpha=\(String(format: "%.1f", viewIfLoaded?.alpha ?? -1))",
            "gate=\(vm.isWaitingForLatestBubble ? 1 : 0)",
            "metaHead=\(vm.session?.lastSeq ?? 0)",
            "providerHead=\(vm.sessionLastSeq)",
            "window=\(vm.windowTopSeq)-\(vm.windowBottomSeq)",
            "raw=\(vm.filteredMessages.count)",
            "projected=\(messages.count)",
            "items=\(items.count)",
            "collection=\(collectionCount)",
            "atHead=\(vm.atHead ? 1 : 0)",
            "card=\(vm.card == nil ? 0 : 1)",
        ].joined(separator: " ")
        guard signature != lastEntryDiagnosticSignature else { return }
        lastEntryDiagnosticSignature = signature
        KLog.chatEntry("list reason=\(reason) \(signature)")
    }

    private var liveCardSignature: String {
        // Hash the streaming text instead of inlining it: syncLive fires on
        // every frame while idle (≈10–20 Hz), so embedding the full draft text
        // into the signature string wasted memory + made logs unreadable. A
        // stable hash captures "did the text change" at a fraction of the cost.
        let text = vm.card?.text ?? ""
        var hasher = Hasher()
        hasher.combine(text)
        hasher.combine(vm.card?.action?.id ?? "")
        hasher.combine(vm.card?.action?.type ?? "")
        hasher.combine(vm.card?.action?.payload["decision"]?.stringValue ?? "")
        hasher.combine(vm.card?.action?.answer ?? "")
        return String(hasher.finalize(), radix: 16)
    }

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
    private var loadingOlder = false
    private var loadingNewer = false
    /// A fetch round-trip is in flight (serializes fetches per edge, one at a
    /// time). Separate from the now-persistent edge spinners.
    private var fetchingOlder = false
    private var fetchingNewer = false
    private var didInitialScroll = false

    /// Bumped on every re-anchor (jump-to-latest) so a fetch that was already
    /// in flight when the window was reset can detect it is stale and bail
    /// instead of applying against the fresh window. (The provider's DB read
    /// already re-validates `topSeq`, so it won't mutate the store across a
    /// reset; this token guards the grouping/flush that follows.)
    private var pagingGeneration = 0

    /// While the ↓-to-latest glide is animating, edge paging is suppressed:
    /// right after the re-anchor's `reloadData` the offset sits at the tail
    /// window's TOP (y≈0), and an older-fetch fired there would slide the
    /// window back up before the animation reaches the bottom. Cleared on
    /// animation-end / user touch / a safety timeout.
    private var suppressPagingForBottom = false

    /// Floating "jump to latest" button, shown only when the user has scrolled
    /// away from the live bottom. Tapping re-anchors at the chat's true newest
    /// end and glides down. A UIKit sibling of the collection view (the SwiftUI
    /// `ChatPerfListView` wrapper mounts the VC bare), tinted by the agent hue.
    private let jumpButton = UIButton(type: .system)
    private var jumpButtonBlur: UIVisualEffectView?
    private var jumpButtonBottomConstraint: NSLayoutConstraint?

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
    private var scrollingToTop = false

    /// A page that "arrived" while the list was coasting on natural
    /// momentum. We must NOT re-base contentOffset under an in-flight
    /// deceleration (its absolute target would snap the content), so we
    /// stash the apply here and run it the moment the slide settles
    /// (didEndDecelerating) — keeping the fling perfectly natural.
    private var pendingApply: (() -> Void)?

    // Frame-time monitor.
    private var displayLink: CADisplayLink?
    private var lastFrameTs: CFTimeInterval = 0
    private var hitchCount = 0
    private var worstFrameMs: Double = 0

    private let overlay = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        chatPerfLog.log("[cfg] renderer=textkit localSeamless=\(localSeamless)")
        chatPerfLog.log("[diag] viewDidLoad turns=\(messages.count) ids=\(items.count) winTop=\(vm.windowTopSeq) winBot=\(vm.windowBottomSeq) sessionLast=\(vm.sessionLastSeq) filtered=\(vm.filteredMessages.count)")
        setupCollectionView()
        setupJumpButton()
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

    deinit { displayLink?.invalidate() }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        logEntryState("viewDidAppear")
    }

    override func viewDidDisappear(_ animated: Bool) {
        logEntryState("viewDidDisappear")
        super.viewDidDisappear(animated)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        logEntryState("layout")
        guard collectionView != nil, didInitialScroll, followingBottom, !isPinningBottom else { return }
        let viewportChanged = collectionView.bounds.size != lastPinnedViewportSize
        let insetsChanged = collectionView.adjustedContentInset != lastPinnedAdjustedInsets
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
        let layout = UICollectionViewFlowLayout()
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
        collectionView.contentInset.bottom = bottomContentInset
        collectionView.verticalScrollIndicatorInsets.bottom = bottomContentInset
        view.addSubview(collectionView)

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

    private let spinnerRowHeight: CGFloat = 44
    /// Headroom (pt from the top edge) that defines the "near top" reveal line
    /// for older pagination. Mirrors the test page's `pageTriggerHeadroom`.
    private let pageTriggerHeadroom: CGFloat = 320

    // MARK: Data source (manual)

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        items.count
    }

    private var hasLiveCardItem: Bool { items.last == Self.liveCardID }
    private func isLiveCard(_ index: Int) -> Bool { index < items.count && items[index] == Self.liveCardID }

    /// A frozen terminal card (`turn_status` / `interrupted_turn`) reuses the
    /// SAME SwiftUI `LiveAgentBubbleView` as the streaming card — frozen
    /// read-only with the action slot set to the terminal outcome
    /// (`user_abort` | `failed`). Mirrors web `MessageBubble` (#162/#164/#168):
    /// no separate terminal-card chrome, just the live card stopped.
    private func frozenCardMessage(_ index: Int) -> ChatMessage? {
        guard index < items.count, let message = message(items[index]),
              message.type == "turn_status" || message.type == "interrupted_turn" else { return nil }
        return message
    }

    /// Rebuild a `SessionCard` from a persisted terminal message: the streaming
    /// draft + the terminal action slot. Matches web's turn_status/interrupted_turn
    /// normalization (legacy interrupted_turn rebuilds user_abort/failed).
    private func frozenCard(from message: ChatMessage) -> MessageStore.SessionCard {
        let text = message.interruptedDraft ?? ""
        let action: ChatMessage?
        if message.type == "turn_status" {
            if let terminal = message.terminalAction, let type = terminal["type"]?.stringValue {
                action = ChatMessage(type: type, seq: 0, sessionId: message.sessionId,
                                     deviceId: message.deviceId, timestamp: message.timestamp,
                                     payload: terminal["payload"]?.dictValue ?? [:])
            } else { action = nil }
        } else {
            // Legacy interrupted_turn: rebuild the action from the reason.
            let reason = message.payload["reason"]?.stringValue ?? "user_aborted"
            let isProcessLost = reason == "process_lost"
            action = ChatMessage(
                type: isProcessLost ? "failed" : "user_abort", seq: 0,
                sessionId: message.sessionId, deviceId: message.deviceId,
                timestamp: message.timestamp,
                payload: isProcessLost
                    ? ["message": AnyCodable("Agent process was lost")]
                    : [:])
        }
        return MessageStore.SessionCard(text: text, action: action)
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
        cell.sessionMode = vm.session?.mode ?? .discuss
        cell.attachmentStore = appState.attachmentStore
        cell.onResolvePermission = onResolvePermission
        cell.onAnswerQuestion = onAnswerQuestion
        cell.onShowTable = { [weak self] layout in
            let table = TKTableSheetViewController(layout: layout)
            let navigation = UINavigationController(rootViewController: table)
            navigation.modalPresentationStyle = .pageSheet
            self?.present(navigation, animated: true)
        }
        cell.onActionHeightChange = { [weak self, weak cell] in
            // SwiftUI action/image UI resized (e.g. permission buttons
            // appeared, or a lazy image hydrated). Bust the cached height
            // for this item and relayout.
            if let cell, let content = cell.contentSnapshot {
                TKBubbleContent.bust(content.message.id)
            }
            self?.collectionView.collectionViewLayout.invalidateLayout()
        }
        if isLiveCard(indexPath.item), let card = vm.card {
            // Streaming tail: ONE component — same TKBubbleCell as a completed
            // bubble, with the card's draft as the body and card.action as the
            // action slot. No separate live-card component.
            let steps = vm.lastUserStepsHint
            let content = TKBubbleContent.live(card: card, agent: agentName,
                                                sessionId: sessionId, steps: steps)
            cell.configure(content, cellWidth: collectionView.bounds.width)
            cell.onOpenSteps = { [weak self] _ in self?.presentLiveSteps() }
        } else if let message = frozenCardMessage(indexPath.item) {
            // Frozen terminal card (turn_status / interrupted_turn): the SAME
            // bubble as streaming, frozen with a real timestamp + terminal action.
            let card = frozenCard(from: message)
            let content = TKBubbleContent.live(card: card, agent: agentName,
                                                sessionId: sessionId,
                                                steps: message.steps ?? 0,
                                                isFrozen: true,
                                                frozenTimestamp: message.finishedAt ?? message.timestamp)
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
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        if ms > 3 { chatPerfLog.log("[cell] slow configure item=\(indexPath.item) ms=\(String(format: "%.1f", ms))") }
        return cell
    }

    func collectionView(_ collectionView: UICollectionView,
                        layout collectionViewLayout: UICollectionViewLayout,
                        sizeForItemAt indexPath: IndexPath) -> CGSize {
        let w = collectionView.bounds.width
        if isLiveCard(indexPath.item), let card = vm.card {
            let content = TKBubbleContent.live(card: card, agent: agentName,
                                                sessionId: sessionId, steps: vm.lastUserStepsHint)
            return CGSize(width: w, height: content.cellHeight(cellWidth: w))
        }
        if let message = frozenCardMessage(indexPath.item) {
            let content = TKBubbleContent.live(card: frozenCard(from: message), agent: agentName,
                                                sessionId: sessionId, steps: message.steps ?? 0,
                                                isFrozen: true,
                                                frozenTimestamp: message.finishedAt ?? message.timestamp)
            return CGSize(width: w, height: content.cellHeight(cellWidth: w))
        }
        guard indexPath.item < items.count, let message = message(items[indexPath.item]) else {
            return CGSize(width: w, height: 44)
        }
        return CGSize(width: w, height: sizer.height(for: message, width: w))
    }

    private func presentLiveSteps() {
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

    private static let perfOverlayEnabled =
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

    // MARK: - Jump-to-latest button

    /// Agent-hue tint for the jump button, matching `ChatView.agentTintColor`
    /// (per-session hue, brighter in dark mode). Dynamic so it follows the
    /// interface style.
    private func agentTint() -> UIColor {
        let sid = sessionId
        return UIColor { tc in
            let dark = tc.userInterfaceStyle == .dark
            let hue = stringToHue(sid) / 360
            let (h, s, b) = hslToHSB(h: hue, s: dark ? 0.75 : 0.70, l: dark ? 0.65 : 0.45)
            return UIColor(hue: CGFloat(h), saturation: CGFloat(s), brightness: CGFloat(b), alpha: 1)
        }
    }

    private func setupJumpButton() {
        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.isUserInteractionEnabled = false
        blur.layer.cornerRadius = 15
        blur.layer.masksToBounds = true
        blur.layer.borderWidth = 0.5
        blur.layer.borderColor = agentTint().withAlphaComponent(0.25).cgColor

        jumpButton.translatesAutoresizingMaskIntoConstraints = false
        jumpButton.setImage(UIImage(systemName: "chevron.down",
                                    withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)),
                            for: .normal)
        jumpButton.tintColor = agentTint()
        jumpButton.addTarget(self, action: #selector(onBottomTapped), for: .touchUpInside)
        jumpButton.alpha = 0                 // hidden until scrolled up
        jumpButton.isHidden = true

        view.addSubview(jumpButton)
        jumpButton.addSubview(blur)
        jumpButton.sendSubviewToBack(blur)
        jumpButtonBlur = blur

        let bottom = jumpButton.bottomAnchor.constraint(
            equalTo: view.safeAreaLayoutGuide.bottomAnchor,
            constant: -(bottomContentInset + 16)
        )
        jumpButtonBottomConstraint = bottom
        NSLayoutConstraint.activate([
            jumpButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            bottom,
            jumpButton.widthAnchor.constraint(equalToConstant: 52),
            jumpButton.heightAnchor.constraint(equalToConstant: 30),
            blur.leadingAnchor.constraint(equalTo: jumpButton.leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: jumpButton.trailingAnchor),
            blur.topAnchor.constraint(equalTo: jumpButton.topAnchor),
            blur.bottomAnchor.constraint(equalTo: jumpButton.bottomAnchor),
        ])
    }

    /// Show the jump button only when the user has scrolled away from the live
    /// bottom (or newer history remains unloaded below). Animated fade so it
    /// doesn't pop during the glide.
    private func updateJumpButtonVisibility() {
        guard collectionView != nil else { return }
        let farFromBottom = distanceToBottom() > 1.5 * collectionView.bounds.height
        let shouldShow = !suppressPagingForBottom && (farFromBottom || !atNewest)
        let isShown = !jumpButton.isHidden && jumpButton.alpha > 0.5
        guard shouldShow != isShown else { return }
        if shouldShow { jumpButton.isHidden = false }
        UIView.animate(withDuration: 0.2) {
            self.jumpButton.alpha = shouldShow ? 1 : 0
        } completion: { _ in
            if !shouldShow { self.jumpButton.isHidden = true }
        }
    }

    @objc private func onBottomTapped() {
        jumpToLiveBottom(animated: true)
    }

    /// Re-anchor at the chat's true newest end, then pin the viewport to the
    /// bottom. Without the window reset, ↓Bottom would only reach the bottom of
    /// whatever window paging happens to have loaded — not the whole chat's
    /// newest message. Mirrors the sim-validated test-page `reanchorNewest`.
    ///
    /// PREFER sliding the already-loaded tail UP to the head (`pageNewerRaw`
    /// extends the bottom while the px-cap trims the top): this keeps the warm,
    /// already-measured ~14-screen window, so the jump glides over real content
    /// with no cold-cell refill. `jumpToHead` (nuke + reload the last 200 msgs)
    /// collapses the window to a 1-2 turn stub, and the paging engine then
    /// storms ~13 screens of cold older-refill (~20 × 30ms hitches) — so it's
    /// used only when there's no window yet or the gap is too big to bridge.
    private static let reanchorSlideMaxGap = 2000     // seqs; bigger ⇒ jumpToHead
    private static let reanchorSlideMaxPages = 12      // safety cap on the slide loop
    private func reanchorNewest() {
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
        pendingApply = nil
        fetchingOlder = false
        fetchingNewer = false
        loadingOlder = hasLoadedWindow && !atOldest
        loadingNewer = hasLoadedWindow && hasAuthoritativeHead && !atNewest
        collectionView.reloadData()
        collectionView.layoutIfNeeded()
        warmWindow()
        lastReason = "reanchor"
        updateOverlay()
        chatPerfLog.log("[reanchor] win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] n=\(items.count) atNewest=\(atNewest)")
    }

    private func jumpToLiveBottom(animated: Bool) {
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
            suppressPagingForBottom = true
            updateJumpButtonVisibility()
            scrollToBottom(animated: true)
            // Guarantee the gate lifts even if no didEndScrollingAnimation fires
            // (e.g. the target was already visible so UIKit skipped the anim).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                self?.endBottomGlide()
            }
        } else {
            scrollToBottom(animated: false)
            updateJumpButtonVisibility()
        }
    }

    /// Lift the ↓Bottom paging gate and resume normal edge paging at rest.
    private func endBottomGlide() {
        guard suppressPagingForBottom else { return }
        suppressPagingForBottom = false
        chatPerfLog.log("[bottom] glide-end win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] off=\(Int(collectionView.contentOffset.y))")
        settleEdges()
        updateOverlay()
        updateJumpButtonVisibility()
    }

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
    private func applyFrontShift(_ delta: CGFloat) {
        guard delta != 0 else { return }
        let dragging = collectionView.isDragging || collectionView.isTracking
        collectionView.contentOffset.y += delta
        if dragging {
            // Finger is down: next touch-move would recompute the offset as
            // (touchDownOffset − translation) and erase our write. Push the
            // translation baseline by the same delta so the recompute keeps
            // our shift — the gesture is never cut, the drag stays live.
            // (offset = touchDownOffset − translation ⇒ to raise offset by
            // delta we lower translation by delta.)
            let pan = collectionView.panGestureRecognizer
            var t = pan.translation(in: collectionView)
            t.y -= delta
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
    private func applyWhenStable(_ work: @escaping () -> Void) {
        if collectionView.isDragging || collectionView.isDecelerating || scrollingToTop {
            pendingApply = work
        } else {
            work()
        }
    }

    private func flushPendingApply() {
        guard let work = pendingApply else { return }
        pendingApply = nil
        work()
    }

    // MARK: Window apply (manual batch updates)

    /// First load: fill the model and jump to the newest end (bottom).
    private func applyInitial() {
        let t0 = CFAbsoluteTimeGetCurrent()
        items = ids
        chatPerfLog.log("[diag] applyInitial items=\(items.count) turns=\(messages.count) cvFrame=\(Int(view.bounds.width))x\(Int(view.bounds.height)) cvCount=\(collectionView.numberOfItems(inSection: 0))")
        // Persistent edge spinners: show "loading earlier messages" as long as
        // older history remains undisplayed (header above the oldest loaded
        // row), and "loading newer messages" while newer history remains below
        // (footer below the newest loaded row). Both auto-managed in applyEdges
        // thereafter. Set BEFORE the first layout so they're part of the initial
        // content - we anchor at the bottom, so the off-screen top header needs
        // no front-shift, and the footer is usually hidden on open (at head).
        loadingOlder = hasLoadedWindow && !atOldest
        loadingNewer = hasLoadedWindow && hasAuthoritativeHead && !atNewest
        collectionView.reloadData()
        collectionView.layoutIfNeeded()
        didInitialScroll = true
        followingBottom = true
        pinToBottom(reason: "initial")
        lastReason = "initial"
        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        KLog.chat("📥 [chat-entry] applyInitial session=\(sessionId.prefix(12)) items=\(items.count) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) atNewest=\(atNewest) ms=\(String(format: "%.1f", ms))")
        logEntryState("applyInitial")
        updateOverlay()
        warmWindow()
        updateJumpButtonVisibility()
    }

    /// Pre-measure heights OFF the scroll critical path. Warm the loaded
    /// window's turns during idle so on-screen scrolling never pays a
    /// synchronous self-size. Unlike the old preload-everything provider we
    /// only have the current seq-window in memory; the NEXT page's heights are
    /// measured by `pager` behind the spinner after `loadOlder`/`loadNewer`
    /// brings them in. Paused while the finger or momentum is moving.
    private var warmEnqueued = Set<String>()
    private var lastWarmWidth: CGFloat = 0

    private func warmWindow() {
        let width = collectionView.bounds.width
        guard width > 0 else { return }
        // Width changed (rotation / split): the sizer dropped its cache, so the
        // "already enqueued" set is stale — clear it and re-warm from scratch.
        if width != lastWarmWidth {
            lastWarmWidth = width
            warmEnqueued.removeAll(keepingCapacity: true)
        }
        var jobs: [() -> Void] = []
        func enqueueIfCold(_ t: ChatMessage) {
            guard sizer.cached(t.id) == nil, !warmEnqueued.contains(t.id) else { return }
            warmEnqueued.insert(t.id)
            jobs.append { [weak self] in self?.sizer.prime(t, width: width) }
        }
        // The loaded window — what the user sees and scrolls through now.
        for message in messages { enqueueIfCold(message) }
        guard !jobs.isEmpty else { return }
        chatPerfLog.log("[warm] enqueue n=\(jobs.count)")
        warmer.enqueue(jobs)
    }

    /// Apply a window slide as explicit edge edits, optionally collapsing
    /// the loading spinner row in the SAME pass. The change in content
    /// height ABOVE the viewport (`frontDelta`) is handed to the layout, so
    /// UIKit shifts the viewport itself during the update cycle — keeping
    /// existing bubbles visually pinned without a hand-written contentOffset
    /// that would fight an in-flight drag or the top rubber-band.
    ///
    /// Index spaces: deletes use the OLD index space, inserts the NEW —
    /// exactly what `performBatchUpdates` expects.
    /// Refresh the flat spine snapshot + reload when new messages have landed on the spine since the
    /// last sync. Called from the SwiftUI representable's `updateUIViewController`
    /// (which fires on every `@Observable` store change) so live arrivals render.
    /// No-op when nothing changed.
    /// Keep the last bubble and jump control above the live card/composer. If
    /// the user is already at the newest edge, preserve that bottom anchor as
    /// the input changes height; otherwise leave their reading position alone.
    func updateBottomContentInset(_ value: CGFloat) {
        guard abs(value - bottomContentInset) > 0.5 else { return }
        // Preserve the semantic follow state, not a fragile 2pt snapshot. A
        // late SwiftUI measurement may arrive after safe-area/keyboard layout
        // has already shifted the old max offset by several points.
        let shouldFollow = followingBottom || distanceToBottom() <= Self.bottomFollowTolerance
        bottomContentInset = value
        collectionView.contentInset.bottom = value
        collectionView.verticalScrollIndicatorInsets.bottom = value
        jumpButtonBottomConstraint?.constant = -(value + 16)
        collectionView.layoutIfNeeded()
        followingBottom = shouldFollow
        if shouldFollow {
            pinToBottom(reason: "composer-inset")
        }
        updateJumpButtonVisibility()
    }

    private func refreshVisibleLiveCard(at index: Int, duringPaging: Bool) {
        let indexPath = IndexPath(item: index, section: 0)
        if duringPaging {
            // A collection batch owns the data-source index space. Avoid a
            // nested item reload; update the already-visible cell in place and
            // let the deferred post-page sync perform the authoritative reload.
            if let cell = collectionView.cellForItem(at: indexPath) as? TKBubbleCell,
               let card = vm.card {
                let content = TKBubbleContent.live(
                    card: card,
                    agent: agentName,
                    sessionId: sessionId,
                    steps: vm.lastUserStepsHint
                )
                cell.configure(content, cellWidth: collectionView.bounds.width)
                cell.onOpenSteps = { [weak self] _ in self?.presentLiveSteps() }
            }
            collectionView.collectionViewLayout.invalidateLayout()
            return
        }

        guard index < collectionView.numberOfItems(inSection: 0) else { return }
        // Empty delta → permission/question/tool action keeps the same stable
        // `__live_card__` identity. A reconfigure/direct frame update can race
        // the preceding insertion layout and leave the old empty cell visible.
        // Reload exactly this one item so UIKit reruns both cellForItem and the
        // delegate size query. This is still O(1): no spine/full-table reload.
        UIView.performWithoutAnimation {
            collectionView.reloadItems(at: [indexPath])
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.layoutIfNeeded()
        }
    }

    func syncLiveUpdates() {
        let cardSig = liveCardSignature
        let cardChanged = cardSig != lastLiveCardSignature
        let sig = "\(vm.filteredMessages.count)|\(vm.windowTopSeq)|\(vm.windowBottomSeq)|\(vm.sessionLastSeq)|\(cardSig)"
        chatPerfLog.log("[diag] syncLive sig=\(sig) last=\(lastSyncedSignature) items=\(items.count)")
        logEntryState("syncBefore")
        guard sig != lastSyncedSignature else { return }
        lastSyncedSignature = sig
        // If a pagination batch is mid-flight, a `reloadData()` here would
        // desync `items` from the batch's view of the data source and surface
        // as empty-cell (OOB guard) flashes. Defer the spine reload until the
        // page settles; `cardChanged` (streaming tail) still reconfigures the
        // single live-card cell cheaply so the tail keeps updating live.
        let pagingInFlight = fetchingOlder || fetchingNewer
        if pagingInFlight {
            refreshSpineSnapshot()
            if cardChanged, let idx = items.firstIndex(of: Self.liveCardID) {
                lastLiveCardSignature = cardSig
                refreshVisibleLiveCard(at: idx, duringPaging: true)
            }
            return
        }
        refreshSpineSnapshot()
        // Tail append (including the important empty → first-message
        // transition): reconcile items → ids and reload. Head metadata can
        // also change without changing ids; refresh the footer/jump state so
        // an initially unknown head does not leave a permanent newer spinner.
        let newIds = ids
        let showOlderSpinner = hasLoadedWindow && !atOldest
        let showNewerSpinner = hasLoadedWindow && hasAuthoritativeHead && !atNewest
        let edgeStateChanged = loadingOlder != showOlderSpinner || loadingNewer != showNewerSpinner
        loadingOlder = showOlderSpinner
        loadingNewer = showNewerSpinner
        let idsChanged = items != newIds
        if idsChanged || edgeStateChanged {
            // Full reload only when the spine item set or edge spinners moved.
            let wasAtBottom = followingBottom || distanceToBottom() <= Self.bottomFollowTolerance
            items = newIds
            lastLiveCardSignature = cardSig
            collectionView.reloadData()
            collectionView.layoutIfNeeded()
            if !items.isEmpty, !didInitialScroll || wasAtBottom {
                followingBottom = true
                pinToBottom(reason: "live-update", animated: didInitialScroll && !wasAtBottom)
            }
        } else if cardChanged {
            // Only the streaming tail cell's content changed (same item set).
            // Avoid the full reloadData()+layoutIfNeeded() storm that fired
            // once per streaming chunk and fought scroll/gesture state - just
            // reconfigure the live-card cell (and re-pin only if we're
            // following, so a growing tail stays visible without yanking a
            // user who scrolled up).
            lastLiveCardSignature = cardSig
            if let idx = items.firstIndex(of: Self.liveCardID) {
                refreshVisibleLiveCard(at: idx, duringPaging: false)
            }
            if followingBottom, !items.isEmpty {
                pinToBottom(reason: "live-tail", animated: false)
            }
        }
        updateJumpButtonVisibility()
        updateOverlay()
        logEntryState("syncAfter")
    }

    private func applyEdges(txn: PaginateTxn? = nil,
                            reason: String,
                            insertFront: Int = 0, deleteFront: Int = 0,
                            insertBack: Int = 0, deleteBack: Int = 0) {
        let t0 = CFAbsoluteTimeGetCurrent()
        let oldCount = items.count
        let newIds = ids

        // AUTHORITATIVE EDGES (race-proof): the `insert*/delete*` deltas handed
        // in were computed EARLIER — in the caller's reconcile, before an async
        // `measurePage` gap. During that gap the OTHER pagination direction's
        // `refreshSpineSnapshot()` can mutate `turns`/`ids`, so the passed deltas may no
        // longer describe the live `items → ids` transition. Applying a batch
        // update whose deltas disagree with `items.count` desyncs the collection
        // view from the data source → `cellForItemAt` indexes `items` out of
        // bounds → SIGTRAP. So we RE-DERIVE the edits here, atomically, against
        // the current arrays, and ignore the (logging-only) parameters.
        guard let e = reconcileEdges(old: items, new: newIds) else {
            // No common anchor (buffer too deep / full replace) → safe reload.
            // Loses the scroll anchor (rare), but never crashes. The deepEnough
            // buffer hold keeps this practically unreachable.
            chatPerfLog.log("[apply] \(reason) NO-COMMON reload old=\(oldCount) new=\(newIds.count)")
            UIView.performWithoutAnimation {
                loadingOlder = hasLoadedWindow && !atOldest
                loadingNewer = hasLoadedWindow && hasAuthoritativeHead && !atNewest
                items = newIds
                collectionView.reloadData()
                collectionView.layoutIfNeeded()
            }
            warmWindow()
            return
        }
        let iF = e.insertFront, dF = e.deleteFront, iB = e.insertBack, dB = e.deleteBack

        // FRONT-SHIFT via SIZER-SUM (faithful 1:1 port of the validated test-page
        // engine; replaces the geometry-anchor variant production had diverged
        // into). Sum the heights of everything ABOVE the anchor that this edit
        // changes — older turns prepended push content down (+), trimmed-front
        // turns pull it up (−) — plus the ±44pt top-spinner toggle, and apply it
        // as ONE atomic contentOffset shift right after the batch, with NO
        // intervening `layoutIfNeeded`.
        //
        // Why this kills the blank-cell flash: the anchor variant read the turn's
        // post-layout position to self-correct, which forced a `layoutIfNeeded`
        // at the STILL-UNSHIFTED offset; on a far-end trim while parked at the
        // bottom that layout saw the offset pointing past the now-shorter content
        // and requested beyond-count cells → the OOB guard flashed blank cells.
        // The sizer-sum is precomputed and never touches a stale-offset layout,
        // so the artefact cannot occur — exactly why the test page never showed
        // it. Render units are identical to the test page (same grouper + same
        // block→[opener,block] split), so the sum is computed over the SAME turn
        // cells. Boundary reshape stays exact because reconcileEdges encodes it as
        // deleteFront(old id) + insertFront(new id): the old height leaves the sum
        // (cached) and the new height enters it (fresh measure), and the SAME
        // RealCellSizer feeds both this sum and the layout.
        let measureWidth = collectionView.bounds.width
        var frontDelta: CGFloat = 0
        for id in newIds.prefix(iF) {           // older turns prepended → push down (+)
            if let message = message(id) { frontDelta += sizer.height(for: message, width: measureWidth) }
            else if let c = sizer.cached(id) { frontDelta += c }
        }
        for id in items.prefix(dF) {            // front turns trimmed → pull up (−); `items` still OLD
            frontDelta -= sizer.cached(id) ?? 0
        }
        // Auto-manage the PERSISTENT edge spinners. The top "loading earlier"
        // header lives ABOVE the anchor, so fold its ±44pt show/hide into this
        // same front shift; the bottom "loading newer" footer sits BELOW the
        // viewport, so toggling it costs no shift (the free side). Each appears
        // the instant we trim back into unloaded history on its side and
        // disappears the instant that side's true boundary lands.
        let showOlderSpinner = !atOldest
        let showNewerSpinner = !atNewest
        let olderSpinnerChanged = showOlderSpinner != loadingOlder
        let newerSpinnerChanged = showNewerSpinner != loadingNewer
        if olderSpinnerChanged {
            frontDelta += showOlderSpinner ? spinnerRowHeight : -spinnerRowHeight
        }

        items = newIds
        let newCount = items.count

        UIView.performWithoutAnimation {
            // Fold the spinner header/footer size change into the SAME layout pass
            // as the item edits, so there's no intermediate frame where the row is
            // gone/added but the offset hasn't caught up.
            if olderSpinnerChanged || newerSpinnerChanged {
                if olderSpinnerChanged { loadingOlder = showOlderSpinner }
                if newerSpinnerChanged { loadingNewer = showNewerSpinner }
                let ctx = UICollectionViewFlowLayoutInvalidationContext()
                ctx.invalidateFlowLayoutDelegateMetrics = true
                collectionView.collectionViewLayout.invalidateLayout(with: ctx)
            }
            collectionView.performBatchUpdates {
                if dF > 0 {
                    collectionView.deleteItems(at: (0..<dF).map { IndexPath(item: $0, section: 0) })
                }
                if dB > 0 {
                    collectionView.deleteItems(at: ((oldCount - dB)..<oldCount).map { IndexPath(item: $0, section: 0) })
                }
                if iF > 0 {
                    collectionView.insertItems(at: (0..<iF).map { IndexPath(item: $0, section: 0) })
                }
                if iB > 0 {
                    collectionView.insertItems(at: ((newCount - iB)..<newCount).map { IndexPath(item: $0, section: 0) })
                }
            }
            // Re-pin the viewport against the now-updated content size and reset
            // any in-flight drag/bounce so it doesn't snap back. No layoutIfNeeded:
            // the shift is precomputed from the sizer, never read post-layout.
            applyFrontShift(frontDelta)
        }

        let ms = (CFAbsoluteTimeGetCurrent() - t0) * 1000
        let state = collectionView.isDragging ? "drag" : (collectionView.isDecelerating ? "decel" : "rest")
        let offNow = collectionView.contentOffset.y
        if let txn {
            // Final reconciliation: did the manual batch edits land the
            // collection view EXACTLY on the grouper truth?
            let match = (items == ids)
            let cv = collectionView.numberOfItems(inSection: 0)
            chatPerfLog.log("[txn \(txn.id)] apply count=\(self.messageCount) win=[\(self.vm.windowTopSeq),\(self.vm.windowBottomSeq)] frontDelta=\(String(format: "%.0f", frontDelta)) state=\(state) itemsMatchIds=\(yn(match)) cv=\(cv) dt=\(f1(ms))")
            chatPerfLog.log("[txn \(txn.id)] END total=\(f1(txn.total()))")
        } else {
            chatPerfLog.log("[apply] \(reason) count=\(self.messageCount) win=[\(self.vm.windowTopSeq),\(self.vm.windowBottomSeq)] ms=\(String(format: "%.1f", ms)) frontDelta=\(String(format: "%.0f", frontDelta)) state=\(state) offNow=\(String(format: "%.0f", offNow))")
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            chatPerfLog.log("[apply] \(reason) settled offY=\(String(format: "%.0f", self.collectionView.contentOffset.y))")
            // A live update may have been deferred while this pagination batch
            // was in flight. Re-run now that items/byId are settled so the
            // spine catches up to any card/message changes that arrived mid-page.
            self.syncLiveUpdates()
        }
        lastApplyMs = ms
        lastReason = reason
        updateOverlay()
        warmWindow()
        updateJumpButtonVisibility()
    }

    private func pinToBottom(reason: String, animated: Bool = false) {
        guard collectionView.numberOfItems(inSection: 0) > 0 else { return }
        isPinningBottom = true
        collectionView.layoutIfNeeded()
        let minY = -collectionView.adjustedContentInset.top
        let maxY = max(minY,
                       collectionView.contentSize.height
                       - collectionView.bounds.height
                       + collectionView.adjustedContentInset.bottom)
        lastPinnedViewportSize = collectionView.bounds.size
        lastPinnedAdjustedInsets = collectionView.adjustedContentInset
        followingBottom = true
        let targetText = String(format: "%.1f", maxY)
        let currentText = String(format: "%.1f", collectionView.contentOffset.y)
        let contentText = String(format: "%.1f", collectionView.contentSize.height)
        let viewportText = String(format: "%.1f", collectionView.bounds.height)
        let insetText = String(format: "%.1f", collectionView.adjustedContentInset.bottom)
        chatPerfLog.log("[bottom] pin reason=\(reason) target=\(targetText) current=\(currentText) content=\(contentText) viewport=\(viewportText) inset=\(insetText)")
        collectionView.setContentOffset(
            CGPoint(x: collectionView.contentOffset.x, y: maxY),
            animated: animated)
        isPinningBottom = false
    }

    private func scrollToBottom(animated: Bool) {
        pinToBottom(reason: "explicit", animated: animated)
    }

    // MARK: Scroll-driven pagination

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if scrollView.isDragging || scrollView.isTracking {
            followingBottom = distanceToBottom() <= Self.bottomFollowTolerance
        }
        // EVENT-BASED RE-ARM (no position hysteresis band): an edge is free to
        // fire whenever the viewport is in its trigger zone and no load for that
        // edge is in flight. `fetchingOlder`/`fetchingNewer` serialize the loads
        // (one at a time) and reset to false only AFTER the page is fetched, so
        // the next eligible frame re-fires automatically. Both edges are driven
        // symmetrically — `driveEdges` prefetches into a buffer while
        // APPROACHING an edge and flushes the whole buffer in ONE coalesced
        // batch when it's deep enough / at rest. The far edge is naturally a
        // no-op (its distance exceeds the prefetch runway). `scrollingToTop`
        // still suppresses the status-bar-tap glide so it does not cascade
        // reveals while the animation chases contentOffset 0.
        driveEdges()
    }

    /// Drive both edges from one place: prefetch + flush whichever edge the
    /// viewport is approaching. Mirror-symmetric — older (top) and newer
    /// (bottom) run the identical buffered/coalesced path, opposite sign.
    private func driveEdges() {
        guard !scrollingToTop else { return }
        updateJumpButtonVisibility()
        guard !suppressPagingForBottom else { return }
        let y = collectionView.contentOffset.y
        if y < olderPrefetchStart(), !atOldest {
            prefetchOlderIfNeeded()
            maybeFlushOlder(reason: "scroll")
        }
        if distanceToBottom() < olderPrefetchStart(), !atNewest {
            prefetchNewerIfNeeded()
            maybeFlushNewer(reason: "scroll")
        }
    }

    // A page that arrived mid-fling was stashed in `pendingApply`; run it
    // the instant the natural slide settles, so the window grows without
    // ever interrupting the user's momentum.
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        KLog.chat("📜 [scroll] settle session=\(sessionId.prefix(12)) off=\(Int(scrollView.contentOffset.y)) distBottom=\(Int(distanceToBottom())) following=\(followingBottom) items=\(items.count)")
        flushPendingApply()
        // Motion fully stopped → resume idle height warming AND the page
        // measurer. The list is now static, so the (possibly expensive)
        // markdown self-size for a pending page runs here behind the spinner
        // — never on a scroll frame. The apply (barrier) fires once every
        // height is measured, so the page is fully rendered before it lands.
        warmer.resume()
        pager.resume()
        setVisibleBodiesInteractive(true)
        settleEdges()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        KLog.chat("📜 [scroll] drag-end session=\(sessionId.prefix(12)) decelerate=\(decelerate) off=\(Int(scrollView.contentOffset.y)) distBottom=\(Int(distanceToBottom())) following=\(followingBottom)")
        // Finger lifted with no momentum → settle immediately (no
        // didEndDecelerating will follow).
        if !decelerate {
            flushPendingApply()
            warmer.resume()
            pager.resume()
            setVisibleBodiesInteractive(true)
            settleEdges()
        }
    }

    /// At rest: flush whatever each edge has buffered (jump-free now) and keep
    /// the approaching buffer topped up. Mirror-symmetric over both edges.
    private func settleEdges() {
        maybeFlushOlder(reason: "settle")
        prefetchOlderIfNeeded()
        maybeFlushNewer(reason: "settle")
        prefetchNewerIfNeeded()
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        KLog.chat("📜 [scroll] drag-begin session=\(sessionId.prefix(12)) off=\(Int(scrollView.contentOffset.y)) content=\(Int(scrollView.contentSize.height)) following=\(followingBottom)")
        // NOTE: we deliberately do NOT flush a pending page here. The pending
        // work is the heavy STEP-2 snapshot refresh+apply; running it at the instant the
        // finger touches down would hitch the drag's first frames. It stays
        // stashed and applies when THIS new gesture settles (the spinner covers
        // the wait). Cheap mid-fling re-grabs are no longer a special case.
        // User touched the list → any in-flight scroll-to-top is cancelled,
        // so re-enable pagination (safety net if didScrollToTop never fires).
        scrollingToTop = false
        // User grabbed the list → cancel any ↓-to-latest glide gate too.
        suppressPagingForBottom = false
        // Keep following until movement actually carries the viewport away;
        // scrollViewDidScroll owns that transition so a harmless tap/grab at
        // the bottom does not disable composer/keyboard anchoring.
        followingBottom = distanceToBottom() <= Self.bottomFollowTolerance
        // Stand down warming AND page measurement for the duration of the
        // gesture/fling so no expensive self-size competes with scroll frames.
        // The spinner stays up; the page measures + applies once motion stops.
        warmer.pause()
        pager.pause()
        setVisibleBodiesInteractive(false)
    }

    // The ↓-to-latest programmatic glide finished — lift its paging gate and
    // settle both edges at rest.
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        endBottomGlide()
    }

    // Status-bar tap → scroll-to-top. Suppress pagination for its duration so
    // it glides to the top of the loaded content instead of triggering an
    // endless prepend cascade as the animation chases contentOffset 0.
    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        scrollingToTop = true
        return true
    }

    func scrollViewDidScrollToTop(_ scrollView: UIScrollView) {
        scrollingToTop = false
        KLog.chat("📜 [scroll] to-top session=\(sessionId.prefix(12))")
        // The animation has parked at the top of the loaded content; reveal any
        // pending/buffered older page (jump-free, at rest) then top up.
        flushPendingApply()
        maybeFlushOlder(reason: "scrolledTop")
        prefetchOlderIfNeeded()
    }

    /// Budget-slice the measurement of a soon-to-be-applied page on the
    /// never-paused `pager`, then run `apply` once every height is cached.
    /// If all heights are already warm (the common case, thanks to idle
    /// look-ahead), `apply` runs on the next tick with nothing to measure —
    /// so this adds no latency when warm and bounded latency when cold,
    /// instead of a synchronous self-size storm inside `applyEdges`.
    private func measurePage(_ page: ArraySlice<ChatMessage>, then apply: @escaping () -> Void) {
        let width = collectionView.bounds.width
        guard width > 0 else { apply(); return }
        var jobs: [() -> Void] = []
        for t in page where sizer.cached(t.id) == nil {
            jobs.append { [weak self] in self?.sizer.prime(t, width: width) }
        }
        if jobs.isEmpty { apply(); return }
        chatPerfLog.log("[page] measure n=\(jobs.count)")
        jobs.append(apply)            // barrier: apply after the page is warm
        pager.enqueue(jobs)
    }

    /// Reconcile two window snapshots (old → new) into edge edits by diffing
    /// `ChatMessage.id`. Robust to the BOUNDARY-MERGE case: when older history is
    /// paged in, the window's top turn (often a half-captured block) refreshes the snapshot
    /// into a NEW combined turn with a different id — so an exact "is old-first
    /// still present?" check fails. Instead we anchor on the contiguous COMMON
    /// MIDDLE (turns present in both, unchanged by paging) and express the
    /// boundary reshape as delete-old-edge + insert-new-edge at each end:
    ///   • insertFront = new turns before the first common id
    ///   • deleteFront = old turns before the first common id (merged-away)
    ///   • insertBack  = new turns after the last common id
    ///   • deleteBack  = old turns after the last common id (trimmed/merged)
    /// Returns nil only when the two snapshots share NO turn at all (→ caller
    /// does a full reload rather than risk a bad batch update).
    private func reconcileEdges(old: [String], new: [String])
        -> (insertFront: Int, deleteFront: Int, insertBack: Int, deleteBack: Int)? {
        if old.isEmpty { return (new.count, 0, 0, 0) }
        if new.isEmpty { return (0, old.count, 0, 0) }
        let newSet = Set(new)
        let oldSet = Set(old)
        guard let firstCommonOldIdx = old.firstIndex(where: { newSet.contains($0) }),
              let firstCommonNewIdx = new.firstIndex(of: old[firstCommonOldIdx]),
              let lastCommonNewIdx = new.lastIndex(where: { oldSet.contains($0) }),
              let lastCommonOldIdx = old.lastIndex(of: new[lastCommonNewIdx])
        else { return nil }
        let insertFront = firstCommonNewIdx
        let deleteFront = firstCommonOldIdx
        let insertBack = new.count - 1 - lastCommonNewIdx
        let deleteBack = old.count - 1 - lastCommonOldIdx
        return (insertFront, deleteFront, insertBack, deleteBack)
    }

    // MARK: Newer pagination — SYMMETRIC mirror of the older buffered engine
    //
    // Exact sign-flip of the older path (fetchOlder/prefetch/maybeFlush/flush):
    // approach the BOTTOM → prefetch newer pages into a buffer → reveal the
    // whole buffer in ONE coalesced batch via `applyWhenStable`. Going newer the
    // costly above-viewport op is the FRONT-TRIM (maxWindow slides the top out),
    // but `applyEdges`'s geometry anchor pins it jump-free exactly like the
    // older prepend — so DOWN now feels identical to UP (validated in the test
    // page). Data source: `vm.pageNewerRaw()` (sync DB read) + `refreshSpineSnapshot()`.

    /// Newer turns grouped into the model but not yet revealed in `items`.
    private func bufferedNewerCount() -> Int {
        guard let e = reconcileEdges(old: items, new: ids) else { return messages.count }
        return e.insertBack
    }
    private func bufferedNewerHeight() -> CGFloat {
        let n = bufferedNewerCount()
        guard n > 0 else { return 0 }
        let w = collectionView.bounds.width
        var hgt: CGFloat = 0
        for message in messages.suffix(n) { hgt += sizer.height(for: message, width: w) }
        return hgt
    }
    /// Distance from the viewport to the bottom of loaded content (px).
    private func distanceToBottom() -> CGFloat {
        collectionView.contentSize.height + collectionView.adjustedContentInset.bottom
            - collectionView.bounds.height - collectionView.contentOffset.y
    }

    /// Fire one page fetch into the newer buffer (serialized). On return it
    /// refreshes the snapshot, measures the buffered page off-frame, then re-evaluates flush +
    /// prefetch. Mirror of `fetchOlder`.
    private func fetchNewer() {
        guard !fetchingNewer, !atNewest, !scrollingToTop else { return }
        fetchingNewer = true
        KLog.chat("📤 [page] fetch-newer session=\(sessionId.prefix(12)) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) distBottom=\(Int(distanceToBottom()))")
        let gen = pagingGeneration
        let txn = newTxn("newer")
        let winBefore = vm.windowBottomSeq
        // The bottom spinner is persistent while newer history remains
        // (auto-managed in applyEdges from !atNewest), so nothing to toggle.
        chatPerfLog.log("[txn \(txn.id) fetch] newer y=\(String(format: "%.0f", collectionView.contentOffset.y)) buf=\(bufferedNewerCount()) drag=\(yn(collectionView.isDragging)) decel=\(yn(collectionView.isDecelerating))")
        Task { @MainActor [weak self] in
            guard let self else { return }
            txn.mark()
            let moved = self.vm.pageNewerRaw()
            self.fetchingNewer = false
            // Stale across a re-anchor (jump-to-latest) → this page targeted the
            // old window; snapshot refresh/flushing it now would fight the fresh one.
            guard gen == self.pagingGeneration else {
                chatPerfLog.log("[txn \(txn.id)] STALE newer gen=\(gen) cur=\(self.pagingGeneration) — drop")
                return
            }
            chatPerfLog.log("[txn \(txn.id)] raw bot \(winBefore)→\(self.vm.windowBottomSeq) moved=\(self.yn(moved)) dt=\(self.f1(txn.lap()))")
            guard moved else {
                chatPerfLog.log("[txn \(txn.id)] END noop moved=false total=\(self.f1(txn.total()))")
                return
            }
            self.refreshSpineSnapshot()
            let n = self.bufferedNewerCount()
            chatPerfLog.log("[txn \(txn.id)] group buf=\(n) dt=\(self.f1(txn.lap()))")
            self.measurePage(self.messages.suffix(n)) {
                self.maybeFlushNewer(reason: self.atNewest ? "atNewest" : "fetched")
                self.prefetchNewerIfNeeded()
            }
        }
    }

    /// Top up the newer buffer while approaching the bottom, until it can clear
    /// the band. Mirror of `prefetchOlderIfNeeded`.
    private func prefetchNewerIfNeeded() {
        guard !suppressPagingForBottom else { return }
        guard !atNewest, !fetchingNewer, !scrollingToTop else { return }
        guard distanceToBottom() < olderPrefetchStart() else { return }
        guard bufferedNewerHeight() < olderBufferTargetHeight else { return }
        fetchNewer()
    }

    /// Reveal the buffered newer pages in ONE batch update when due. Mirror of
    /// `maybeFlushOlder` (near the BOTTOM instead of the top).
    private func maybeFlushNewer(reason: String) {
        guard !suppressPagingForBottom else { return }
        let n = bufferedNewerCount()
        guard n > 0, !scrollingToTop else { return }
        let atRest = !collectionView.isDragging && !collectionView.isDecelerating
        let nearBottom = distanceToBottom() < pageTriggerHeadroom
        let deepEnough = bufferedNewerHeight() >= olderBufferTargetHeight
        let cap = n >= 120
        guard (nearBottom && (deepEnough || atNewest))
                || (atRest && nearBottom)
                || cap else { return }
        flushNewer(reason: reason)
    }

    /// Reveal the buffered newer turns into `items` in one anchored batch update
    /// (deferred to rest by `applyWhenStable`). The far-edge front-trim is
    /// pinned jump-free by the geometry anchor in `applyEdges`; the bottom
    /// spinner is auto-managed there from `!atNewest`. Mirror of `flushOlder`.
    private func flushNewer(reason: String) {
        let old = items
        let new = ids
        guard let e = reconcileEdges(old: old, new: new) else {
            chatPerfLog.log("[flush \(reason)] NO-COMMON reload old=\(old.count) new=\(new.count)")
            loadingNewer = !atNewest
            items = new
            collectionView.reloadData()
            warmWindow()
            return
        }
        guard e.insertFront > 0 || e.deleteFront > 0 || e.insertBack > 0 || e.deleteBack > 0 else { return }
        let survOld = Array(old[e.deleteFront ..< (old.count - e.deleteBack)])
        let survNew = Array(new[e.insertFront ..< (new.count - e.insertBack)])
        guard survOld == survNew else {
            let mm = firstMismatch(survOld, survNew)
            chatPerfLog.log("[flush \(reason)] midInvalid mismatch=\(mm.idx) → reload")
            loadingNewer = !atNewest
            items = new
            collectionView.reloadData()
            warmWindow()
            return
        }
        chatPerfLog.log("[flush \(reason)] iF=\(e.insertFront) dF=\(e.deleteFront) iB=\(e.insertBack) dB=\(e.deleteBack)")
        applyWhenStable {
            self.applyEdges(reason: "loadNewer",
                            insertFront: e.insertFront, deleteFront: e.deleteFront,
                            insertBack: e.insertBack, deleteBack: e.deleteBack)
        }
    }

    // MARK: Older pagination — decoupled fetch / apply (buffered coalescing)
    //
    // Copied 1:1 (in structure) from the validated ScrollPerfTest engine; only
    // the DATA SOURCE is swapped:
    //   • test page  `provider.loadOlder()` (sync slide of a mock window)
    //   • production `await vm.pageOlderRaw()` + `refreshSpineSnapshot()` (off-main DB page,
    //                then re-group the raw window into turns).
    // The buffer = the grouped model (`turns`) advanced past the applied cells
    // (`items`). Boundary-merge safe: its depth is the new-front count from
    // `reconcileEdges(old: items, new: ids)` (the oldest applied turn may merge
    // into a new id when older history arrives), NOT raw seq arithmetic.
    //
    // Why this cannot run away (the 370-fetch/3-apply bug): one production DB
    // page is `ensurePageSize`=200 raw msgs → many turns → far TALLER than the
    // viewport, so a SINGLE fetched page already exceeds `olderBufferTargetHeight`.
    // `prefetchOlderIfNeeded` then HOLDS (no more fetches) until a flush drains
    // the buffer. So a fling does ~one fetch+snapshot refresh per revealed page, not one
    // per frame.

    /// Older turns grouped into the model but not yet revealed in `items`.
    private func bufferedOlderCount() -> Int {
        guard let e = reconcileEdges(old: items, new: ids) else { return messages.count }
        return e.insertFront
    }
    private func bufferedOlderHeight() -> CGFloat {
        let n = bufferedOlderCount()
        guard n > 0 else { return 0 }
        let w = collectionView.bounds.width
        var hgt: CGFloat = 0
        for message in messages.prefix(n) { hgt += sizer.height(for: message, width: w) }
        return hgt
    }
    /// Keep filling the buffer until it can cover this much content above the
    /// viewport — enough to clear the trigger band in one reveal (+ margin).
    private var olderBufferTargetHeight: CGFloat { pageTriggerHeadroom + 600 }
    /// Start prefetching this far from the top so the round trip + snapshot refresh hide
    /// behind the approach (fetch latency × scroll speed needs a few screens).
    private func olderPrefetchStart() -> CGFloat {
        max(pageTriggerHeadroom + 200, 3.0 * collectionView.bounds.height)
    }

    /// Fire one page fetch into the buffer (serialized). On return it refreshes the snapshot
    /// (advances the model), measures the buffered page off-frame, then
    /// re-evaluates flush + prefetch.
    private func fetchOlder() {
        guard !fetchingOlder, !atOldest, !scrollingToTop else { return }
        fetchingOlder = true
        KLog.chat("📤 [page] fetch-older session=\(sessionId.prefix(12)) win=[\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) off=\(Int(collectionView.contentOffset.y))")
        let gen = pagingGeneration
        let txn = newTxn("older")
        let winBefore = vm.windowTopSeq
        // The top spinner is persistent while older history remains (set in
        // applyInitial, removed only at the true oldest), so nothing to toggle.
        chatPerfLog.log("[txn \(txn.id) fetch] older y=\(String(format: "%.0f", collectionView.contentOffset.y)) buf=\(bufferedOlderCount()) drag=\(yn(collectionView.isDragging)) decel=\(yn(collectionView.isDecelerating))")
        Task { @MainActor [weak self] in
            guard let self else { return }
            txn.mark()
            let moved = await self.vm.pageOlderRaw()
            self.fetchingOlder = false
            // Stale across a re-anchor (jump-to-latest) → this page targeted the
            // old window; snapshot refresh/flushing it now would slide the freshly
            // pinned window off the tail. (The provider's DB read already
            // re-validates topSeq, so the store isn't mutated across a reset —
            // this just skips the now-meaningless grouping/flush.)
            guard gen == self.pagingGeneration else {
                chatPerfLog.log("[txn \(txn.id)] STALE older gen=\(gen) cur=\(self.pagingGeneration) — drop")
                return
            }
            chatPerfLog.log("[txn \(txn.id)] raw top \(winBefore)→\(self.vm.windowTopSeq) moved=\(self.yn(moved)) dt=\(self.f1(txn.lap()))")
            guard moved else {
                chatPerfLog.log("[txn \(txn.id)] END noop moved=false total=\(self.f1(txn.total()))")
                return
            }
            // Advance the grouped model — the buffer grows. (The test page's
            // `provider.loadOlder()` is the analog; snapshot refresh is the cost the mock
            // window doesn't have, kept here off the REVEAL.)
            self.refreshSpineSnapshot()
            let n = self.bufferedOlderCount()
            chatPerfLog.log("[txn \(txn.id)] group buf=\(n) dt=\(self.f1(txn.lap()))")
            // Warm the buffered turns off-frame; only THEN are their heights
            // known, so flush/prefetch decisions read a hot cache.
            self.measurePage(self.messages.prefix(n)) {
                self.maybeFlushOlder(reason: self.atOldest ? "atOldest" : "fetched")
                self.prefetchOlderIfNeeded()
            }
        }
    }

    /// Top up the buffer while approaching the top, until it can clear the band.
    private func prefetchOlderIfNeeded() {
        guard !suppressPagingForBottom else { return }
        guard !atOldest, !fetchingOlder, !scrollingToTop else { return }
        let y = collectionView.contentOffset.y
        guard y < olderPrefetchStart() else { return }
        // Buffer already deep enough to clear the band → hold (don't over-fetch).
        guard bufferedOlderHeight() < olderBufferTargetHeight else { return }
        fetchOlder()
    }

    /// Reveal the buffered pages in ONE batch update when it's due. The key to
    /// coalescing: do NOT flush a shallow buffer just because we reached the
    /// trigger line — hold until the buffer is deep enough to clear the band in
    /// one shot (or we've stopped / hit the true oldest). While holding near the
    /// top the loaded content still fills the viewport, so we WAIT for enough
    /// older rows to arrive instead of washboarding one tiny page per frame.
    private func maybeFlushOlder(reason: String) {
        guard !suppressPagingForBottom else { return }
        let n = bufferedOlderCount()
        guard n > 0, !scrollingToTop else { return }
        let y = collectionView.contentOffset.y
        let atRest = !collectionView.isDragging && !collectionView.isDecelerating
        let nearTop = y < pageTriggerHeadroom
        let deepEnough = bufferedOlderHeight() >= olderBufferTargetHeight
        let cap = n >= 120                            // hard memory bound
        guard (nearTop && (deepEnough || atOldest))
                || (atRest && nearTop)
                || cap else { return }
        flushOlder(reason: reason)
    }

    /// Reveal the buffered older turns into `items` in one anchored batch update
    /// (deferred to rest by `applyWhenStable`, like the test page). The exact
    /// edge edits come from `reconcileEdges` so the boundary-merge case is
    /// handled; the persistent top spinner is auto-managed inside `applyEdges`.
    private func flushOlder(reason: String) {
        let old = items
        let new = ids
        guard let e = reconcileEdges(old: old, new: new) else {
            // No common turn (buffer too deep / full replace) → safe reload.
            // deepEnough-hold keeps the buffer shallow, so this is a last resort.
            chatPerfLog.log("[flush \(reason)] NO-COMMON reload old=\(old.count) new=\(new.count)")
            loadingOlder = !atOldest
            items = new
            collectionView.reloadData()
            warmWindow()
            return
        }
        guard e.insertFront > 0 || e.deleteFront > 0 || e.insertBack > 0 || e.deleteBack > 0 else { return }
        let survOld = Array(old[e.deleteFront ..< (old.count - e.deleteBack)])
        let survNew = Array(new[e.insertFront ..< (new.count - e.insertBack)])
        guard survOld == survNew else {
            let mm = firstMismatch(survOld, survNew)
            chatPerfLog.log("[flush \(reason)] midInvalid mismatch=\(mm.idx) → reload")
            loadingOlder = !atOldest
            items = new
            collectionView.reloadData()
            warmWindow()
            return
        }
        chatPerfLog.log("[flush \(reason)] iF=\(e.insertFront) dF=\(e.deleteFront) iB=\(e.insertBack) dB=\(e.deleteBack)")
        applyWhenStable {
            // The top spinner is auto-managed inside applyEdges from !atOldest:
            // it stays put across normal reveals and collapses itself the
            // instant this reveal brings in the true oldest.
            self.applyEdges(reason: "loadOlder",
                            insertFront: e.insertFront, deleteFront: e.deleteFront,
                            insertBack: e.insertBack, deleteBack: e.deleteBack)
        }
    }

    // MARK: Frame-time monitor

    private var lastApplyMs: Double = 0
    private var lastReason: String = "initial"

    private func startHitchMonitor() {
        let link = CADisplayLink(target: self, selector: #selector(onFrame(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func startFrameMonitor() {
        let link = CADisplayLink(target: self, selector: #selector(onFrame(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    @objc private func onFrame(_ link: CADisplayLink) {
        defer { lastFrameTs = link.timestamp }
        guard lastFrameTs != 0 else { return }
        // Only judge smoothness while actively scrolling. When idle,
        // ProMotion ramps the refresh rate down (10–24 Hz), so frame gaps
        // grow legitimately and would otherwise be miscounted as hitches.
        guard collectionView.isDragging || collectionView.isDecelerating else { return }
        let dtMs = (link.timestamp - lastFrameTs) * 1000
        // Expected frame ≈ link.targetTimestamp - link.timestamp. A frame
        // is "dropped" when the gap is meaningfully longer than expected.
        let expectedMs = (link.targetTimestamp - link.timestamp) * 1000
        if dtMs > max(12, expectedMs * 1.6) {
            hitchCount += 1
            if dtMs > worstFrameMs { worstFrameMs = dtMs }
            chatPerfLog.log("[hitch] \(String(format: "%.1f", dtMs))ms during=\(self.lastReason)")
            updateOverlay()
        }
    }

    private func updateOverlay() {
        guard Self.perfOverlayEnabled else { return }
        let loading = [loadingOlder ? "▲older" : nil, loadingNewer ? "▼newer" : nil]
            .compactMap { $0 }.joined(separator: " ")
        overlay.text = """
        win [\(vm.windowTopSeq),\(vm.windowBottomSeq)] head=\(vm.sessionLastSeq) n=\(messageCount)
        old:\(atOldest ? "✓" : "·") new:\(atNewest ? "✓" : "·")
        last: \(lastReason) \(String(format: "%.1f", lastApplyMs))ms
        hitches: \(hitchCount) worst:\(String(format: "%.0f", worstFrameMs))ms
        loading: \(loading.isEmpty ? "—" : loading)
        """
    }
}

// MARK: - SwiftUI bridge

struct ChatPerfListView: UIViewControllerRepresentable {
    let sessionId: String
    let agent: String
    let bottomContentInset: CGFloat
    let onResolvePermission: (String, String?, String) -> Void
    let onAnswerQuestion: (String, String) -> Void
    @Environment(AppState.self) private var appState

    func makeUIViewController(context: Context) -> ChatPerfListVC {
        ChatPerfListVC(
            sessionId: sessionId,
            appState: appState,
            agent: agent,
            bottomContentInset: bottomContentInset,
            onResolvePermission: onResolvePermission,
            onAnswerQuestion: onAnswerQuestion
        )
    }

    func updateUIViewController(_ vc: ChatPerfListVC, context: Context) {
        vc.updateBottomContentInset(bottomContentInset)
        vc.onResolvePermission = onResolvePermission
        vc.onAnswerQuestion = onAnswerQuestion
        vc.syncLiveUpdates()
    }
}
#endif
