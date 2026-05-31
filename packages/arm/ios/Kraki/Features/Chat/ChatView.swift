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

    /// Read-seq boundary captured on session entry. Non-nil only if
    /// the session was UNREAD at entry — in that case it equals the
    /// session's `readSeq` at the moment we opened the chat, so the
    /// entry-scroll logic can find the first user message past it.
    /// Nil for read sessions; the entry scroll then defaults to
    /// landing at the bottom.
    ///
    /// Captured in `.task(id: sessionId)` from the
    /// `entryUnreadSnapshots` mechanism in SessionStore, which is
    /// populated synchronously by SessionDetailView's onAppear
    /// BEFORE markRead clears `readSeq` to `lastSeq`. Reading
    /// `readSeq` directly here would race against markRead.
    @State private var entryUnreadSeqBoundary: Int? = nil

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
            // Capture-and-clear the unread snapshot SessionDetailView
            // stashed for us before its markRead Task fired. If no
            // snapshot was left we fall back to the live readSeq
            // comparison — same answer for sessions opened outside
            // SessionDetailView's flow (e.g. deep link).
            let session = appState.sessionStore.sessions[sessionId]
            let snapshot = appState.sessionStore.entryUnreadSnapshots[sessionId]
            appState.sessionStore.entryUnreadSnapshots.removeValue(forKey: sessionId)
            let wasUnread = snapshot ?? ((session?.lastSeq ?? 0) > (session?.readSeq ?? 0))
            entryUnreadSeqBoundary = wasUnread ? (session?.readSeq ?? 0) : nil

            refreshGroupingCache()
            // Install the load-older handler on the coordinator.
            // sessionId is captured by value (pinnedSessionId) so a
            // stale in-flight closure can't dispatch a fetch for the
            // previous session if the user has since switched.
            let pinnedSessionId = sessionId
            uikitScrollCoordinator.onNearTopReached = { [weak appState = appState] in
                guard let appState else { return }
                // windowTopSeq returns the seq of the topmost loaded
                // message — that's the boundary we want to fetch
                // older than. nil ⇒ window not yet loaded; nothing
                // to do.
                guard let firstSeq = appState.messageProvider?.windowTopSeq(pinnedSessionId),
                      firstSeq > 1 else { return }
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

    /// TurnItem id for the entry-scroll target — the first block
    /// whose user opener arrived AFTER the captured `readSeq`
    /// boundary. Nil for read sessions (entry scroll falls back to
    /// the bottom) or when the unread tail wasn't grouped into a
    /// block yet (the controller likewise falls back to the bottom).
    ///
    /// Recomputed on each body evaluation — the controller's
    /// one-shot guard means a transient nil/non-nil flip before the
    /// first apply lands has no behavioural cost.
    private var entryScrollTargetId: String? {
        guard let boundary = entryUnreadSeqBoundary,
              let viewModel else { return nil }
        for item in viewModel.cachedRawTurns {
            if case .block(let block) = item,
               let userMsg = block.initiator.userMessage,
               userMsg.seq > boundary {
                return item.id
            }
        }
        return nil
    }

    /// TurnItem id for the idle anchor target — the block containing
    /// the most recent user message. Non-nil only while the session
    /// is idle; the controller releases the anchor whenever this
    /// goes back to nil. Stage 6 semantics: hold the visible user
    /// bubble at a fixed screen Y while tool entries or expand/
    /// collapse mutate other parts of the list during the quiet
    /// period between blocks.
    private var idleAnchorTargetId: String? {
        guard let vm = viewModel,
              vm.sessionIdle,
              let lastUserMsg = vm.lastUserMessage else { return nil }
        for item in vm.cachedRawTurns {
            if case .block(let block) = item,
               block.initiator.userMessage?.id == lastUserMsg.id {
                return item.id
            }
        }
        return nil
    }

    // MARK: - UIKit Messages

    /// UIKit-backed message list. Renders `viewModel.displayTurns`
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
                entryScrollTargetId: entryScrollTargetId,
                idleAnchorTargetId: idleAnchorTargetId,
                turns: viewModel.displayTurns
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
