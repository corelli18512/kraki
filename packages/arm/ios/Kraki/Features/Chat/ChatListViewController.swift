#if os(iOS)
/// ChatListViewController — UIKit-backed message list for a single
/// chat session.
///
/// Stage 1 of the UICollectionView refactor. This controller owns:
///   • a `UICollectionView` configured with a list compositional
///     layout (full-width, self-sizing cells)
///   • a `UICollectionViewDiffableDataSource` that maps stable
///     turn-id strings to grouped `TurnItem` values
///   • cell rendering via `UIHostingConfiguration` — the existing
///     SwiftUI `MessageBubbleView` / `standaloneRow` content goes
///     into cells unchanged from a rendering standpoint
///
/// The controller is hosted inside SwiftUI via
/// `ChatListView: UIViewControllerRepresentable` and reads from a
/// `ChatViewModel`. Snapshot apply is driven by an explicit call
/// from the SwiftUI wrapper's `updateUIViewController` — we do NOT
/// observe AppState directly here, because the SwiftUI shell owns
/// observation and the UIKit layer should be a pure render target.
///
/// Stage 2 will introduce `ChatScrollCoordinator` for sticky-pill
/// state and the auto-scroll state machine. Stage 3 will wire
/// auto-load-older into `scrollViewDidScroll`. Stage 4 deletes the
/// SwiftUI fallback path in ChatView once this is proven solid.

import UIKit
import SwiftUI

@MainActor
final class ChatListViewController: UIViewController {

    // MARK: - Section / Item types

    /// Single-section list. Multi-section split would only be needed
    /// if we wanted UICollectionView's sticky section headers; for
    /// chat we keep one section and let the visual grouping come from
    /// turn structure inside cells.
    enum Section: Hashable {
        case messages
    }

    /// Diffable item identifier. The stable string is the turn id
    /// from `TurnGrouper` (which is in turn derived from the
    /// underlying message id), so successive snapshot applies diff
    /// correctly: an item with the same id is "the same row" and
    /// only its cell content is reconfigured.
    struct Item: Hashable {
        let id: String
    }

    // MARK: - Stored state

    /// Stable id-to-turn mapping for the current snapshot. The data
    /// source dequeues by `Item.id`; this dictionary lets us hand the
    /// cell its full `TurnItem` value during configuration.
    private var itemsById: [String: TurnItem] = [:]

    /// The session this controller is rendering. Set by the SwiftUI
    /// wrapper on init. Doesn't change for a given instance — a
    /// different session means a new controller.
    let sessionId: String

    /// Weak reference to the SwiftUI view model. The controller reads
    /// per-cell context (agent name, expandedTurns, streaming text)
    /// through this. Held weak so the controller can outlive the
    /// model momentarily during teardown without crashing.
    private weak var viewModel: ChatViewModel?

    /// Expanded turn ids — Stage 1 keeps this as a Set passed in from
    /// the SwiftUI shell so we don't fragment ownership across the
    /// UIKit/SwiftUI seam. The SwiftUI shell holds the source of
    /// truth (`@State expandedTurns`) and forwards it in
    /// `updateController` calls.
    var expandedTurnIds: Set<String> = []

    /// Agent identifier for this session, used by cells to derive
    /// tint colours. Forwarded from the SwiftUI shell.
    var agentName: String = ""

    /// Streaming text snapshot for the in-progress turn. Forwarded
    /// from the SwiftUI shell so the in-progress cell shows live
    /// content. Nil between turns.
    var streamingText: String?

    /// Bottom content inset for the collection view — set by the
    /// SwiftUI shell to reserve space for the floating input
    /// capsule. Pure `contentInset.bottom` (NOT a safe-area inset)
    /// so it survives the `.ignoresSafeArea(.container, edges: .bottom)`
    /// applied to the wrapping representable. UIKit folds this into
    /// `adjustedContentInset.bottom`, so `scrollToItem(.bottom)`,
    /// `isAtBottom` proximity checks, and anchor restoration all
    /// land the last cell above the input rather than under it.
    var bottomContentInset: CGFloat = 0 {
        didSet {
            guard bottomContentInset != oldValue, isViewLoaded, collectionView != nil else { return }
            applyBottomContentInset()
        }
    }

    /// Closure invoked when the user toggles a turn's expanded
    /// state. The SwiftUI shell owns the source of truth; this
    /// bubbles the event up.
    var onExpandedTurnsChange: ((Set<String>) -> Void)?

    /// Target item id for the one-shot entry scroll. When set BEFORE
    /// the first non-empty `apply(turns:)`, the controller scrolls
    /// to that item at the top on the apply completion. When nil,
    /// the entry scroll lands at the bottom (read-session case).
    /// Subsequent changes after the first scroll are ignored —
    /// entry scroll fires once per controller lifetime.
    var entryScrollTargetId: String?

    /// One-shot guard so the entry scroll runs exactly once.
    private var didPerformEntryScroll: Bool = false

    // MARK: - UI

    private(set) var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Section, Item>!

    /// Pending turns to apply once `viewDidLoad` runs. SwiftUI's
    /// `makeUIViewController` calls `apply(turns:)` before UIKit
    /// has loaded the view, so we stash and replay.
    private var pendingTurns: [TurnItem]?
    /// Set to true on the first successful `apply(turns:)` after
    /// `viewDidLoad`. Used purely to emit a one-shot
    /// `🎬 ChatListVC.apply FIRST` KLog so we can correlate the
    /// SwiftUI render path with cell-paint time in the timeline.
    private var didFirstApply = false

