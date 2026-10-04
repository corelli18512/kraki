#if os(iOS)
/// Main pure-spine chat surface: landed messages render as one TextKit-backed
/// bubble each; streaming narration and actions live in the ephemeral live card.


import SwiftUI

struct ChatView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var colorScheme

    /// View model for session/device/live-card observation. The list controller
    /// owns its own flat-spine snapshot and pagination state.
    @State private var viewModel: ChatViewModel?
    /// One-shot entry gate. Once this ChatView has materialized the
    /// authoritative head, history pagination must never re-enable the
    /// full-screen spinner just because the window intentionally slides away
    /// from the newest edge.
    @State private var hasMaterializedLatest = false
    @State private var selectedImagePreview: IOSImagePreviewSelection?
    @State private var selectedHTMLArtifact: IOSSelectedHTMLArtifact?

    // MARK: - View-model passthroughs

    private var session: SessionInfo? { viewModel?.session }
    private var isDeviceOnline: Bool { viewModel?.isDeviceOnline ?? false }
    private var isNewEmptySession: Bool {
        guard let viewModel else { return false }
        // Read the observed window (the body re-renders on it), not the list
        // engine's snapshot, which SwiftUI does not observe.
        return ChatViewModel.renderable(viewModel.filteredMessages).isEmpty
            && viewModel.pendingMessages.isEmpty && viewModel.card == nil
    }
    #if DEBUG
    private var forceComposerForDiagnostics: Bool {
        ProcessInfo.processInfo.environment["KRAKI_FORCE_COMPOSER"] == "1"
    }
    #else
    private var forceComposerForDiagnostics: Bool { false }
    #endif
    /// Stable resting clearance, like Mac. Dictation and multiline text grow
    /// upward over the list, never changing its inset/scroll position. UIKit
    /// adds the home-indicator safe area via `adjustedContentInset.bottom`.
    private var effectiveBottomInputHeight: CGFloat {
        ChatBottomObstruction.height(
            composerClearance: ChatBottomObstruction.composerClearance(
                capsuleHeight: IOSComposerMetrics.height,
                bottomPadding: IOSComposerMetrics.verticalPadding,
                bubbleBottomPadding: TKMetrics.outerV
            ),
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
        let _ = viewModel?.pendingSignature
        // Show what this device already has at once; newer messages land at
        // the tail silently. Only a conversation with nothing stored waits
        // behind the spinner.
        let hasCachedHistory = viewModel.map { !$0.filteredMessages.isEmpty } ?? false
        let providerWaitingForLatest = viewModel == nil
            || (viewModel?.isWaitingForLatestBubble == true && !hasCachedHistory)
        let waitingForInitialConnection = ChatEntryLoading.isInitialConnectionGateActive(
            hasStoredCredentials: appState.hasStoredCredentials,
            hasCompletedInitialConnect: appState.hasCompletedInitialConnect,
            connectionStatus: appState.connectionStatus
        )
        // Cold start: while the first Relay connection is still being made,
        // show cached history immediately (newer messages append at the tail
        // when they arrive) instead of hiding it behind a spinner. The
        // spinner remains only when there is nothing cached to show.
        let entrySourceWaiting = providerWaitingForLatest
            || (waitingForInitialConnection && !hasCachedHistory)
        let waitingForLatest = ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: entrySourceWaiting,
            hasMaterializedLatest: hasMaterializedLatest
        )
        let entryDiagnosticSignature = [
            "session=\(sessionId)",
            "vm=\(viewModel == nil ? 0 : 1)",
            "gate=\(waitingForLatest ? 1 : 0)",
            "connectionGate=\(waitingForInitialConnection ? 1 : 0)",
            "connection=\(String(describing: appState.connectionStatus))",
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
                    onAnswerQuestion: answerLiveQuestion,
                    onOpenImage: { selection in
                        selectedImagePreview = selection
                    },
                    onOpenHTMLArtifact: { ref in
                        selectedHTMLArtifact = IOSSelectedHTMLArtifact(
                            sessionId: sessionId,
                            ref: ref
                        )
                    }
                )
            }
        }
        // A brand-new session: say where it runs, so the empty screen is
        // not ambiguous ("which computer / agent / model is this?").
        .overlay {
            if !waitingForLatest, isNewEmptySession, let session {
                NewSessionIntro(
                    deviceName: appState.deviceStore.device(for: session.deviceId)?.name,
                    agent: AgentInfo.from(session.agent).label,
                    model: session.model
                )
                .allowsHitTesting(false)
            }
        }
        // Let the chat collection view extend behind BOTH the top navbar
        // and the bottom input area so message cells visibly blur THROUGH
        // the navbar's glass band and the input's glass capsule.
        .ignoresSafeArea(.container, edges: [.top, .bottom])
        // Progressive blur under the status bar and floating header.
        .overlay(alignment: .top) {
            if !waitingForLatest { topEdgeBlur }
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
        .fullScreenCover(item: $selectedImagePreview) { selection in
            IOSImagePreviewGallery(selection: selection)
        }
        .sheet(item: $selectedHTMLArtifact) { selection in
            IOSHTMLArtifactPreview(selection: selection)
                .environment(appState)
        }
        .onChange(of: sessionId, initial: true) { _, _ in
            selectedImagePreview = nil
            selectedHTMLArtifact = nil
        }
        .onChange(of: entryDiagnosticSignature, initial: true) { _, state in
            KLog.chatEntry("surface \(state)")
        }
        .onChange(of: entrySourceWaiting, initial: true) { _, isWaiting in
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

    // MARK: - Top edge blur

    /// Soft glass fade under the top navbar. Lives in SwiftUI (outside
    /// the flipped UICollectionView), so its gradient direction is
    /// independent of the inverted list's `scaleY(-1)` transform:
    /// full material behind the status bar + title, fading to clear a
    /// little below the bar so message cells emerge sharp.
    /// Progressive blur: strongest under the status bar, easing to nothing a
    /// little below the floating controls. Blur + a light page-color veil,
    /// both masked with an eased curve so there is no visible band edge.
    private var topEdgeBlur: some View {
        // Modeled on iOS 26 Messages: a long, eased fade whose strongest
        // point is still translucent (never an opaque slab), tinted neutral
        // black in dark mode / white in light mode rather than the page's
        // navy-tinted surface color.
        let dark = colorScheme == .dark
        let tint = dark ? Color.black : Color.white
        let mask = LinearGradient(
            stops: [
                .init(color: .black.opacity(0.9), location: 0.0),
                .init(color: .black.opacity(0.78), location: 0.3),
                .init(color: .black.opacity(0.5), location: 0.55),
                .init(color: .black.opacity(0.22), location: 0.78),
                .init(color: .clear, location: 1.0),
            ],
            startPoint: .top,
            endPoint: .bottom
        )
        return ZStack {
            Rectangle().fill(.ultraThinMaterial).opacity(0.85)
            tint.opacity(dark ? 0.55 : 0.5)
        }
        .mask(mask)
        .frame(height: 170)
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
                    pendingQuestion: viewModel?.questions.last,
                    isCompacting: viewModel?.isCompacting == true,
                    hasLiveCard: viewModel?.card != nil
                )
            }
        }
    }

    private func resolveLivePermission(_ permissionId: String, toolName: String?, _ decision: String) {
        switch decision {
        case "approve":
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
        #if KRAKI_DIAG
        KrakiDiag.withAnswerInteraction(session: sessionId, question: questionId, origin: "ios_choice") {
            appState.commandSender?.answer(sessionId: sessionId, questionId: questionId, answer: answer)
        }
        #else
        appState.commandSender?.answer(
            sessionId: sessionId,
            questionId: questionId,
            answer: answer
        )
        #endif
        // Picking a choice is sending a message: return to the newest edge.
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil,
                                        userInfo: ["sessionId": sessionId])
    }
}
/// Shown in an empty, just-created session.
private struct NewSessionIntro: View {
    let deviceName: String?
    let agent: String
    let model: String?

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "desktopcomputer")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary)
            if let deviceName {
                Text(deviceName).font(.headline)
            }
            Text([agent, model].compactMap { $0 }.joined(separator: " · "))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Ask \(agent) to do something on this computer.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
        .accessibilityElement(children: .combine)
    }
}
#endif
