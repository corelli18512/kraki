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
    @Environment(\.colorScheme) private var colorScheme

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

    /// Measured height of the floating input capsule (incl. its own
    /// vertical padding and any pending-permission row). Drives the
    /// collection view's `contentInset.bottom` so the last cell sits
    /// above the capsule instead of behind it. We use
    /// `onGeometryChange` on the `safeAreaInset` content, NOT a
    /// fixed `safeAreaInset` height, because the surrounding
    /// `.ignoresSafeArea(.container, edges: .bottom)` swallows the
    /// safe-area path; routing via `contentInset` instead bypasses
    /// that entirely.
    @State private var bottomInputHeight: CGFloat = 0

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
                    // Let the chat collection view extend behind BOTH
                    // the top navbar and the bottom input area so
                    // message cells visibly blur THROUGH the navbar's
                    // glass band and the input's glass capsule.
                    // UIScrollView's automatic content-inset
                    // adjustment still reads the safe areas (the navbar
                    // contributes a top inset via setContentScrollView,
                    // the safeAreaInset below adds a bottom inset), so
                    // the first / last cell aren't hidden under the
                    // chrome — they just scroll under when the user
                    // pushes the list.
                    .ignoresSafeArea(.container, edges: [.top, .bottom])
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
                                // Measure the rendered height so we
                                // can mirror it into the collection
                                // view's contentInset.bottom (next
                                // update). Updates whenever the
                                // capsule grows (multi-line text,
                                // pending permission row, etc.).
                                .onGeometryChange(for: CGFloat.self) { proxy in
                                    proxy.size.height
                                } action: { newHeight in
                                    if abs(newHeight - bottomInputHeight) > 0.5 {
                                        bottomInputHeight = newHeight
                                    }
                                }
                        }
                    }
            }
        }
        // Page background: the bottom-most fill behind the chat list
        // AND behind both glass strips (top nav + bottom input). Glass
        // material is a *blur* — without an underlying color it just
        // shows through to the window's default white, so the navbar
        // and input capsule look like they have no chrome at all.
        // Painting `surfacePrimary` here restores the soft surface
        // that the glass strips visibly tint and blur.
        .background(Color.surfacePrimary)
        // iOS 26's default navbar is fully transparent at the scroll-
        // edge; the wrapping UICollectionView buries the scroll view
        // from auto-detect, so the system can't switch to the
        // materialised state on scroll either. Force the navbar to
        // always render its glass material so the chat cells blur
        // underneath instead of revealing RootView's solid bg.
        .toolbarBackground(.visible, for: .navigationBar)
        .task(id: sessionId) {
            KLog.chat("🎬 [3/render] ChatView.task started session=\(sessionId.prefix(12))")
            // (Re)bind the view model on session entry / switch. New
            // session ⇒ new instance so the cached groupings don't
            // bleed across sessions.
            if viewModel == nil || viewModel?.sessionId != sessionId {
                viewModel = ChatViewModel(sessionId: sessionId, appState: appState)
                KLog.chat("🎬 [3/render] ChatView.task viewModel created session=\(sessionId.prefix(12)) filteredCount=\(viewModel?.filteredMessages.count ?? -1)")
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
            // Top/bottom load triggers are now driven by supplementary
            // spinner visibility inside the UICollectionView (see
            // `ChatListViewController.installSpinnerHooks`). The old
            // scroll-math `onNearTopReached` path was removed once
            // the sentinel cells took over — spinner visibility IS
            // the load trigger, single source of truth.
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
    ///
    /// Scanned in REVERSE: the common case is a long read history
    /// followed by a short unread tail, so walking from the tail
    /// inward and stopping at the boundary touches only the unread
    /// region. We keep the most-recently-seen "> boundary" block as
    /// a candidate; once we cross back into seq ≤ boundary the
    /// candidate is by construction the EARLIEST unread block.
    private var entryScrollTargetId: String? {
        guard let boundary = entryUnreadSeqBoundary,
              let viewModel else { return nil }
        var candidate: String? = nil
        for item in viewModel.cachedRawTurns.reversed() {
            guard case .block(let block) = item,
                  let userMsg = block.initiator.userMessage else { continue }
            if userMsg.seq > boundary {
                candidate = item.id
            } else {
                // Crossed back into already-read history — candidate
                // (if any) is the earliest unread block.
                return candidate
            }
        }
        // Entire window is unread (rare but legal — e.g. a fresh
        // session opened before any read marker landed).
        return candidate
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
                turns: viewModel.displayTurns,
                bottomContentInset: bottomInputHeight
            )
        } else {
            Color.clear
        }
    }

    /// Floating jump-to-latest pill (bottom-trailing). Visible only
    /// when the user has scrolled away from the bottom; tapping snaps
    /// to the last cell. Flat liquid-glass capsule tinted by the
    /// current session's agent hue so it sits quietly above the chat
    /// without the heavy saturated disc the previous version used.
    @ViewBuilder
    private var uikitJumpToLatestButton: some View {
        if !uikitScrollCoordinator.isAtBottom {
            Button {
                uikitScrollCoordinator.scrollToBottom(animated: true)
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(agentTintColor)
                    .frame(width: 52, height: 30)
                    .background {
                        ZStack {
                            if #available(iOS 26.0, *) {
                                Color.clear
                                    .glassEffect(.regular, in: Capsule())
                            } else {
                                Capsule().fill(.ultraThinMaterial)
                            }
                            Capsule()
                                .fill(agentTintColor.opacity(colorScheme == .dark ? 0.22 : 0.16))
                            Capsule()
                                .strokeBorder(agentTintColor.opacity(0.25), lineWidth: 0.5)
                        }
                    }
                    .shadow(color: .black.opacity(colorScheme == .dark ? 0.25 : 0.08), radius: 4, y: 2)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16)
            .padding(.bottom, 12)
            .transition(.scale.combined(with: .opacity))
        }
    }

    /// Agent-derived accent for the jump-to-latest pill. Mirrors
    /// `MessageBubbleView.agentAccentColor` so the chevron / tint
    /// match the message bubble accent for the same session.
    private var agentTintColor: Color {
        let hue = stringToHue(sessionId) / 360
        let (h, s, b) = hslToHSB(
            h: hue,
            s: colorScheme == .dark ? 0.75 : 0.70,
            l: colorScheme == .dark ? 0.65 : 0.45
        )
        return Color(hue: h, saturation: s, brightness: b)
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
        // Pure floating liquid-glass capsule. The capsule itself owns
        // its glass background (see `inputBoxGlassBackground` in
        // MessageInputView); we deliberately do NOT add a band of
        // material under the home-indicator strip — the chat
        // collection view scrolls behind the input so messages blur
        // through the capsule and the home-indicator area shows the
        // underlying content directly, matching the web composer.
        MessageInputView(
            sessionId: sessionId,
            pendingPermission: permissions.first,
            pendingQuestion: permissions.isEmpty ? questions.first : nil
        )
    }
}
#endif
