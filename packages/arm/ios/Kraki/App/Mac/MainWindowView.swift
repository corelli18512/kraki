/// MainWindowView — 2-pane NavigationSplitView root for the main window.
///
/// Layout (Messages.app style):
///
///   ┌──────────┬──────────────────────────────────┐
///   │ Sidebar  │ Detail                           │
///   │          │                                  │
///   │ Sessions │ ChatPlaceholderView (until M2)   │
///   │ Devices  │ or WelcomeView when empty        │
///   │          │                                  │
///   │ Tentacle │                                  │
///   │ status   │                                  │
///   └──────────┴──────────────────────────────────┘
///
/// Optional right-side .inspector is toggled via ⌘⌥I and hosts
/// SessionInfo or DeviceInfo content (deferred — placeholder for now).

#if os(macOS)
import AppKit
import SwiftUI
import StoreKit

// MARK: - Window chrome bridge

/// Slim SwiftUI ↔ AppKit bridge. Configures ONLY window-level chrome:
/// opaque dark canvas, hidden/transparent titlebar, and full-size
/// content so our own layout (including the sidebar) extends up behind
/// the traffic lights. It deliberately does NOT walk or mutate the
/// SwiftUI/AppKit view tree — we hand-roll the split layout with a
/// plain HStack, so there is no NavigationSplitView "Liquid Glass"
/// chrome to fight.
private struct WindowChromeConfigurator: NSViewRepresentable {
    let tint: Color

    /// Vertical center (distance from the window's top edge) shared by the
    /// traffic lights, Search field and Add button in the 62pt sidebar rail.
    private let trafficLightCenterFromTop: CGFloat = 20

    func makeCoordinator() -> Coordinator {
        Coordinator(centerFromTop: trafficLightCenterFromTop)
    }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        applyAsync(view: view, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        applyAsync(view: nsView, coordinator: context.coordinator)
    }

    private func applyAsync(view: NSView, coordinator: Coordinator) {
        let target = NSColor(tint)
        for delay in [0.0, 0.05, 0.2, 0.5] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak view] in
                let window = view?.window ?? NSApp.windows.first(where: { $0.isVisible })
                guard let window else { return }
                window.isOpaque = true
                window.backgroundColor = target
                window.titlebarAppearsTransparent = true
                window.titleVisibility = .hidden
                window.styleMask.insert(.fullSizeContentView)
                // SwiftUI WindowGroup forces per-window tabbingMode to
                // .automatic, which overrides the global
                // allowsAutomaticWindowTabbing flag and lets a Safari-style
                // tab bar appear. Force it off per window.
                window.tabbingMode = .disallowed
                // macOS persists the "Show Tab Bar" toggle
                // (NSWindowTabbingShoudShowTabBarKey…) per WindowGroup, so
                // the tab bar can still be visible on launch even with a
                // single window. Explicitly collapse it if shown.
                if window.tabGroup?.isTabBarVisible == true {
                    window.toggleTabBar(nil)
                }
                coordinator.attach(window)
            }
        }
    }

    /// Keeps the standard window buttons (traffic lights) vertically
    /// centered inside our taller header band. macOS re-lays them out on
    /// every resize / fullscreen transition, so we re-apply our offset
    /// after those events (our pass runs last and wins).
    @MainActor
    final class Coordinator {
        private weak var window: NSWindow?
        private var observers: [NSObjectProtocol] = []
        private let geometryCoordinator = MacWindowGeometryCoordinator()
        private let centerFromTop: CGFloat

        init(centerFromTop: CGFloat) {
            self.centerFromTop = centerFromTop
        }

        func attach(_ window: NSWindow) {
            if self.window !== window {
                self.window = window
                observers.forEach { NotificationCenter.default.removeObserver($0) }
                observers.removeAll()
                let nc = NotificationCenter.default
                let names: [Notification.Name] = [
                    NSWindow.didResizeNotification,
                    NSWindow.didEndLiveResizeNotification,
                    NSWindow.didEnterFullScreenNotification,
                    NSWindow.didExitFullScreenNotification,
                ]
                for name in names {
                    observers.append(
                        nc.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                            self?.reposition()
                        }
                    )
                }
            }
            geometryCoordinator.attach(window)
            reposition()
        }

        private func reposition() {
            guard let window, !window.styleMask.contains(.fullScreen) else { return }
            let buttons = [NSWindow.ButtonType.closeButton,
                           .miniaturizeButton,
                           .zoomButton]
                .compactMap { window.standardWindowButton($0) }
            guard let titlebar = buttons.first?.superview else { return }
            let bandTop = titlebar.bounds.height
            for button in buttons {
                var frame = button.frame
                let newY = bandTop - centerFromTop - frame.height / 2
                if abs(frame.origin.y - newY) > 0.5 {
                    frame.origin.y = newY
                    button.frame = frame
                }
            }
        }

        nonisolated deinit {
            observers.forEach { NotificationCenter.default.removeObserver($0) }
        }
    }
}

