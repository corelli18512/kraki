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

struct SessionTable: UIViewControllerRepresentable {
    let appState: AppState
    let deviceFilter: String?  // nil = all devices
    let onCellTapped: (String) -> Void

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

    override func viewDidLoad() {
        super.viewDidLoad()
        setupTableView()
        setupDataSource()
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
            guard let self, let appState = self.appState,
                  let session = appState.sessionStore.sessions[sessionId] else {
                return UITableViewCell()
            }
            let cell = tableView.dequeueReusableCell(withIdentifier: "session", for: indexPath)
            let snapshot = self.dataSource.snapshot()
            let total = snapshot.numberOfItems(inSection: 0)
            let isLast = indexPath.row == total - 1
            cell.contentConfiguration = UIHostingConfiguration {
                SessionRowContent(session: session, isLast: isLast)
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
        guard isViewLoaded, let appState else { return }
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

        // Reconfigure all items so cells re-render their SwiftUI content
        // (UIHostingConfiguration captures session state at config-creation
        // time; without reconfiguring, pin badge & other props won't update
        // when the underlying SessionInfo changes but the order does not).
        snapshot.reconfigureItems(ids)

        // First snapshot is non-animated; subsequent ones animate moves.
        let shouldAnimate = animated && didApplyInitialSnapshot
        dataSource.apply(snapshot, animatingDifferences: shouldAnimate)
        didApplyInitialSnapshot = true
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

        // Unread (rightmost — closest to swipe edge)
        let isUnread = (appState.sessionStore.unreadCounts[sessionId] ?? 0) > 0
        let unreadAction = UIContextualAction(style: .normal, title: isUnread ? "Read" : "Unread") { _, _, completion in
            if isUnread {
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
    let session: SessionInfo
    let isLast: Bool

    var body: some View {
        VStack(spacing: 0) {
            SessionCardView(session: session)
                .padding(.vertical, 6)
                .padding(.horizontal, 16)

            if !isLast {
                Color.borderPrimary
                    .frame(height: 1.0 / UIScreen.main.scale)
                    .padding(.leading, 62) // leading(16) + avatar(36) + gap(10)
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
