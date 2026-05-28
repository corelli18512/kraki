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

    /// Closure invoked when the user toggles a turn's expanded
    /// state. The SwiftUI shell owns the source of truth; this
    /// bubbles the event up.
    var onExpandedTurnsChange: ((Set<String>) -> Void)?

    // MARK: - UI

    private(set) var collectionView: UICollectionView!
    private var dataSource: UICollectionViewDiffableDataSource<Section, Item>!

    /// Pending turns to apply once `viewDidLoad` runs. SwiftUI's
    /// `makeUIViewController` calls `apply(turns:)` before UIKit
    /// has loaded the view, so we stash and replay.
    private var pendingTurns: [TurnItem]?

    /// Scroll coordinator that owns this controller's UICollectionView
    /// delegate callbacks and republishes derived state (isAtBottom,
    /// growMode, etc.) for SwiftUI overlays. Held strongly because
    /// the @StateObject lifetime in the SwiftUI shell binds to the
    /// view, not the controller, and we want the controller to keep
    /// its delegate alive across reattach cycles.
    private let scrollCoordinator: ChatScrollCoordinator

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
        if let pending = pendingTurns {
            pendingTurns = nil
            apply(turns: pending)
        }
    }

    // MARK: - Setup

    private func configureCollectionView() {
        // List-style compositional layout: each item is a horizontal
        // row spanning the available width, with self-sizing height
        // estimated by the host content. This is the closest UIKit
        // equivalent to a `VStack(spacing: 0)` of full-width cells.
        var listConfig = UICollectionLayoutListConfiguration(appearance: .plain)
        listConfig.showsSeparators = false
        listConfig.backgroundColor = .clear
        let layout = UICollectionViewCompositionalLayout.list(using: listConfig)

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
            return
        }
        // Rebuild the id → TurnItem map. Cell configuration uses
        // this; without it, dequeuing a cell after a reorder would
        // hand the cell a stale value.
        var newMap: [String: TurnItem] = [:]
        for item in turns {
            newMap[item.id] = item
        }
        itemsById = newMap

        var snapshot = NSDiffableDataSourceSnapshot<Section, Item>()
        snapshot.appendSections([.messages])
        snapshot.appendItems(turns.map { Item(id: $0.id) }, toSection: .messages)
        dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
            // After the diff settles the content size may have grown
            // (e.g. very first apply, or a new turn arriving while
            // the user is reading old history). Resync the
            // coordinator's `isAtBottom` so overlays don't lag
            // behind reality — `scrollViewDidScroll` only fires when
            // the offset actually changes.
            self?.scrollCoordinator.recomputeIsAtBottom()
        }
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

    // MARK: - Cell helpers

    /// Streaming text to attach to a given turn item. Only the LAST
    /// in-progress turn carries streaming content; everything else
    /// gets nil.
    private func streamingForItem(_ item: TurnItem) -> String? {
        guard let streamingText, !streamingText.isEmpty else { return nil }
        // Identify the in-progress turn by its synthetic id ("streaming")
        // OR by being a turn with no finalMessage (the only one of
        // these in a well-formed grouping is the latest).
        guard case .turn(let turn) = item else { return nil }
        if turn.id == "streaming" { return streamingText }
        if turn.finalMessage == nil { return streamingText }
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

/// SwiftUI view that renders a single turn item — either a standalone
/// message or a full turn (user bubble + agent reply bubble). This is
/// the same rendering logic that `ChatView.ForEach(grouped)` ran for
/// each row; lifted out so the UIKit cell can host it.
private struct MessageRow: View {
    let item: TurnItem
    let agent: String
    let streamingText: String?
    @Binding var expanded: Bool

    var body: some View {
        switch item {
        case .standalone(let msg):
            MessageBubbleView(
                message: msg,
                agent: agent,
                historyExpanded: .constant(false)
            )

        case .turn(let turn):
            VStack(spacing: 12) {
                if let userMsg = turn.userMessage {
                    MessageBubbleView(
                        message: userMsg,
                        agent: agent,
                        historyExpanded: .constant(false)
                    )
                }

                if let final = turn.finalMessage, streamingText == nil {
                    // Completed turn.
                    MessageBubbleView(
                        message: final,
                        agent: agent,
                        turnImages: collectTurnImages(turn.thinkingMessages),
                        thinkingHistory: turn.thinkingMessages,
                        historyExpanded: $expanded
                    )
                } else if !turn.thinkingMessages.isEmpty || streamingText != nil {
                    let latestMsg = turn.thinkingMessages.last(where: { $0.type == "agent_message" })
                    let hasMessage = latestMsg?.content != nil && latestMsg?.content?.isEmpty == false
                    let hasStreamingContent = (streamingText ?? "").isEmpty == false
                    let hasTools = turn.thinkingMessages.contains(where: { $0.type == "tool_start" || $0.type == "tool_complete" })

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
                            agent: agent,
                            thinkingHistory: turn.thinkingMessages,
                            historyExpanded: $expanded,
                            streamingText: streamingText
                        )
                    }
                }
            }
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
    /// Turns to render. The SwiftUI shell computes this from the
    /// view model's `cachedRawTurns` (Stage 1 still routes through
    /// the old window-aware `grouped` accessor; Stages 3-4 drop the
    /// windowing and pass all turns directly).
    let turns: [TurnItem]

    func makeUIViewController(context: Context) -> ChatListViewController {
        let vc = ChatListViewController(
            sessionId: sessionId,
            viewModel: viewModel,
            scrollCoordinator: coordinator
        )
        vc.agentName = agentName
        vc.expandedTurnIds = expandedTurns
        vc.streamingText = streamingText
        vc.onExpandedTurnsChange = { newSet in
            // Hop back to the SwiftUI binding via the main actor.
            Task { @MainActor in
                expandedTurns = newSet
            }
        }
        vc.apply(turns: turns)
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

        // Snapshot diff — applies in O(diff) when ids match. Even
        // for streaming text changes, the same Item id is reused so
        // the snapshot diff is empty; reconfigure handles cell content.
        vc.apply(turns: turns)
        if contentChanged {
            vc.reconfigureVisible()
        }
    }
}
#endif