private struct MacReadVisibilityObserver: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChange: onChange) }

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        DispatchQueue.main.async { context.coordinator.attach(view.window) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.onChange = onChange
        DispatchQueue.main.async { context.coordinator.attach(nsView.window) }
    }

    @MainActor
    final class Coordinator {
        var onChange: (Bool) -> Void
        private weak var window: NSWindow?
        private var observers: [NSObjectProtocol] = []

        init(onChange: @escaping (Bool) -> Void) {
            self.onChange = onChange
        }

        func attach(_ window: NSWindow?) {
            guard let window else { return }
            if self.window !== window {
                self.window = window
                observers.forEach(NotificationCenter.default.removeObserver)
                observers.removeAll()
                let center = NotificationCenter.default
                let windowNames: [Notification.Name] = [
                    NSWindow.didBecomeKeyNotification,
                    NSWindow.didResignKeyNotification,
                    NSWindow.didMiniaturizeNotification,
                    NSWindow.didDeminiaturizeNotification,
                    NSWindow.didChangeOcclusionStateNotification,
                ]
                for name in windowNames {
                    observers.append(center.addObserver(
                        forName: name, object: window, queue: .main
                    ) { [weak self] _ in self?.refresh() })
                }
                observers.append(center.addObserver(
                    forName: NSWindow.willCloseNotification,
                    object: window,
                    queue: .main
                ) { [weak self] _ in self?.onChange(false) })
                for name in [NSApplication.didBecomeActiveNotification,
                             NSApplication.didResignActiveNotification] {
                    observers.append(center.addObserver(
                        forName: name, object: NSApp, queue: .main
                    ) { [weak self] _ in self?.refresh() })
                }
            }
            refresh()
        }

        private func refresh() {
            guard let window else { return }
            onChange(
                NSApp.isActive && window.isKeyWindow
                    && window.isVisible
                    && window.occlusionState.contains(.visible)
                    && !window.isMiniaturized
            )
        }

        deinit {
            observers.forEach(NotificationCenter.default.removeObserver)
        }
    }
}

struct MacHTMLArtifactSessionPresentation: Equatable {
    let selection: MacSelectedHTMLArtifact
    var expanded: Bool
}

struct MacHTMLArtifactSessionCache: Equatable {
    private var presentations: [String: MacHTMLArtifactSessionPresentation] = [:]

    func presentation(for sessionId: String) -> MacHTMLArtifactSessionPresentation? {
        presentations[sessionId]
    }

    mutating func open(sessionId: String, ref: ContentRef) {
        presentations[sessionId] = MacHTMLArtifactSessionPresentation(
            selection: MacSelectedHTMLArtifact(sessionId: sessionId, ref: ref),
            expanded: false
        )
    }

    mutating func toggleExpanded(for sessionId: String) {
        guard var presentation = presentations[sessionId] else { return }
        presentation.expanded.toggle()
        presentations[sessionId] = presentation
    }

    mutating func close(sessionId: String) {
        presentations.removeValue(forKey: sessionId)
    }
}

