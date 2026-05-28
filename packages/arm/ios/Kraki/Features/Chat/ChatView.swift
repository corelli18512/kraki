#if os(iOS)
/// ChatView — Main chat interface for a session, mirroring ChatView.tsx.
///
/// Renders a UIKit-backed message list (UICollectionView) hosted via
/// `ChatListView`, plus the compose footer and overlays. All scroll
/// state (isAtBottom, growMode, lockedMsgId, idle anchor) lives in
/// `ChatScrollCoordinator`; SwiftUI state here is limited to
/// per-session bookkeeping (expandedTurns, viewModel container).
///
/// The original SwiftUI ScrollView-based path with its render-window
/// virtualisation, sticky-pill overlay, and proxy-driven entry
/// scroll was removed in Stages 4+7 of the UIKit refactor. The
/// UICollectionView in `ChatListViewController` handles cell
/// recycling, the coordinator handles scroll-derived state, and
/// the controller's `viewDidLayoutSubviews` handles entry scroll.

import SwiftUI

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState

    /// Per-cell expand state for thinking history. Cells use the
    /// turn id as the key; the SwiftUI shell holds the source of
    /// truth so it survives controller re-creation.
    @State private var expandedTurns: Set<String> = []

    /// View model that owns the derived state (grouped turns,
    /// streaming snapshot, pending action slices, etc.). Lazily
    /// initialised on first appearance because `appState` isn't
    /// available at `init`-time.
    @State private var viewModel: ChatViewModel?

    /// Scroll coordinator for the UIKit message list. Owns
    /// scroll-derived state (isAtBottom, growMode, lockedMsgId,
    /// idle anchor) and republishes for SwiftUI overlays.
    @StateObject private var uikitScrollCoordinator = ChatScrollCoordinator()

    // MARK: - View-model passthroughs

    private var session: SessionInfo? { viewModel?.session }
    private var streaming: String? { viewModel?.streaming }
    private var isDeviceOnline: Bool { viewModel?.isDeviceOnline ?? false }
    private var permissions: [PendingPermission] { viewModel?.permissions ?? [] }
    private var questions: [PendingQuestion] { viewModel?.questions ?? [] }
    private var showCenterLoading: Bool { viewModel?.showCenterLoading ?? false }
    private var filteredMessagesCount: Int { viewModel?.filteredMessages.count ?? 0 }

    // MARK: - Body

    var body: some View {
        Group {
            if showCenterLoading {
                centerLoadingView
            } else {
                uikitMessages
                    .overlay(alignment: .bottomTrailing) {
                        uikitJumpToLatestButton
                    }
                    .safeAreaInset(edge: .bottom, spacing: 0) {
                        // Show the compose area whenever the tentacle
                        // device is on file as online. We intentionally
                        // do NOT gate on `appState.isFullyOnline` —
                        // relay blips are short, the WS layer queues
                        // outbound frames (200-frame cap, 60s TTL),
                        // and the input itself surfaces a hint when
                        // sending would not be live. Yanking the input
                        // mid-typing on every reconnect would be far
                        // more disruptive than queueing for a few
                        // hundred ms.
                        if isDeviceOnline {
                            bottomInputArea
                        }
                    }
            }
        }
        .background(Color.surfacePrimary)
        .task(id: sessionId) {
            // (Re)bind the view model on session entry / switch. New
            // session ⇒ new instance so the cached groupings don't
            // bleed across sessions.
            if viewModel == nil || viewModel?.sessionId != sessionId {
                viewModel = ChatViewModel(sessionId: sessionId, appState: appState)
            }
            refreshGroupingCache()
            // Install the load-older handler on the coordinator.
            // sessionId is captured by value (pinnedSessionId) so a
            // stale in-flight closure can't dispatch a fetch for the
            // previous session if the user has since switched.
            let pinnedSessionId = sessionId
            uikitScrollCoordinator.onNearTopReached = { [weak appState = appState] in
                guard let appState else { return }
                let messages = appState.messageStore.messages[pinnedSessionId] ?? []
                let firstSeq = messages.compactMap { $0.seq > 0 ? $0.seq : nil }.min() ?? Int.max
                guard firstSeq > 1 else { return }
                _ = appState.messageProvider?.ensureOlderLoaded(
                    sessionId: pinnedSessionId,
                    beforeSeq: firstSeq
                )
            }
        }
        .onChange(of: filteredMessagesCount) { _, _ in
            // New / removed messages → re-group. The view model
            // owns the grouping cache; the UIKit controller picks
            // up the change via the next `turns:` value passed by
            // `uikitMessages`.
            refreshGroupingCache()
        }
        .onChange(of: streaming) { oldVal, newVal in
            // Streaming start/stop transitions add/remove the
            // synthetic in-progress turn from the grouping. Refresh
            // only on start/stop edges — not on every text delta —
            // so a long streaming reply doesn't thrash the cache.
            let was = oldVal != nil
            let now = newVal != nil
            if was != now {
                refreshGroupingCache()
            }
        }
    }

    /// Delegate to the view model. Returns the diff result, which is
    /// currently unused — kept as a hook for future stages that may
    /// want to react to prepends (e.g. anchor adjustments beyond what
    /// the controller's per-apply scroll-anchor logic provides).
    private func refreshGroupingCache() {
        _ = viewModel?.refreshGroupingCache()
    }

    // MARK: - UIKit Messages

    /// UIKit-backed message list. Renders `viewModel.cachedRawTurns`
    /// directly — no windowing — and lets `UICollectionView` handle
    /// cell virtualisation. `coordinator` provides
    /// scroll-derived state (isAtBottom, isNearTop, growMode, idle
    /// anchor) to the SwiftUI overlays and load-older handshake.
    @ViewBuilder
    private var uikitMessages: some View {
        if let viewModel {
            ChatListView(
                sessionId: sessionId,
                viewModel: viewModel,
                coordinator: uikitScrollCoordinator,
                expandedTurns: $expandedTurns,
                agentName: session?.agent ?? "",
                streamingText: streaming,
                turns: viewModel.cachedRawTurns
            )
        } else {
            Color.clear
        }
    }

    /// Floating circular button (bottom-trailing) that jumps to the
    /// latest content. Visible only when the user has scrolled away
    /// from the bottom; tapping snaps to the last cell.
    @ViewBuilder
    private var uikitJumpToLatestButton: some View {
        if !uikitScrollCoordinator.isAtBottom {
            Button {
                uikitScrollCoordinator.scrollToBottom(animated: true)
            } label: {
                Image(systemName: "chevron.down")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.krakiPrimary))
                    .shadow(color: .black.opacity(0.18), radius: 6, y: 2)
            }
            .padding(.trailing, 16)
            .padding(.bottom, 12)
            .transition(.scale.combined(with: .opacity))
        }
    }

    // MARK: - State-A center loading

    /// Centered spinner shown when the session has no cached
    /// messages and a fetch is in flight. Replaces the message list
    /// + compose footer until the first batch lands.
    private var centerLoadingView: some View {
        VStack {
            Spacer()
            ProgressView()
                .controlSize(.large)
                .tint(.krakiPrimary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Bottom Input Area

    @ViewBuilder
    private var bottomInputArea: some View {
        MessageInputView(
            sessionId: sessionId,
            pendingPermission: permissions.first,
            pendingQuestion: permissions.isEmpty ? questions.first : nil
        )
    }
}
#endif