    /// Scroll coordinator that owns this controller's UICollectionView
    /// delegate callbacks and republishes derived state (isAtBottom,
    /// growMode, etc.) for SwiftUI overlays. Held strongly because
    /// the @StateObject lifetime in the SwiftUI shell binds to the
    /// view, not the controller, and we want the controller to keep
    /// its delegate alive across reattach cycles.
    private let scrollCoordinator: ChatScrollCoordinator

    /// Item id whose cell should be held at a fixed screen Y for the
    /// duration of the idle period. Set by the SwiftUI shell via
    /// `updateIdleAnchorTarget(_:)` when sessionIdle transitions
    /// true; cleared when it transitions false or the user starts
    /// dragging. Decoupled from `scrollCoordinator.anchoredUserMsgId`
    /// here so we don't depend on Combine subscriptions for the
    /// controller's local read path — the coordinator owns the
    /// published surface for SwiftUI observers.
    private var idleAnchorTargetId: String?

    // MARK: - Init

    init(sessionId: String, viewModel: ChatViewModel, scrollCoordinator: ChatScrollCoordinator) {
        self.sessionId = sessionId
        self.viewModel = viewModel
        self.scrollCoordinator = scrollCoordinator
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("ChatListViewController does not support NSCoder init")
    }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        configureCollectionView()
        configureDataSource()
        installSpinnerHooks()
        applyBottomContentInset()
        KLog.chat("🎬 [3/render] ChatListVC.viewDidLoad session=\(sessionId.prefix(12)) pendingTurns=\(pendingTurns?.count ?? -1)")
        if let pending = pendingTurns {
            pendingTurns = nil
            apply(turns: pending)
        }
    }

    /// Tell the enclosing UINavigationController which scroll view
    /// drives the bar's scroll-edge appearance. iOS 26's default nav
    /// bar uses glass + scroll-edge tracking to render as
    /// transparent at the top edge and pick up the liquid blur once
    /// content scrolls under it. UIKit auto-detects this when the
    /// scroll view is a direct child of the topViewController, but
    /// here the collection view is buried inside a
    /// `UIViewControllerRepresentable` host, so detection fails and
    /// the bar gets stuck in a single state.
    ///
    /// Setting the content scroll view on every ancestor up to the
    /// nav stack's topViewController is the documented escape hatch
    /// (`UIViewController.setContentScrollView(_:for:)`, iOS 15+).
    /// Idempotent — safe to call on every appearance.
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        propagateContentScrollView()
    }

    private func propagateContentScrollView() {
        setContentScrollView(collectionView)
        var ancestor: UIViewController? = parent
        while let vc = ancestor {
            vc.setContentScrollView(collectionView)
            ancestor = vc.parent
        }
    }

    /// Re-attempt the one-shot entry scroll on every layout pass.
    /// At launch the first `apply(turns:)` runs from the
    /// pre-viewDidLoad replay before the view has a window — bounds
    /// are 0×0 and `scrollToItem` is a no-op. We need the first
    /// post-layout opportunity to fire the scroll instead.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        attemptEntryScroll()
        // Re-attempt idle-anchor capture in case the previous call
        // ran before layout was ready. Idempotent when the anchor
        // is already held for the current target.
        if let targetId = idleAnchorTargetId,
           scrollCoordinator.anchoredUserMsgId != targetId {
            sampleAndStoreIdleAnchor(itemId: targetId)
        }
    }

    // MARK: - Setup

    private func configureCollectionView() {
        // List-style compositional layout: each item is a horizontal
        // row spanning the available width, with self-sizing height
        // estimated by the host content. This is the closest UIKit
        // equivalent to a `VStack(spacing: 0)` of full-width cells.
        //
        // We wrap `.list(using:)` in a section provider closure so we
        // can strip `pinToVisibleBounds` off the boundary supplementary
        // items that `headerMode = .supplementary` installs. The
        // default for `.plain` list appearance pins section headers
        // to the top of the viewport (mimicking UITableView plain
        // style) — but for our use case the spinners are SENTINELS
        // that should scroll with content, not chrome that floats
        // over the bubbles. Without this fix the top spinner would
        // appear glued to the top of the viewport on every scroll
        // position, visually disconnected from the cell layer.
        let layout = UICollectionViewCompositionalLayout { _, environment in
            var listConfig = UICollectionLayoutListConfiguration(appearance: .plain)
            listConfig.showsSeparators = false
            listConfig.backgroundColor = .clear
            // Sentinel cells for "load more" triggers. Their visibility
            // IS the load trigger (see `installSpinnerHooks`), so we
            // get a single source of truth that doesn't need scroll-
            // math heuristics. SwiftUI content inside the supplementary
            // auto-sizes to zero when there's nothing to show
            // (reachedTail / !isFillingTail), so they don't add empty
            // space at the edges.
            listConfig.headerMode = .supplementary
            listConfig.footerMode = .supplementary
            let section = NSCollectionLayoutSection.list(
                using: listConfig,
                layoutEnvironment: environment
            )
            for supplementary in section.boundarySupplementaryItems {
                supplementary.pinToVisibleBounds = false
            }
            return section
        }

        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.backgroundColor = .clear
        // Keep the same "no vertical scroll indicator" feel as the
        // SwiftUI list — the bubble layout itself already implies
        // scrollable history.
        collectionView.showsVerticalScrollIndicator = false
        // Match the SwiftUI ScrollView's keyboard dismiss behaviour.
        collectionView.keyboardDismissMode = .interactive
        // Stage 2: wire scroll-derived state through the coordinator.
        // The coordinator owns the delegate callbacks; it also needs
        // a weak ref back to the collection view so SwiftUI overlays
        // can trigger `scrollToBottom` without a round-trip through
        // the representable.
        collectionView.delegate = scrollCoordinator
        scrollCoordinator.collectionView = collectionView

        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    /// Push the latest `bottomContentInset` value into the collection
    /// view. Idempotent. Updates both `contentInset.bottom` (so
    /// scrollable content can land above the input capsule) and
    /// `verticalScrollIndicatorInsets.bottom` (so the indicator
    /// matches when we ever turn it back on).
    private func applyBottomContentInset() {
        guard let cv = collectionView else { return }
        if cv.contentInset.bottom != bottomContentInset {
            cv.contentInset.bottom = bottomContentInset
        }
        if cv.verticalScrollIndicatorInsets.bottom != bottomContentInset {
            cv.verticalScrollIndicatorInsets.bottom = bottomContentInset
        }
    }

    /// Install the load-more hooks on the scroll coordinator. The
    /// coordinator routes the corresponding `willDisplaySupplementaryView`
    /// callbacks here; we delegate to the view model, which talks to
    /// the message provider and is the right place for the dedup /
    /// edge-state checks.
    private func installSpinnerHooks() {
        scrollCoordinator.onHeaderSpinnerWillDisplay = { [weak self] in
            self?.viewModel?.loadOlderIfPossible()
        }
        scrollCoordinator.onFooterSpinnerWillDisplay = { [weak self] in
            self?.viewModel?.ensureTailLoaded()
        }
    }

    private func configureDataSource() {
        // Cell registration: every cell uses a SwiftUI hosting
        // configuration that renders the `MessageRow` for the turn
        // item. UIKit handles dequeue/recycling; SwiftUI handles
        // the bubble's actual rendering, including its self-sizing.
        let cellRegistration = UICollectionView.CellRegistration<UICollectionViewListCell, Item> {
            [weak self] cell, _, item in
            guard let self,
                  let turnItem = self.itemsById[item.id] else { return }

            cell.backgroundConfiguration = .clear()
            // Remove the default list-cell content padding — the
            // bubble views supply their own internal padding and we
            // don't want extra space leaking in.
            var bg = UIBackgroundConfiguration.clear()
            bg.backgroundColor = .clear
            cell.backgroundConfiguration = bg

            cell.contentConfiguration = UIHostingConfiguration {
                MessageRow(
                    item: turnItem,
                    sessionId: self.sessionId,
                    agent: self.agentName,
                    streamingText: self.streamingForItem(turnItem),
                    expanded: self.binding(forTurnId: turnItem.id)
                )
                // Match the SwiftUI list's vertical spacing: the old
                // `VStack(spacing: 12)` provided ~12pt between rows.
                .padding(.vertical, 6)
                .padding(.horizontal, 12)
            }
            // Eliminate the hosting-configuration's default margins
            // (16pt insets) so we control spacing entirely above.
            .margins(.all, 0)
        }

        dataSource = UICollectionViewDiffableDataSource<Section, Item>(
            collectionView: collectionView
        ) { collectionView, indexPath, item in
            collectionView.dequeueConfiguredReusableCell(
                using: cellRegistration,
                for: indexPath,
                item: item
            )
        }

        // Supplementary header (top spinner) and footer (bottom
        // spinner). Both host a SwiftUI subview that reads from the
        // (Observable) view model — when `isLoadingOlder` /
        // `reachedTail` / `isFillingTail` / `reachedHead` change,
        // SwiftUI re-renders the spinner in place without needing
        // the controller to re-apply a snapshot. The supplementaries
        // self-size to zero when their content is `EmptyView` (e.g.
        // reachedTail) so they don't reserve dead space at the edges.
        let headerRegistration = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionHeader
        ) { [weak self] cell, _, _ in
            guard let self, let vm = self.viewModel else {
                cell.contentConfiguration = nil
                return
            }
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration {
                ChatLoadOlderSpinner(viewModel: vm)
            }.margins(.all, 0)
        }
        let footerRegistration = UICollectionView.SupplementaryRegistration<UICollectionViewListCell>(
            elementKind: UICollectionView.elementKindSectionFooter
        ) { [weak self] cell, _, _ in
            guard let self, let vm = self.viewModel else {
                cell.contentConfiguration = nil
                return
            }
            cell.backgroundConfiguration = .clear()
            cell.contentConfiguration = UIHostingConfiguration {
                ChatFillTailSpinner(viewModel: vm)
            }.margins(.all, 0)
        }

        dataSource.supplementaryViewProvider = { collectionView, kind, indexPath in
            switch kind {
            case UICollectionView.elementKindSectionHeader:
                return collectionView.dequeueConfiguredReusableSupplementary(
                    using: headerRegistration, for: indexPath
                )
            case UICollectionView.elementKindSectionFooter:
                return collectionView.dequeueConfiguredReusableSupplementary(
                    using: footerRegistration, for: indexPath
                )
            default:
                return nil
            }
        }
    }

    // MARK: - Snapshot apply

    /// Replace the current snapshot with `turns`. Called by the
    /// SwiftUI wrapper whenever the view model's grouping cache
    /// changes. `animatingDifferences: false` keeps streaming/idle
    /// transitions snappy — animation would visually stutter for
    /// content that's effectively a continuation of the previous
    /// state.
    func apply(turns: [TurnItem]) {
        // Pre-viewDidLoad: stash and replay later.
        guard dataSource != nil else {
            pendingTurns = turns
            KLog.chat("🎬 [3/render] ChatListVC.apply DEFERRED (pre-viewDidLoad) session=\(sessionId.prefix(12)) turns=\(turns.count)")
            return
        }
        let isFirstApply = !didFirstApply
        if isFirstApply {
            didFirstApply = true
            KLog.chat("🎬 [3/render] ChatListVC.apply FIRST session=\(sessionId.prefix(12)) turns=\(turns.count)")
        }
        // Rebuild the id → TurnItem map. Cell configuration uses
        // this; without it, dequeuing a cell after a reorder would
        // hand the cell a stale value.
        var newMap: [String: TurnItem] = [:]
        for item in turns {
            newMap[item.id] = item
        }

        // Stage 3: anchor preservation. Before mutating the data
        // source, record the topmost-visible cell's id and the
        // screen-space Y at which it currently sits. After the diff
        // applies — which may have inserted older items above it,
        // shifting its content-space Y — we re-anchor the scroll so
        // the same row stays visually pinned in place. Without this,
        // a backfill arrival would visibly jerk the viewport upward
        // by the height of the newly-inserted older history.
        let anchor = captureTopVisibleAnchor()
        // Stage 6: snapshot whether the user is currently at the
        // bottom. If yes, we re-pin the bottom after the diff so
        // streaming additions / new turns stay in view. Sampled
        // BEFORE the apply because content-size changes during the
        // diff would otherwise corrupt the "was at bottom" reading.
        let wasAtBottom = scrollCoordinator.isAtBottom

        itemsById = newMap

        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        snapshot.appendSections([.messages])
        snapshot.appendItems(turns.map { Item(id: $0.id) }, toSection: .messages)
        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            guard let self else { return }
            if isFirstApply {
                KLog.chat("🎬 [3/render] ChatListVC.apply FIRST completed session=\(self.sessionId.prefix(12)) items=\(self.dataSource.snapshot().numberOfItems)")
            }

            // Priority order for offset adjustment:
            //   1. Entry scroll (one-shot, takes over the offset).
            //   2. Follow-bottom — if we were at the bottom before
            //      the apply, snap back. Handles streaming + new
            //      turn arrival while the user is at the live edge.
            //      Wins over idle anchor: a user actively at the
            //      tail wants to follow new content, not stay
            //      pinned to an older bubble.
            //   3. Idle anchor lock — preserve the latest user
            //      bubble's screen Y. Stage 6. Only relevant when
            //      the user has scrolled away from the bottom but
            //      the session is idle.
            //   4. Top-visible anchor preservation — for in-history
            //      scroll where neither of the above applies (e.g.
            //      older-content backfill arriving during streaming).
            //
            // After the offset is settled, `recomputeIsAtBottom`
            // re-publishes the proximity flag so overlays catch up.
            //
            // The entire body is hopped to the next runloop because
            // every branch ultimately calls into UIScrollView APIs
            // (`scrollToItem`, `setContentOffset`) which synchronously
            // fire `scrollViewDidScroll` → `publishIsAtBottom`, mutating
            // the coordinator's `@Published isAtBottom`. When
            // `dataSource.apply(_, animatingDifferences: false, completion:)`
            // is invoked from inside `updateUIViewController(_:context:)`,
            // the completion fires synchronously on the same runloop —
            // so without this hop we'd publish DURING SwiftUI's view
            // update phase, producing the "Publishing changes from
            // within view updates is not allowed" runtime warning and
            // a cascade of extra renders that visibly lag chat entry.
            // One-frame delay is invisible (still pre-commit) and
            // doesn't compromise the scroll positioning semantics.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let entryFired = self.attemptEntryScroll()
                if !entryFired {
                    if wasAtBottom {
                        self.scrollCoordinator.scrollToBottom(animated: false)
                    } else if self.enforceIdleAnchor() {
                        // Idle anchor handled — skip top-visible.
                    } else if let anchor {
                        self.restoreScrollAnchor(anchor)
                    }
                }
                self.scrollCoordinator.recomputeIsAtBottom()
            }
        }
    }

    /// One-shot entry scroll. Idempotent until it fires successfully,
    /// then guarded against repeat. Returns whether the scroll fired.
    ///
    /// Preconditions checked here:
    ///   • Not already done.
    ///   • View has been laid out (`bounds.height > 0`).
    ///   • Data source has at least one item.
    ///   • For unread (target id set): target must be in the current
    ///     snapshot — otherwise we wait for the apply that brings it in.
    ///
    /// On success:
    ///   • Unread: scroll the target turn to TOP, animated false.
    ///   • Read: scroll the last turn to BOTTOM, animated false.
    @discardableResult
    private func attemptEntryScroll() -> Bool {
        guard !didPerformEntryScroll,
              let cv = collectionView,
              cv.bounds.height > 0,
              let dataSource else { return false }
        let snapshot = dataSource.snapshot()
        let identifiers = snapshot.itemIdentifiers
        guard !identifiers.isEmpty else { return false }

        if let targetId = entryScrollTargetId {
            // Unread: only fire when the target is present. If it's
            // not yet in the snapshot we leave the guard down so the
            // next apply gets another chance.
            guard let targetIndex = identifiers.firstIndex(where: { $0.id == targetId }) else {
                return false
            }
            let path = IndexPath(item: targetIndex, section: 0)
            // Force a layout pass so self-sizing cells around the
            // target have measured frames — without this the
            // attributes lookup would return nil and the animation
            // target Y would be wrong.
            cv.layoutIfNeeded()
            guard let attrs = cv.layoutAttributesForItem(at: path) else {
                return false
            }
            // Compute the same clamped offset `scrollToItem(.top)`
            // would land on, then animate to it manually instead of
            // jumping. UICollectionView's built-in animated scroll
            // composes poorly with self-sizing cells (mid-animation
            // height settling produces visible stutter); a manual
            // `UIView.animate` over `setContentOffset` is steady
            // because the target Y is pinned at frame zero.
            let inset = cv.adjustedContentInset
            let minOffsetY = -inset.top
            let maxOffsetY = max(minOffsetY, cv.contentSize.height - cv.bounds.height + inset.bottom)
            let clamped = min(maxOffsetY, max(minOffsetY, attrs.frame.minY))
            UIView.animate(
                withDuration: 0.28,
                delay: 0,
                options: [.curveEaseInOut, .beginFromCurrentState]
            ) {
                cv.setContentOffset(CGPoint(x: cv.contentOffset.x, y: clamped), animated: false)
            }
        } else {
            // Read: scroll to the last cell. UICollectionView
            // resolves the bottom position even when above-fold
            // cells haven't been sized yet — `scrollToItem(.bottom)`
            // is monotonically correct against `contentSize`.
            let lastPath = IndexPath(item: identifiers.count - 1, section: 0)
            cv.scrollToItem(at: lastPath, at: .bottom, animated: false)
        }

        didPerformEntryScroll = true
        return true
    }

    /// Force-reconfigure all visible cells in place (no snapshot
    /// diff, no re-layout from scratch). Used when bubble-internal
    /// content changes that the snapshot diff doesn't catch — e.g.
    /// `expandedTurnIds` toggled, streaming text updated.
    func reconfigureVisible() {
        var snapshot = dataSource.snapshot()
        snapshot.reconfigureItems(snapshot.itemIdentifiers)
        dataSource.apply(snapshot, animatingDifferences: false)
    }

    // MARK: - Scroll anchor preservation

    /// A captured scroll anchor: the id of the topmost-visible cell
    /// at the moment of capture, plus the screen-space Y at which
    /// that cell's top sat (i.e. content Y minus contentOffset.y).
    /// On restore we recompute the cell's new content Y after the
    /// snapshot apply and shift contentOffset.y by the delta, so the
    /// cell visually stays put.
    private struct ScrollAnchor {
        let itemId: String
        let screenY: CGFloat
    }

    /// Snapshot the topmost-visible cell. Returns nil if nothing is
    /// visible (e.g. first apply, list empty). Skips the very first
    /// "partially scrolled off the top" cell only if it's barely on
    /// screen — anchoring to a cell that's about to disappear from
    /// the viewport creates a worse experience than anchoring to the
    /// next one fully on screen.
    private func captureTopVisibleAnchor() -> ScrollAnchor? {
        guard let cv = collectionView, dataSource != nil else { return nil }
        let visiblePaths = cv.indexPathsForVisibleItems.sorted()
        guard !visiblePaths.isEmpty else { return nil }
        let snapshot = dataSource.snapshot()
        for path in visiblePaths {
            guard let attrs = cv.layoutAttributesForItem(at: path) else { continue }
            // Resolve the cell's id from the snapshot (path → id),
            // not from `itemsById` — the snapshot is the source of
            // truth for "what's in the list right now".
            let identifiers = snapshot.itemIdentifiers
            guard path.item < identifiers.count else { continue }
            let item = identifiers[path.item]
            let screenY = attrs.frame.minY - cv.contentOffset.y
            return ScrollAnchor(itemId: item.id, screenY: screenY)
        }
        return nil
    }

    // MARK: - Idle anchor lock (Stage 6)

    /// Acquire (or refresh) the idle anchor on a specific turn item.
    /// Samples the cell's current top-edge screen Y and stores it on
    /// the coordinator's published surface. No-op if the cell can't
    /// be located (e.g. user has scrolled it out of the visible
    /// region — in that case there's nothing to anchor against, and
    /// enforcing a stale Y would yank the scroll mid-view).
    ///
    /// Idempotent for repeated calls with the same `itemId`: the
    /// guard against re-sampling once we already hold the anchor
    /// for this id keeps `apply`-time enforcement using the
    /// original capture, not a freshly-sampled one whose Y may have
    /// drifted by self-sizing settling.
    func updateIdleAnchorTarget(_ itemId: String?) {
        // Release case.
        guard let itemId else {
            idleAnchorTargetId = nil
            scrollCoordinator.clearIdleAnchor()
            return
        }
        // Same id already anchored — keep the original capture.
        if idleAnchorTargetId == itemId,
           scrollCoordinator.anchoredUserMsgId == itemId {
            return
        }
        idleAnchorTargetId = itemId
        // Force a layout pass so self-sizing cells near the target
        // get attributes computed. Without this the first call right
        // after `apply` returns nil for `layoutAttributesForItem`
        // because the data source has the items but the layout
        // engine hasn't measured them yet.
        collectionView?.layoutIfNeeded()
        sampleAndStoreIdleAnchor(itemId: itemId)
    }

    /// Sample the cell's current screen Y and store it on the
    /// coordinator. No-op when the cell isn't laid out — caller
    /// retains `idleAnchorTargetId` so a later layout pass (e.g.
    /// the next apply completion's enforce) can re-attempt via the
    /// same sampling helper.
    private func sampleAndStoreIdleAnchor(itemId: String) {
        guard let cv = collectionView, let dataSource else { return }
        let snapshot = dataSource.snapshot()
        let identifiers = snapshot.itemIdentifiers
        guard let index = identifiers.firstIndex(where: { $0.id == itemId }) else { return }
        let path = IndexPath(item: index, section: 0)
        guard let attrs = cv.layoutAttributesForItem(at: path) else { return }
        let screenY = attrs.frame.minY - cv.contentOffset.y
        scrollCoordinator.setIdleAnchor(itemId: itemId, screenY: screenY)
    }

    /// Enforce the active idle anchor on the current layout. Looks
    /// up the anchored cell's new content-Y and shifts contentOffset
    /// so the cell's top sits at the captured screen Y. Returns
    /// `true` when an offset adjustment was applied — callers use
    /// this to skip other anchor mechanisms for the same apply.
    ///
    /// No-op when:
    ///   • No anchor is held on the coordinator.
    ///   • The anchored item is no longer in the snapshot
    ///     (rare — only possible if the SwiftUI shell stops sending
    ///     us a target id while content is mutating; defensive).
    ///   • The cell isn't yet laid out (no attributes available).
    ///   • The required offset would clamp to its current value
    ///     (saves a redundant `setContentOffset` call).
    @discardableResult
    private func enforceIdleAnchor() -> Bool {
        guard let itemId = scrollCoordinator.anchoredUserMsgId,
              let screenY = scrollCoordinator.anchoredScreenY,
              let cv = collectionView,
              let dataSource else { return false }
        let snapshot = dataSource.snapshot()
        let identifiers = snapshot.itemIdentifiers
        guard let index = identifiers.firstIndex(where: { $0.id == itemId }) else { return false }
        let path = IndexPath(item: index, section: 0)
        cv.layoutIfNeeded()
        guard let attrs = cv.layoutAttributesForItem(at: path) else { return false }
        let targetOffsetY = attrs.frame.minY - screenY
        let inset = cv.adjustedContentInset
        let minOffsetY = -inset.top
        let maxOffsetY = max(minOffsetY, cv.contentSize.height - cv.bounds.height + inset.bottom)
        let clamped = min(maxOffsetY, max(minOffsetY, targetOffsetY))
        guard abs(cv.contentOffset.y - clamped) > 0.5 else { return true }
        cv.setContentOffset(CGPoint(x: cv.contentOffset.x, y: clamped), animated: false)
        return true
    }

    /// Restore the captured anchor by computing the cell's new
    /// content-space Y and shifting contentOffset so the cell sits
    /// at the same screen Y as before. No-op if the cell is no
    /// longer in the snapshot (e.g. user-initiated full reload) or
    /// the layout hasn't placed the item yet.
    private func restoreScrollAnchor(_ anchor: ScrollAnchor) {
        guard let cv = collectionView, let dataSource else { return }
        let snapshot = dataSource.snapshot()
        let identifiers = snapshot.itemIdentifiers
        guard let newIndex = identifiers.firstIndex(where: { $0.id == anchor.itemId }) else {
            return
        }
        let path = IndexPath(item: newIndex, section: 0)
        // Force the layout to size this item before asking for its
        // attributes — self-sizing cells may not have been measured
        // yet for items above the current viewport.
        cv.layoutIfNeeded()
        guard let attrs = cv.layoutAttributesForItem(at: path) else { return }
        let targetOffsetY = attrs.frame.minY - anchor.screenY
        // Clamp to scrollable range so we don't end up with an
        // out-of-bounds offset that would bounce-back on the next
        // runloop tick.
        let inset = cv.adjustedContentInset
        let minOffsetY = -inset.top
        let maxOffsetY = max(minOffsetY, cv.contentSize.height - cv.bounds.height + inset.bottom)
        let clamped = min(maxOffsetY, max(minOffsetY, targetOffsetY))
        if abs(cv.contentOffset.y - clamped) > 0.5 {
            cv.setContentOffset(CGPoint(x: cv.contentOffset.x, y: clamped), animated: false)
        }
    }

    // MARK: - Cell helpers

    /// Streaming text to attach to a given turn item. Only the LAST
    /// in-progress block carries streaming content; everything else
    /// gets nil.
    private func streamingForItem(_ item: TurnItem) -> String? {
        guard let streamingText, !streamingText.isEmpty else { return nil }
        // Identify the in-progress block by its synthetic id ("streaming")
        // OR by being a block with no finalMessage (the only one of
        // these in a well-formed grouping is the latest).
        guard case .block(let block) = item else { return nil }
        if block.id == "streaming" { return streamingText }
        if block.finalMessage == nil { return streamingText }
        return nil
    }

    /// SwiftUI `Binding` for a turn's expanded state. Routes
    /// reads/writes through `expandedTurnIds` + `onExpandedTurnsChange`
    /// so the SwiftUI shell remains the source of truth.
    private func binding(forTurnId turnId: String) -> Binding<Bool> {
        Binding(
            get: { [weak self] in
                self?.expandedTurnIds.contains(turnId) ?? false
            },
            set: { [weak self] newValue in
                guard let self else { return }
                var next = self.expandedTurnIds
                if newValue { next.insert(turnId) } else { next.remove(turnId) }
                self.expandedTurnIds = next
                self.onExpandedTurnsChange?(next)
                // Reconfigure the affected cell so the bubble re-
                // renders its expand/collapse state immediately.
                self.reconfigureVisible()
            }
        )
    }
}

