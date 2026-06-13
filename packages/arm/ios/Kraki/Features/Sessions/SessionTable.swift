#if os(iOS)
/// SessionTable — UIKit-backed list of sessions for smooth row-move animations.
///
/// SwiftUI's `List` doesn't smoothly animate `ForEach` reorders; rows fade-out
/// and re-insert. This wraps a `UITableView` with `UITableViewDiffableDataSource`
/// for native UIKit move animations (matches Apple Mail/Messages).
///
/// Cells render SwiftUI content via `UIHostingConfiguration`, so we keep using
/// our existing `SessionCardView` and `AgentAvatar` SwiftUI components.
///
/// Press highlight, separators, and swipe gestures are all native UIKit.

import SwiftUI
import UIKit
import Observation

// MARK: - SwiftUI bridge

struct SessionTable: UIViewControllerRepresentable, Equatable {
    let appState: AppState
    let deviceFilter: String?  // nil = all devices
    let onCellTapped: (String) -> Void

    /// SwiftUI re-creates this struct on every parent body re-eval
    /// (e.g. SessionStore @Published mutations bubble up through
    /// SessionListView even when the user has pushed into ChatView).
    /// Closures never compare equal, so we deliberately exclude
    /// `onCellTapped` from equality — its body is functionally
    /// stable ("append tapped sessionId to the nav path") even when
    /// the closure identity differs. Combined with `.equatable()`
    /// modifier at the callsite, this skips ~90% of the spurious
    /// `updateUIViewController` calls.
    static func == (lhs: SessionTable, rhs: SessionTable) -> Bool {
        lhs.appState === rhs.appState && lhs.deviceFilter == rhs.deviceFilter
    }

    func makeUIViewController(context: Context) -> SessionTableController {
        let vc = SessionTableController()
        vc.appState = appState
        vc.deviceFilter = deviceFilter
        vc.onCellTapped = onCellTapped
        return vc
    }

    func updateUIViewController(_ vc: SessionTableController, context: Context) {
        vc.appState = appState
        vc.deviceFilter = deviceFilter
        vc.onCellTapped = onCellTapped
        KLog.chat("📂 [snapshot] SessionTable.updateUIViewController → applySnapshot")
        vc.applySnapshot(animated: true)
    }
}

// MARK: - Controller

final class SessionTableController: UIViewController, UITableViewDelegate {
    weak var appState: AppState?
    var deviceFilter: String?
    var onCellTapped: ((String) -> Void)?

