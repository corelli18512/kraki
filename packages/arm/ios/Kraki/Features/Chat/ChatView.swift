#if os(iOS)
/// Main pure-spine chat surface: landed messages render as one TextKit-backed
/// bubble each; streaming narration and actions live in the ephemeral live card.


import SwiftUI

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState

    /// View model for session/device/live-card observation. The list controller
    /// owns its own flat-spine snapshot and pagination state.
    @State private var viewModel: ChatViewModel?
    /// One-shot entry gate. Once this ChatView has materialized the
    /// authoritative head, history pagination must never re-enable the
    /// full-screen spinner just because the window intentionally slides away
    /// from the newest edge.
    @State private var hasMaterializedLatest = false

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
    private var isDeviceOnline: Bool { viewModel?.isDeviceOnline ?? false }
    #if DEBUG
    private var forceComposerForDiagnostics: Bool {
        ProcessInfo.processInfo.environment["KRAKI_FORCE_COMPOSER"] == "1"
    }
    #else
    private var forceComposerForDiagnostics: Bool { false }
    #endif
    /// Deterministic obstruction floor. The production composer is a 42pt
    /// capsule plus 6pt top/bottom padding = 54pt. iOS adds the home-indicator
    /// safe area separately through `adjustedContentInset.bottom`. Geometry
    /// callbacks may raise this for multiline/status content, but a visible
    /// composer must never transiently report zero and leave the tail under it.
    private var effectiveBottomInputHeight: CGFloat {
        ChatBottomObstruction.height(
            measuredComposerHeight: bottomInputHeight,
            composerVisible: isDeviceOnline || forceComposerForDiagnostics,
            compacting: viewModel?.isCompacting == true
        )
    }
    // MARK: - Body

    var body: some View {
        // Read an observable that changes as messages arrive so SwiftUI
        // re-evaluates this body (and thus the perf-list representable's
        // `updateUIViewController` → `syncLiveUpdates`) on live updates.
        // Without this read the body never re-runs after the first render.
        let _ = viewModel?.filteredMessages.count
        let _ = viewModel?.sessionLastSeq
        let _ = viewModel?.windowBottomSeq
        let _ = viewModel?.card
        let _ = viewModel?.runtimeStatus
        let providerWaitingForLatest = viewModel == nil
            || viewModel?.isWaitingForLatestBubble == true
        let waitingForLatest = ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: providerWaitingForLatest,
            hasMaterializedLatest: hasMaterializedLatest
        )
        let entryDiagnosticSignature = [
            "session=\(sessionId)",
            "vm=\(viewModel == nil ? 0 : 1)",
            "gate=\(waitingForLatest ? 1 : 0)",
            "metaHead=\(session?.lastSeq ?? 0)",
            "providerHead=\(viewModel?.sessionLastSeq ?? 0)",
            "window=\(viewModel?.windowTopSeq ?? 0)-\(viewModel?.windowBottomSeq ?? 0)",
            "raw=\(viewModel?.filteredMessages.count ?? 0)",
            "loading=\(appState.sessionStore.loadingSessions.contains(sessionId) ? 1 : 0)",
            "atHead=\(viewModel?.atHead == true ? 1 : 0)",
            "deviceOnline=\(isDeviceOnline ? 1 : 0)",
            "card=\(viewModel?.card == nil ? 0 : 1)",
        ].joined(separator: " ")
        // Keep the stale cached window fully hidden until it reaches the
        // authoritative head. The provider continues loading underneath; the
        // user sees one stable spinner instead of old bubbles followed by a
        // visible jump when the latest bubble arrives.
        ZStack {
            if waitingForLatest {
                Color.surfacePrimary
                    .ignoresSafeArea()
                ProgressView()
                    .controlSize(.large)
                    .accessibilityLabel("Loading latest messages")
            } else {
                // Create the UIKit list only after the provider window reaches
                // the authoritative head. A representable created underneath
                // an opacity-zero gate can finish loading its data source
                // without ever attaching its controller view to the window.
                ChatPerfListView(
                    sessionId: sessionId,
                    agent: session?.agent ?? "claude",
                    bottomContentInset: effectiveBottomInputHeight,
                    onResolvePermission: resolveLivePermission,
                    onAnswerQuestion: answerLiveQuestion
                )
            }
        }
        // Let the chat collection view extend behind BOTH the top navbar
        // and the bottom input area so message cells visibly blur THROUGH
        // the navbar's glass band and the input's glass capsule.
        .ignoresSafeArea(.container, edges: [.top, .bottom])
        // Top navbar glass band.
        .overlay(alignment: .top) {
            if !waitingForLatest { topNavGlassBand }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            // Show the compose area whenever the tentacle device is on file
            // as online. We intentionally do NOT gate on
            // `appState.isFullyOnline` — relay blips are short, the WS layer
            // queues outbound frames, and the input itself surfaces a hint
            // when sending would not be live.
            if !waitingForLatest,
               isDeviceOnline || viewModel?.isCompacting == true || forceComposerForDiagnostics {
                bottomInputArea
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
        .onChange(of: entryDiagnosticSignature, initial: true) { _, state in
            KLog.chatEntry("surface \(state)")
        }
        .onChange(of: providerWaitingForLatest, initial: true) { _, isWaiting in
            if !isWaiting { hasMaterializedLatest = true }
        }
        .task(id: sessionId) {
            KLog.chat("🎬 [3/render] ChatView.task started session=\(sessionId.prefix(12))")
            // New session ⇒ new observer instance; list pagination remains
            // isolated inside ChatPerfListVC.
            if viewModel == nil || viewModel?.sessionId != sessionId {
                hasMaterializedLatest = false
                viewModel = ChatViewModel(sessionId: sessionId, appState: appState)
                KLog.d("🎬 [3/render] ChatView.task viewModel created session=\(sessionId.prefix(12)) filteredCount=\(viewModel?.filteredMessages.count ?? -1)")
            }
            // This list currently opens at the newest edge. Clear the one-shot
            // snapshot so stale unread metadata cannot leak into a later open.
            appState.sessionStore.entryUnreadSnapshots.removeValue(forKey: sessionId)
            #if DEBUG
            // Dev-only auto-send: drive a real turn without fighting the
            // simulator's SwiftUI-TextField focus (which idb can't drive).
            // Waits for the device greeting (Pulse endpoint ready) so the
            // encrypted sendInput actually reaches the daemon.
            if let auto = ProcessInfo.processInfo.environment["KRAKI_AUTO_SEND"],
               !auto.isEmpty, !ChatView.autoSendFired {
                ChatView.autoSendFired = true
                Task { [weak appState] in
                    guard let appState else { return }
                    // Wait for the owning tentacle device to be greeted (Pulse up).
                    for _ in 0..<60 {
                        if appState.deviceStore.pendingGreetingIds.isEmpty { break }
                        try? await Task.sleep(for: .milliseconds(500))
                    }
                    try? await Task.sleep(for: .milliseconds(800))
                    appState.commandSender?.sendInput(sessionId: sessionId, text: auto)
                    KLog.d("🤖 auto-send dispatched session=\(sessionId.prefix(12))")
                }
            }
            #endif
        }
    }

    #if DEBUG
    private static var autoSendFired = false
    #endif

    // MARK: - Top navbar glass band

    /// Soft glass fade under the top navbar. Lives in SwiftUI (outside
    /// the flipped UICollectionView), so its gradient direction is
    /// independent of the inverted list's `scaleY(-1)` transform:
    /// full material behind the status bar + title, fading to clear a
    /// little below the bar so message cells emerge sharp.
    private var topNavGlassBand: some View {
        Rectangle()
            .fill(.bar)
            .mask(
                LinearGradient(
                    stops: [
                        .init(color: .black, location: 0.0),
                        .init(color: .black, location: 0.62),
                        .init(color: .clear, location: 1.0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .frame(height: 112)
            .frame(maxWidth: .infinity, alignment: .top)
            .ignoresSafeArea(.container, edges: .top)
            .allowsHitTesting(false)
    }

    // MARK: - Bottom Input Area

    @ViewBuilder
    private var bottomInputArea: some View {
        VStack(spacing: 8) {
            if viewModel?.isCompacting == true {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Compacting context…")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.thinMaterial, in: Capsule())
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Compacting context")
            }
            if isDeviceOnline {
                // Pure floating liquid-glass capsule. The capsule itself owns
                // its glass background (see `inputBoxGlassBackground` in
                // MessageInputView); we deliberately do NOT add a band of
                // material under the home-indicator strip — the chat
                // collection view scrolls behind the input so messages blur
                // through the capsule and the home-indicator area shows the
                // underlying content directly, matching the web composer.
                MessageInputView(
                    sessionId: sessionId,
                    pendingPermission: viewModel?.permissions.first,
                    pendingQuestion: viewModel?.questions.first,
                    isCompacting: viewModel?.isCompacting == true,
                    hasLiveCard: viewModel?.card != nil,
                    onHeightChange: { newHeight in
                        if abs(newHeight - bottomInputHeight) > 0.5 {
                            KLog.d("[chat-bottom] composer height \(bottomInputHeight)→\(newHeight)")
                            bottomInputHeight = newHeight
                        }
                    }
                )
            }
        }
    }

    private func resolveLivePermission(_ permissionId: String, toolName: String?, _ decision: String) {
        switch decision {
        case "approve":
            appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
        case "execute":
            // In discuss mode a write permission's middle action means
            // "switch this session to Execute", matching PermissionCardView.
            // Send the mode first so subsequent writes in the same agent turn
            // are auto-approved, then release the currently-blocked write.
            appState.commandSender?.setSessionMode(sessionId: sessionId, mode: .execute)
            appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
        case "always_allow":
            appState.commandSender?.alwaysAllow(
                sessionId: sessionId,
                permissionId: permissionId,
                toolKind: toolName
            )
        case "deny":
            appState.commandSender?.deny(sessionId: sessionId, permissionId: permissionId)
        default:
            break
        }
    }

    private func answerLiveQuestion(_ questionId: String, _ answer: String) {
        appState.commandSender?.answer(
            sessionId: sessionId,
            questionId: questionId,
            answer: answer
        )
    }
}

enum ChatEntryLoading {
    static func isEntryGateActive(
        providerWaitingForLatest: Bool,
        hasMaterializedLatest: Bool
    ) -> Bool {
        !hasMaterializedLatest && providerWaitingForLatest
    }

    static func isWaitingForLatest(
        expectedLastSeq: Int,
        windowBottomSeq: Int,
        hasMessages: Bool,
        sessionLoading: Bool
    ) -> Bool {
        if expectedLastSeq > 0 {
            return windowBottomSeq < expectedLastSeq
        }
        return !hasMessages && sessionLoading
    }
}

enum ChatBottomObstruction {
    static func height(
        measuredComposerHeight: CGFloat,
        composerVisible: Bool,
        compacting: Bool
    ) -> CGFloat {
        let composerFloor: CGFloat = composerVisible ? 54 : 0
        let compactionFloor: CGFloat = compacting ? 40 : 0
        let spacing: CGFloat = composerVisible && compacting ? 8 : 0
        return max(measuredComposerHeight, composerFloor + compactionFloor + spacing)
    }
}
#endif