// MARK: - MessageRow

/// SwiftUI view that renders a single `TurnItem` — either a
/// standalone session-lifecycle bubble or a full `ActivityBlock`
/// (opener(s) + thinking history + agent reply). The cell hosts
/// this view via `UIHostingConfiguration`.
///
/// `ActivityBlock.openers` is iterated rather than unwrapped so
/// future queue support — where multiple user messages can land
/// inside one block — renders correctly without further changes.
/// Today the array has 0 entries (non-`.user` initiators) or 1
/// entry (`.user` initiator).
private struct MessageRow: View {
    let item: TurnItem
    /// Active session id — used as the stable seed for hue derivation
    /// in `MessageBubbleView`. Forwarded from the controller so even
    /// synthetic messages with `sessionId == nil` (streaming agent_message,
    /// the fallback synthetic below) tint with the surrounding session.
    let sessionId: String
    let agent: String
    let streamingText: String?
    @Binding var expanded: Bool

    var body: some View {
        switch item {
        case .standalone(let msg):
            MessageBubbleView(
                message: msg,
                sessionId: sessionId,
                agent: agent,
                historyExpanded: .constant(false)
            )

        case .block(let block):
            VStack(spacing: 12) {
                blockHeader(for: block)

                if let final = block.finalMessage, streamingText == nil {
                    // Completed block.
                    MessageBubbleView(
                        message: final,
                        sessionId: sessionId,
                        agent: agent,
                        turnImages: collectTurnImages(block.thinkingMessages),
                        thinkingHistory: block.thinkingMessages,
                        historyExpanded: $expanded
                    )
                } else if !block.thinkingMessages.isEmpty || streamingText != nil {
                    let latestMsg = block.thinkingMessages.last(where: { $0.type == "agent_message" })
                    let hasMessage = latestMsg?.content != nil && latestMsg?.content?.isEmpty == false
                    let hasStreamingContent = (streamingText ?? "").isEmpty == false
                    let hasTools = block.thinkingMessages.contains(where: { $0.type == "tool_start" || $0.type == "tool_complete" })

                    if hasMessage || hasStreamingContent || hasTools {
                        MessageBubbleView(
                            message: latestMsg ?? ChatMessage(
                                type: "agent_message",
                                seq: 0,
                                sessionId: nil,
                                deviceId: nil,
                                timestamp: nil,
                                payload: [:]
                            ),
                            sessionId: sessionId,
                            agent: agent,
                            thinkingHistory: block.thinkingMessages,
                            historyExpanded: $expanded,
                            streamingText: streamingText
                        )
                    }
                }
            }
        }
    }