    private var tableView: UITableView!
    private var dataSource: UITableViewDiffableDataSource<Int, String>!
    private var didApplyInitialSnapshot = false
    /// Set to `true` when `applySnapshot` is invoked while the table
    /// is off-screen (e.g. SwiftUI still drives the wrapping
    /// `UIViewControllerRepresentable` while the user has pushed
    /// into a chat detail). Re-applied on `viewWillAppear` so the
    /// list catches up to whatever the store moved to in the
    /// meantime, without forcing layout on a detached view (which
    /// fires the "UITableView was told to layout its visible cells
    /// ... without being in the view hierarchy" runtime warning and
    /// wastes CPU on cells that are about to be re-laid-out anyway
    /// when the user returns).
    private var needsApplyOnAppear = false
    /// Fingerprint per session id (state that affects the cell
    /// rendering: pinned, lastSeq, readSeq, title hash). Used to
    /// decide which cells genuinely need a reconfigure so we don't
    /// reconfigure all 100+ cells on every websocket event.
    private var sessionFingerprints: [String: Int] = [:]
    /// Last id-order applied to the data source. Used to early-out
    /// when SwiftUI calls `updateUIViewController` (which it does
    /// frequently, because the closure prop captured by the
    /// representable struct is never `==` to itself across body
    /// re-evaluations) but neither the row set nor any cell content
    /// has actually changed.
    private var lastAppliedIds: [String] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        setupTableView()
        setupDataSource()
        // Apply initial snapshot synchronously so the table is never
        // visually empty between viewDidLoad and the first SwiftUI
        // updateUIViewController call. Without this, on cold launch
        // the user sees the (dark) table background but no rows for
        // ~2s — the time it takes for some downstream observable
        // change (typically WS connection state) to make SwiftUI
        // re-evaluate and re-apply.
        applySnapshot(animated: false)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Re-apply any snapshot we dropped while detached. Animation
        // is suppressed because the user just got here — we want the
        // table to already be settled by the time the push transition
        // completes, not animate moves underfoot.
        if needsApplyOnAppear {
            needsApplyOnAppear = false
            applySnapshot(animated: false)
        }
    }

    private func setupTableView() {
        tableView = UITableView(frame: view.bounds, style: .plain)
        tableView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tableView.backgroundColor = UIColor(Color.surfacePrimary)
        tableView.separatorStyle = .none
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "session")
        view.addSubview(tableView)
        view.backgroundColor = UIColor(Color.surfacePrimary)
    }

    private func setupDataSource() {
        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] tableView, indexPath, sessionId in
            guard let self, let appState = self.appState else {
                return UITableViewCell()
            }
            let cell = tableView.dequeueReusableCell(withIdentifier: "session", for: indexPath)
            let snapshot = self.dataSource.snapshot()
            let total = snapshot.numberOfItems(inSection: 0)
            let isLast = indexPath.row == total - 1
            cell.contentConfiguration = UIHostingConfiguration {
                // Pass only the sessionId so the SwiftUI subtree
                // re-fetches the current SessionInfo from the
                // observable store on every render. Capturing the
                // SessionInfo struct here would freeze it at cell
                // configuration time and miss in-place updates from
                // the store (e.g. unread / readSeq mutations).
                SessionRowContent(sessionId: sessionId, isLast: isLast)
                    .environment(appState)
            }
            .margins(.all, 0)
            cell.backgroundColor = UIColor(Color.surfacePrimary)
            cell.selectedBackgroundView = {
                let v = UIView()
                v.backgroundColor = UIColor.systemGray4.withAlphaComponent(0.6)
                return v
            }()
            return cell
        }
    }

    func applySnapshot(animated: Bool) {
        guard isViewLoaded, let appState else {
            return
        }
        // Skip while loaded but detached from the window AFTER the
        // first apply (e.g. user pushed into a chat detail). Diffable
        // data sources force a layout pass on apply, and UIKit
        // complains (and wastes work) if the table is detached. Stash
        // a "dirty" flag so `viewWillAppear` re-runs with current
        // store state when the user returns.
        //
        // The FIRST apply is exempt from this guard: at viewDidLoad
        // (and even viewWillAppear) the view is not yet attached to a
        // window, but we *must* populate the data source then or the
        // user sees an empty table until some downstream observable
        // change triggers SwiftUI to re-evaluate and re-apply (which
        // on cold launch can take 2+ seconds).
        if didApplyInitialSnapshot && view.window == nil {
            needsApplyOnAppear = true
            return
        }
        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        let allSessions = appState.sessionStore.sortedSessions
        let filtered: [SessionInfo]
        if let deviceFilter {
            filtered = allSessions.filter { $0.deviceId == deviceFilter }
        } else {
            filtered = allSessions
        }
        let ids = filtered.map(\.id)
        snapshot.appendItems(ids)

        // Reconfigure only cells whose underlying SessionInfo changed
        // since the previous apply. With 100+ sessions, reconfiguring
        // every cell on every WS event causes visible jank; this
        // narrows it to just the rows that actually need new content.
        var changedIds: [String] = []
        changedIds.reserveCapacity(filtered.count / 4)
        var nextFingerprints: [String: Int] = [:]
        nextFingerprints.reserveCapacity(filtered.count)
        for session in filtered {
            let fp = Self.fingerprint(for: session, store: appState.sessionStore)
            nextFingerprints[session.id] = fp
            if sessionFingerprints[session.id] != fp {
                changedIds.append(session.id)
            }
        }
        sessionFingerprints = nextFingerprints

        // Early-out if nothing visible changed. SwiftUI calls
        // `updateUIViewController` on every body re-evaluation (and
        // the closure prop captured by the representable struct
        // forces SwiftUI to consider props "changed" on every
        // re-eval), but the underlying store state usually hasn't
        // moved. Skipping the no-op `dataSource.apply` here saves
        // both diff work and an avoidable layout pass — without
        // changing what the user sees.
        if didApplyInitialSnapshot && changedIds.isEmpty && ids == lastAppliedIds {
            return
        }

        if !changedIds.isEmpty {
            snapshot.reconfigureItems(changedIds)
        }

        // First snapshot is non-animated; subsequent ones animate moves.
        let shouldAnimate = animated && didApplyInitialSnapshot
        dataSource.apply(snapshot, animatingDifferences: shouldAnimate)
        lastAppliedIds = ids
        KLog.chat("📂 [snapshot] SessionTable.applySnapshot APPLIED: rows=\(ids.count) reconfigured=\(changedIds.count) animated=\(shouldAnimate) initial=\(!didApplyInitialSnapshot) inWindow=\(view.window != nil)")
        didApplyInitialSnapshot = true
    }

    /// Hash of every SessionInfo property that affects how the cell
    /// renders. If two snapshots produce the same fingerprint, the
    /// cell content can't have visibly changed and there's no need
    /// to reconfigure.
    private static func fingerprint(for session: SessionInfo, store: SessionStore) -> Int {
        var hasher = Hasher()
        hasher.combine(session.id)
        hasher.combine(session.pinned)
        hasher.combine(session.lastSeq)
        hasher.combine(session.readSeq)
        hasher.combine(session.displayTitle)
        hasher.combine(session.state)
        // Preview text + timestamp are the main "live" surface
        // — include them so unread/reply previews re-render.
        if let preview = store.sessionPreviews[session.id] {
            hasher.combine(preview.text)
            hasher.combine(preview.timestamp)
        }
        return hasher.finalize()
    }

    // MARK: - UITableViewDelegate

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        if let id = dataSource.itemIdentifier(for: indexPath) {
            onCellTapped?(id)
        }
    }

    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let appState,
              let sessionId = dataSource.itemIdentifier(for: indexPath),
              let session = appState.sessionStore.sessions[sessionId] else { return nil }

        // Order in array = right to left visually. Visual: Pin | Fork | Unread

        // Unread (rightmost — closest to swipe edge). Seq-derived.
        let isUnread = appState.sessionStore.isUnread(sessionId)
        let unreadAction = UIContextualAction(style: .normal, title: isUnread ? "Read" : "Unread") { _, _, completion in
            if isUnread {
                // Optimistically clear locally — the server's
                // `session_read` echo will reconcile via monotonic max.
                appState.sessionStore.markRead(sessionId, seq: session.lastSeq)
                appState.commandSender?.markRead(sessionId: sessionId, seq: session.lastSeq)
            } else {
                appState.commandSender?.markUnread(sessionId: sessionId)
            }
            completion(true)
        }
        unreadAction.image = renderLucideIconForSwipe(isUnread ? .bellOff : .bellRing)
        unreadAction.backgroundColor = UIColor(red: 0x6B/255.0, green: 0x7D/255.0, blue: 0x94/255.0, alpha: 1) // soft slate

        // Fork (middle)
        let forkAction = UIContextualAction(style: .normal, title: "Fork") { _, _, completion in
            appState.commandSender?.forkSession(sessionId: sessionId)
            completion(true)
        }
        forkAction.image = renderLucideIconForSwipe(.gitFork)
        forkAction.backgroundColor = UIColor(red: 0xC0/255.0, green: 0x8A/255.0, blue: 0x2F/255.0, alpha: 1) // warm amber

        // Pin (leftmost)
        let pinned = session.pinned
        let pinAction = UIContextualAction(style: .normal, title: pinned ? "Unpin" : "Pin") { _, _, completion in
            appState.commandSender?.pinSession(sessionId: sessionId, pinned: !pinned)
            completion(true)
        }
        pinAction.image = renderLucideIconForSwipe(pinned ? .pinOff : .pin)
        pinAction.backgroundColor = UIColor(red: 0x2F/255.0, green: 0x9C/255.0, blue: 0x8B/255.0, alpha: 1) // muted teal

        let config = UISwipeActionsConfiguration(actions: [unreadAction, forkAction, pinAction])
        config.performsFirstActionWithFullSwipe = false
        return config
    }
}

// MARK: - Cell content (SwiftUI inside UIHostingConfiguration)

struct SessionRowContent: View {
    @Environment(AppState.self) private var appState
    let sessionId: String
    let isLast: Bool

    var body: some View {
        VStack(spacing: 0) {
            SessionCardView(sessionId: sessionId)
                .padding(.vertical, 6)
                .padding(.leading, 8)
                .padding(.trailing, 16)

            if !isLast {
                Color.borderPrimary
                    .frame(height: 1.0 / UIScreen.main.scale)
                    .padding(.leading, 64) // leading(8) + avatar(44) + gap(12)
            }
        }
    }
}

// MARK: - Lucide icon → UIImage for swipe actions

@MainActor
private func renderLucideIconForSwipe(_ type: LucideIconType, size: CGFloat = 22) -> UIImage? {
    let view = LucideIcon(type, size: size, strokeWidth: 2, color: .white)
    let renderer = ImageRenderer(content: view)
    renderer.scale = UIScreen.main.scale
    return renderer.uiImage?.withRenderingMode(.alwaysTemplate)
}

#endif