struct MainWindowView: View {
    private struct ChatPresentation {
        let sessionId: String
        let viewModel: ChatViewModel
        let generation: Int
    }

    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.requestReview) private var requestReview

    @SceneStorage("mac.sidebarVisible")
    private var sidebarVisible: Bool = true

    @State private var selectedSessionId: String?

    private let initialSelectedSessionId: String?
    private let selectionNotificationScope: String?
    private let onSelectedSessionChanged: (String?) -> Void

    init(
        initialSelectedSessionId: String? = nil,
        selectionNotificationScope: String? = nil,
        onSelectedSessionChanged: @escaping (String?) -> Void = { _ in }
    ) {
        self.initialSelectedSessionId = initialSelectedSessionId
        self.selectionNotificationScope = selectionNotificationScope
        self.onSelectedSessionChanged = onSelectedSessionChanged
        _selectedSessionId = State(initialValue: initialSelectedSessionId)
    }

    @AppStorage("mac.inspectorShown")
    private var inspectorShown: Bool = false

    @State private var pairingPresented: Bool = false
    @State private var newSessionPresented: Bool = false
    @State private var pendingDeleteSessionId: String? = nil
    @State private var sidebarSearchText = ""
    @State private var chatPresentation: ChatPresentation?
    @State private var selectedImagePreview: MacImagePreviewSelection?
    @State private var htmlArtifactSessions = MacHTMLArtifactSessionCache()

    private let sidebarWidth: CGFloat = 280
    private let inspectorWidth: CGFloat = 320
    private let desktopRailHeight: CGFloat = 40

    var body: some View {
        // Authentication and cold-launch routing live above this view in
        // MacApp. MainWindowView is the authenticated application surface only,
        // so Chat is never mounted behind Launch or Signed Out entry gates.
        authenticatedRoot
    }

    private var authenticatedRoot: some View {
        // A real two-section layout: each side owns its own 62pt header and
        // content stack. Matching heights align them without a global overlay.
        HStack(spacing: 0) {
            if sidebarVisible {
                VStack(spacing: 0) {
                    sidebarSectionHeader
                    SessionsSidebarView(
                        selectedSessionId: $selectedSessionId,
                        searchText: sidebarSearchText,
                        onNewSession: { newSessionPresented = true }
                    )
                }
                .frame(width: sidebarWidth)
                .background(Color.surfacePrimary)
                .transition(.move(edge: .leading).combined(with: .opacity))

                Rectangle()
                    .fill(Color.borderPrimary.opacity(0.55))
                    .frame(width: 1)
                    .padding(.vertical, 20)
            }

            HStack(spacing: 0) {
                detailPane
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.surfacePrimary)

                if inspectorShown {
                    Rectangle()
                        .fill(Color.borderPrimary.opacity(0.55))
                        .frame(width: 1)
                        .padding(.bottom, 10)

                    InspectorPane(selectedSessionId: selectedSessionId)
                        .frame(width: inspectorWidth)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .ignoresSafeArea(.container, edges: .top)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfacePrimary.ignoresSafeArea())
        .background(WindowChromeConfigurator(tint: Color.surfacePrimary))
        .background(
            MacReadVisibilityObserver { visible in
                appState.updateReadVisibility(
                    appForeground: NSApp.isActive,
                    conversationVisible: visible
                )
            }
        )
        .sheet(isPresented: $pairingPresented) {
            PairingSheet()
        }
        .sheet(isPresented: $newSessionPresented) {
            NewSessionSheet(isPresented: $newSessionPresented) { newId in
                selectedSessionId = newId
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macToggleSidebar)) { _ in
            withAnimation(.easeInOut(duration: 0.22)) { sidebarVisible.toggle() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macOpenPairing)) { _ in
            pairingPresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .macOpenNewSession)) { _ in
            newSessionPresented = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .macSelectSession)) { note in
            let scope = note.userInfo?["scope"] as? String
            guard scope == selectionNotificationScope else { return }
            if let sid = note.userInfo?["sessionId"] as? String {
                selectedSessionId = sid
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macNavigateSession)) { note in
            let ordered = appState.sessionStore.navigationOrderedSessions
            guard !ordered.isEmpty else { return }
            let targetIndex: Int
            if let index = note.userInfo?["index"] as? Int {
                targetIndex = min(max(index, 0), ordered.count - 1)
            } else {
                let direction = note.userInfo?["direction"] as? Int ?? 1
                let currentIndex = selectedSessionId.flatMap { id in
                    ordered.firstIndex(where: { $0.id == id })
                }
                if let currentIndex {
                    targetIndex = (currentIndex + direction + ordered.count) % ordered.count
                } else {
                    targetIndex = direction < 0 ? ordered.count - 1 : 0
                }
            }
            selectedSessionId = ordered[targetIndex].id
        }
        .onReceive(NotificationCenter.default.publisher(for: .macDeleteSession)) { note in
            pendingDeleteSessionId = (note.userInfo?["sessionId"] as? String) ?? selectedSessionId
        }
        .onReceive(NotificationCenter.default.publisher(for: .macRequestReview)) { _ in
            requestReview()
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .macNativeAutomationAction)) { note in
            guard MacAutomationDriver.shared.enabled,
                  let action = note.userInfo?["action"] as? String else { return }
            switch action {
            case "selectSession":
                guard let sessionId = note.userInfo?["sessionId"] as? String else { return }
                selectedSessionId = sessionId
            case "closeHTMLArtifact":
                if let selectedSessionId {
                    htmlArtifactSessions.close(sessionId: selectedSessionId)
                }
            default:
                break
            }
        }
        #endif
        .confirmationDialog(
            "Delete this session? This cannot be undone.",
            isPresented: Binding(
                get: { pendingDeleteSessionId != nil },
                set: { if !$0 { pendingDeleteSessionId = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete Session", role: .destructive) {
                if let id = pendingDeleteSessionId {
                    appState.commandSender?.deleteSession(sessionId: id)
                    htmlArtifactSessions.close(sessionId: id)
                    if selectedSessionId == id { selectedSessionId = nil }
                }
                pendingDeleteSessionId = nil
            }
            Button("Cancel", role: .cancel) { pendingDeleteSessionId = nil }
        }
        .onChange(of: selectedSessionId) { oldValue, newValue in
            onSelectedSessionChanged(newValue)
            if let oldValue, oldValue != newValue {
                appState.endViewingSession(oldValue)
            }
            selectedImagePreview = nil
            if let newValue {
                prepareSelectedSession(newValue)
            } else {
                chatPresentation = nil
            }
            #if DEBUG
            MacAutomationDriver.shared.updateSelectedSession(newValue)
            #endif
            // Release the live subscription when no session is selected
            // (back to Welcome) — mirrors iOS SessionDetailView.onDisappear.
            if newValue == nil {
                appState.sessionSubscriptionController.setDesired(nil)
            }
        }
        .onChange(of: appState.sessionStore.navigateToSession) { _, target in
            guard let target else { return }
            selectedSessionId = target
            appState.sessionStore.navigateToSession = nil
        }
        .onChange(of: appState.sessionStore.sessions) { _, sessions in
            // A deep link can cross the launch gate before the authoritative
            // session_list has arrived. Keep its semantic selection and mount
            // Chat as soon as that Session becomes known.
            if let selectedSessionId,
               chatPresentation?.sessionId != selectedSessionId,
               sessions[selectedSessionId] != nil {
                prepareSelectedSession(selectedSessionId)
            }
            #if DEBUG
            if let target = ProcessInfo.processInfo.environment["KRAKI_OPEN_SESSION_ID"],
               selectedSessionId != target,
               sessions[target] != nil {
                selectedSessionId = target
            }
            #endif
        }
        .onAppear {
            if let initialSelectedSessionId,
               appState.sessionStore.sessions[initialSelectedSessionId] != nil,
               selectedSessionId != initialSelectedSessionId {
                selectedSessionId = initialSelectedSessionId
            }
            if let selectedSessionId {
                prepareSelectedSession(selectedSessionId)
            }
            #if DEBUG
            MacAutomationDriver.shared.updateSelectedSession(selectedSessionId)
            if let target = ProcessInfo.processInfo.environment["KRAKI_OPEN_SESSION_ID"],
               selectedSessionId != target,
               appState.sessionStore.sessions[target] != nil {
                selectedSessionId = target
            }
            #endif
        }
        .onDisappear {
            if let selectedSessionId {
                appState.endViewingSession(selectedSessionId)
            }
        }
        .onChange(of: appState.sessionStore.totalUnread) { _, total in
            NSApp.dockTile.badgeLabel = total > 0 ? "\(total)" : ""
        }
    }

    private var sidebarSectionHeader: some View {
        HStack(spacing: 8) {
            // The real AppKit traffic lights occupy this fixed leading region.
            Color.clear.frame(width: 62, height: 22)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(Color.textMuted)
                TextField("Search", text: $sidebarSearchText)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textPrimary)
            }
            .padding(.horizontal, 9)
            .frame(height: 28)
            .background(Color.surfaceSecondary.opacity(0.72), in: RoundedRectangle(cornerRadius: 9))
            .overlay(
                RoundedRectangle(cornerRadius: 9)
                    .stroke(Color.borderPrimary.opacity(0.65), lineWidth: 1)
            )
            Button { newSessionPresented = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 13, weight: .semibold))
                    .frame(width: 26, height: 26)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.textSecondary)
            .help("New Session (⌘N)")
        }
        .padding(.leading, 4)
        .padding(.trailing, 10)
        .frame(height: desktopRailHeight)
        .background(Color.surfacePrimary)
    }

    private func prepareSelectedSession(_ id: String) {
        guard appState.sessionStore.sessions[id] != nil else {
            chatPresentation = nil
            return
        }
        // Keep the previous authoritative per-Session live card mounted while
        // the local history gate is restored. A persisted conclusion clears it;
        // otherwise the subscription ACK atomically replaces this cached first
        // frame without a one-RTT collapse during Session switching.
        // One presentation owner, one reanchor, one model snapshot. The Chat
        // view consumes this prepared transaction and never opens the Session a
        // second time with stale @State from the previous selection.
        _ = appState.messageProvider?.openSession(id, reanchorLatest: true)
        let nextViewModel = ChatViewModel(sessionId: id, appState: appState)
        nextViewModel.refreshMessageCache()
        let generation = (chatPresentation?.generation ?? 0) &+ 1
        chatPresentation = ChatPresentation(
            sessionId: id,
            viewModel: nextViewModel,
            generation: generation
        )
        appState.beginViewingSession(id)
        appState.sessionSubscriptionController.setDesired(id)
        if isSessionDeviceOnline(id) {
            appState.messageProvider?.ensureLoaded(sessionId: id, reason: "mainWindowSelection")
        } else {
            appState.sessionStore.setLoading(id, false)
        }
        let entryBottom = appState.messageStore.windows[id]?.bottomSeq ?? 0
        let entryDBLast = appState.messageStore.dbLastSeq(id)
        let entryExpected = max(
            appState.sessionStore.session(for: id)?.lastSeq ?? 0,
            appState.messageProvider?.tentacleLastKnownSeq(id) ?? 0
        )
        KLog.d(
            "🧭 [MacChat presentation] generation=\(generation) session=\(id.prefix(12)) "
                + "bottom=\(entryBottom) dbLast=\(entryDBLast) expected=\(entryExpected)"
        )
        appState.sessionStore.entryUnreadSnapshots.removeValue(forKey: id)
        appState.markSessionReadIfVisible(id)
    }

    private func isSessionDeviceOnline(_ id: String) -> Bool {
        guard let deviceId = appState.sessionStore.sessions[id]?.deviceId else { return false }
        return appState.deviceStore.devices[deviceId]?.online == true
    }

    @ViewBuilder
    private var detailPane: some View {
        if let id = selectedSessionId,
           appState.sessionStore.isPending(id) {
            MacPendingSessionView(sessionId: id)
        } else if let presentation = chatPresentation {
            GeometryReader { geometry in
                let compactArtifactPresentation = geometry.size.width < 780
                let artifactPresentation = htmlArtifactSessions.presentation(
                    for: presentation.sessionId
                )
                let showArtifactFullWidth = (artifactPresentation?.expanded ?? false)
                    || compactArtifactPresentation
                ZStack(alignment: .trailing) {
                    HStack(spacing: 0) {
                        MacChatView(
                            sessionId: presentation.sessionId,
                            prebuiltViewModel: presentation.viewModel,
                            entryGeneration: presentation.generation,
                            onOpenImage: { selection in
                                selectedImagePreview = selection
                            },
                            onOpenHTMLArtifact: { ref in
                                htmlArtifactSessions.open(
                                    sessionId: presentation.sessionId,
                                    ref: ref
                                )
                            }
                        )
                        // The breadcrumb and Chat live in separate SwiftUI
                        // subtrees. Give each prepared presentation an explicit
                        // identity so an offline/loading overlay from the prior
                        // Session cannot survive after the breadcrumb has
                        // already switched to the next Session.
                        .id(presentation.generation)
                        .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity)

                        if let artifactPresentation, !showArtifactFullWidth {
                            Rectangle()
                                .fill(Color.borderPrimary.opacity(0.7))
                                .frame(width: 1)
                            htmlArtifactPanel(
                                artifactPresentation.selection,
                                width: min(680, max(380, geometry.size.width * 0.46)),
                                expanded: false,
                                canToggleExpanded: true
                            )
                        }
                    }

                    if let artifactPresentation, showArtifactFullWidth {
                        htmlArtifactPanel(
                            artifactPresentation.selection,
                            width: geometry.size.width,
                            expanded: true,
                            canToggleExpanded: !compactArtifactPresentation
                        )
                        .background(Color.surfacePrimary)
                        .zIndex(2)
                    }

                    if let selectedImagePreview {
                        MacImagePreviewOverlay(
                            selection: selectedImagePreview,
                            onClose: { self.selectedImagePreview = nil }
                        )
                        .transition(.opacity)
                        .zIndex(10)
                    }
                }
            }
        } else {
            WelcomeView()
        }
    }

    private func htmlArtifactPanel(
        _ selection: MacSelectedHTMLArtifact,
        width: CGFloat,
        expanded: Bool,
        canToggleExpanded: Bool
    ) -> some View {
        MacHTMLArtifactPanel(
            selection: selection,
            expanded: expanded,
            canToggleExpanded: canToggleExpanded,
            onToggleExpanded: {
                guard canToggleExpanded else { return }
                htmlArtifactSessions.toggleExpanded(for: selection.sessionId)
            },
            onClose: {
                htmlArtifactSessions.close(sessionId: selection.sessionId)
            }
        )
        .frame(width: width)
    }
}