    /// Renders the block's header — the visual cue at the top of an
    /// activity block that tells the user "why is this block here?".
    /// Today only `.user` produces visible chrome (the user message
    /// bubble); `.agentResumed`, `.systemTriggered`, and `.implicit`
    /// are stubbed pending the rendering work that lands alongside
    /// the new grouper rules that produce them.
    @ViewBuilder
    private func blockHeader(for block: ActivityBlock) -> some View {
        switch block.initiator {
        case .user(let msg):
            MessageBubbleView(
                message: msg,
                sessionId: sessionId,
                agent: agent,
                historyExpanded: .constant(false)
            )
        case .agentResumed, .systemTriggered, .implicit:
            // No header today. When subagent revoke / system-triggered
            // rules start producing these initiators, add a small
            // header pill here (e.g. "↪ Subagent returned",
            // "🔔 OpenClaw reminder") so the user can tell at a
            // glance why the block exists without a user bubble.
            EmptyView()
        }
    }

    /// Mirror of `ChatView.collectTurnImages`. Lifted here so the row
    /// is self-contained.
    private func collectTurnImages(_ thinkingMessages: [ChatMessage]) -> [ImageAttachment] {
        var images: [ImageAttachment] = []
        for m in thinkingMessages {
            guard m.type == "tool_complete", let attachments = m.attachments else { continue }
            for att in attachments where att.type == "image" {
                images.append(att)
            }
        }
        return images
    }
}

// MARK: - Spinner supplementary content

/// Top supplementary content — a small spinner that shows while
/// we're (or could be) fetching older history. The supplementary
/// view's `willDisplay` IS the load trigger (installed on the
/// scroll coordinator in `ChatListViewController.installSpinnerHooks`),
/// so this view's only job is to render the visual.
///
/// Self-sizes to `EmptyView` (zero height) once `reachedTail` is
/// true, so we don't reserve dead space at the top of fully-loaded
/// sessions.
private struct ChatLoadOlderSpinner: View {
    let viewModel: ChatViewModel

    var body: some View {
        Group {
            if viewModel.reachedTail {
                EmptyView()
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
        }
    }
}

/// Bottom supplementary content — spinner shown while a tail
/// backfill is in flight (push-gap recovery or pending range
/// fetch). Hidden otherwise — for a chat sitting at head with no
/// gap, we don't show a permanent spinner at the bottom.
private struct ChatFillTailSpinner: View {
    let viewModel: ChatViewModel

    var body: some View {
        Group {
            if viewModel.isFillingTail {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                EmptyView()
            }
        }
    }
}

// MARK: - SwiftUI bridge

/// UIViewControllerRepresentable that surfaces `ChatListViewController`
/// to a SwiftUI view tree. Owns the lifecycle of the controller and
/// forwards data changes from the view model into it.
struct ChatListView: UIViewControllerRepresentable {
    let sessionId: String
    let viewModel: ChatViewModel
    /// Coordinator owned by the SwiftUI shell. Held as plain `let`
    /// (not @ObservedObject) — this representable doesn't render
    /// based on coordinator changes; subscribers in the SwiftUI
    /// shell (the jump-to-latest overlay, etc.) observe it directly.
    let coordinator: ChatScrollCoordinator
    @Binding var expandedTurns: Set<String>
    let agentName: String
    let streamingText: String?
    /// One-shot entry-scroll target. Set by the SwiftUI shell on
    /// session entry — non-nil for unread sessions (the TurnItem id
    /// containing the first unread user message), nil for read
    /// sessions (scroll to bottom). The controller consumes this on
    /// its first non-empty apply; subsequent changes are ignored.
    let entryScrollTargetId: String?
    /// Active idle-anchor target. Non-nil when the session is idle
    /// and there's a `lastUserMessage` we want to hold at a fixed
    /// screen Y across subsequent applies (tool entries, image
    /// decodes, expand/collapse). Nil otherwise — controller clears
    /// any held anchor on the next update.
    let idleAnchorTargetId: String?
    /// Turns to render. Sourced from `viewModel.cachedRawTurns`;
    /// UICollectionView handles all virtualisation, so no windowing
    /// is applied here.
    let turns: [TurnItem]
    /// Bottom inset (points) to apply to the collection view's
    /// `contentInset.bottom` so the last cell isn't covered by the
    /// floating input capsule. Measured from the SwiftUI shell via
    /// `onGeometryChange` on the input area. Pure `contentInset` —
    /// independent of safe area — so it survives the
    /// `.ignoresSafeArea(.container, edges: .bottom)` applied at
    /// the SwiftUI layer.
    let bottomContentInset: CGFloat