// MARK: - Pending session

private struct MacPendingSessionView: View {
    @Environment(AppState.self) private var appState
    let sessionId: String

    var body: some View {
        VStack(spacing: 14) {
            if let reason = appState.sessionStore.pendingSessionErrors[sessionId] {
                Image(systemName: "exclamationmark.circle")
                    .font(.system(size: 34))
                    .foregroundStyle(.red)
                Text("Couldn't start session")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textTitle)
                Text(reason)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            } else {
                ProgressView().controlSize(.large)
                Text("Starting session…")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 62)
        .background(Color.surfacePrimary)
    }
}

// MARK: - Inspector content

private struct InspectorPane: View {
    @Environment(AppState.self) private var appState
    let selectedSessionId: String?

    var body: some View {
        if let id = selectedSessionId,
           let session = appState.sessionStore.sessions[id] {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        AgentAvatar(agent: session.agent, sessionId: session.id, size: .md, status: session.state)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.displayTitle)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.textTitle)
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(Color.modeColor(session.mode))
                                    .frame(width: 5, height: 5)
                                Text(session.mode.rawValue.uppercased())
                                    .font(.system(size: 9, weight: .heavy))
                                    .tracking(0.4)
                                    .foregroundStyle(Color.modeColor(session.mode))
                            }
                        }
                        Spacer()
                    }

                    Divider().overlay(Color.borderPrimary)

                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader("Identity")
                        LabeledRow(label: "Agent", value: session.agent)
                        LabeledRow(label: "Model", value: session.model ?? "—")
                        LabeledRow(label: "Mode",  value: session.mode.rawValue)
                    }

                    if let device = appState.deviceStore.devices[session.deviceId] {
                        VStack(alignment: .leading, spacing: 8) {
                            sectionHeader("Device")
                            LabeledRow(label: "Name",   value: device.name)
                            LabeledRow(label: "Role",   value: device.role.rawValue.capitalized)
                            LabeledRow(label: "Status", value: device.online ? "Online" : "Offline")
                        }
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        sectionHeader("Timeline")
                        LabeledRow(label: "Created",
                                   value: session.createdAt.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.surfacePrimary)
        } else {
            VStack(spacing: 10) {
                Image(systemName: "info.circle")
                    .font(.system(size: 28, weight: .light))
                    .foregroundStyle(Color.textMuted)
                Text("No Session Selected")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text("Select a session in the sidebar to see details.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 200)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
            .background(Color.surfacePrimary)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .heavy, design: .monospaced))
            .tracking(0.6)
            .foregroundStyle(Color.textMuted)
    }
}

private struct LabeledRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textMuted)
                .frame(width: 70, alignment: .leading)
            Text(value)
                .font(.system(size: 11))
                .foregroundStyle(Color.textPrimary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

#endif