    func makeUIViewController(context: Context) -> ChatListViewController {
        KLog.chat("🎬 [3/render] ChatListView.makeUIViewController session=\(sessionId.prefix(12)) turns=\(turns.count) entryTarget=\(entryScrollTargetId ?? "nil")")
        let vc = ChatListViewController(
            sessionId: sessionId,
            viewModel: viewModel,
            scrollCoordinator: coordinator
        )
        vc.agentName = agentName
        vc.expandedTurnIds = expandedTurns
        vc.streamingText = streamingText
        vc.entryScrollTargetId = entryScrollTargetId
        vc.bottomContentInset = bottomContentInset
        vc.onExpandedTurnsChange = { newSet in
            // Hop back to the SwiftUI binding via the main actor.
            Task { @MainActor in
                expandedTurns = newSet
            }
        }
        vc.apply(turns: turns)
        // Idle anchor must be set AFTER apply so the snapshot lookup
        // can succeed for the captured cell on a session that opens
        // already-idle.
        vc.updateIdleAnchorTarget(idleAnchorTargetId)
        return vc
    }

    func updateUIViewController(_ vc: ChatListViewController, context: Context) {
        var contentChanged = false

        // Forward expandedTurns from binding → controller. The
        // controller is the source of truth for cells; the binding
        // mirrors it.
        if vc.expandedTurnIds != expandedTurns {
            vc.expandedTurnIds = expandedTurns
            contentChanged = true
        }

        if vc.agentName != agentName {
            vc.agentName = agentName
            contentChanged = true
        }

        if vc.streamingText != streamingText {
            vc.streamingText = streamingText
            contentChanged = true
        }

        // Keep the target id forwarded — the controller's one-shot
        // guard means a late-arriving update can't re-trigger the
        // scroll, but a first apply that races with the binding
        // settling could otherwise see a stale nil.
        vc.entryScrollTargetId = entryScrollTargetId

        // Bottom input height changes as the composer grows (multi-
        // line text, permission row appearing, etc.) — push through
        // every update; the controller's didSet diffs against the
        // current value so a stable height is a no-op.
        vc.bottomContentInset = bottomContentInset

        // Snapshot diff — applies in O(diff) when ids match. Even
        // for streaming text changes, the same Item id is reused so
        // the snapshot diff is empty; reconfigure handles cell content.
        vc.apply(turns: turns)
        if contentChanged {
            vc.reconfigureVisible()
        }
        // Forward idle-anchor target last — `apply` may have just
        // rebuilt the snapshot, and `updateIdleAnchorTarget`
        // depends on `dataSource.snapshot()` to find the cell.
        //
        // Deferred to the next runloop tick: `updateIdleAnchorTarget`
        // ultimately calls `scrollCoordinator.setIdleAnchor` /
        // `clearIdleAnchor`, which mutate `@Published` properties
        // observed by `ChatView` via `@StateObject`. Doing that
        // synchronously here would publish during SwiftUI's view
        // update phase, producing the "Publishing changes from
        // within view updates is not allowed" warning and a cascade
        // of redundant re-renders that visibly stutter chat entry.
        // `updateIdleAnchorTarget` itself is idempotent for an
        // unchanged target id, so a one-frame delay is invisible and
        // doesn't risk anchor drift.
        let targetId = idleAnchorTargetId
        DispatchQueue.main.async { [weak vc] in
            vc?.updateIdleAnchorTarget(targetId)
        }
    }
}
#endif
