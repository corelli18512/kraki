#if os(macOS)
import SwiftUI

/// macOS chat surface kept structurally in sync with iOS `ChatView` and
/// `SessionDetailView`: the list extends under top/bottom chrome, a 112pt glass
/// band carries the session title, and the floating composer owns its own glass.
private struct MacChatTopDarkFade: View {
    var body: some View {
        Canvas { context, size in
            guard size.width > 0, size.height > 0 else { return }
            let sideFade = min(72, size.width * 0.16)
            let steps = max(1, Int(ceil(size.width / 2)))
            let stripeWidth = size.width / CGFloat(steps)

            for index in 0..<steps {
                let x = CGFloat(index) * stripeWidth
                let centerX = x + stripeWidth * 0.5
                let left = min(1, centerX / sideFade)
                let right = min(1, (size.width - centerX) / sideFade)
                let horizontal = smoothstep(min(left, right))
                guard horizontal > 0.001 else { continue }

                let rect = CGRect(x: x, y: 0, width: stripeWidth + 0.5, height: size.height)
                context.fill(
                    Path(rect),
                    with: .linearGradient(
                        Gradient(stops: [
                            .init(color: Color.black.opacity(0.44 * horizontal), location: 0),
                            .init(color: Color.black.opacity(0.36 * horizontal), location: 0.30),
                            .init(color: Color.black.opacity(0.18 * horizontal), location: 0.72),
                            .init(color: .clear, location: 1),
                        ]),
                        startPoint: CGPoint(x: rect.midX, y: rect.minY),
                        endPoint: CGPoint(x: rect.midX, y: rect.maxY)
                    )
                )
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func smoothstep(_ value: CGFloat) -> Double {
        let x = max(0, min(1, value))
        return Double(x * x * (3 - 2 * x))
    }
}

private struct MacChatModePicker: View {
    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    let currentMode: SessionMode
    @Binding var expanded: Bool
    let onSelect: (SessionMode) -> Void
    @State private var collapseTask: Task<Void, Never>?

    var body: some View {
        Group {
            if expanded {
                expandedPicker
                    .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .trailing)))
            } else {
                collapsedSegment
                    .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .trailing)))
            }
        }
        .frame(height: 29)
        .animation(.easeInOut(duration: 0.22), value: expanded)
    }

    private var collapsedSegment: some View {
        Button {
            withAnimation { expanded = true }
            scheduleCollapse()
        } label: {
            modeSegment(currentMode, selected: true)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("mac.chat.mode.collapsed")
        .accessibilityLabel("Session mode, \(currentMode.rawValue). Expand mode picker")
    }

    private var expandedPicker: some View {
        HStack(spacing: 2) {
            ForEach(Self.allModes, id: \.self) { mode in
                Button {
                    onSelect(mode)
                    collapseTask?.cancel()
                    collapseTask = Task {
                        try? await Task.sleep(for: .milliseconds(500))
                        guard !Task.isCancelled else { return }
                        await MainActor.run { withAnimation { expanded = false } }
                    }
                } label: {
                    modeSegment(mode, selected: mode == currentMode)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("mac.chat.mode.\(mode.rawValue)")
            }
        }
        .padding(2)
        .background { glassBackground(RoundedRectangle(cornerRadius: 9, style: .continuous)) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Session mode picker")
    }

    private func modeSegment(_ mode: SessionMode, selected: Bool) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Color.modeColor(mode))
                .frame(width: 6, height: 6)
            Text(mode.rawValue.capitalized)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(selected ? Color.white : Color.textSecondary)
        }
        .padding(.horizontal, 9)
        .frame(height: 25)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Color.modeColor(mode).opacity(0.82))
            }
        }
        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    @ViewBuilder
    private func glassBackground<S: Shape>(_ shape: S) -> some View {
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.stroke(Color.white.opacity(0.12), lineWidth: 0.5))
        }
    }

    private func scheduleCollapse() {
        collapseTask?.cancel()
        collapseTask = Task {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await MainActor.run { withAnimation { expanded = false } }
        }
    }
}

struct MacChatView: View {
    let sessionId: String
    let viewModel: ChatViewModel
    let entryGeneration: Int
    let onOpenImage: (MacImagePreviewSelection) -> Void
    let onOpenHTMLArtifact: (ContentRef) -> Void

    @Environment(AppState.self) private var appState
    @State private var hasMaterializedLatest = false
    @State private var stepsTarget: StepsTarget?
    @State private var showInfo = false
    @State private var modePickerExpanded = false

    init(
        sessionId: String,
        prebuiltViewModel: ChatViewModel,
        entryGeneration: Int = 0,
        onOpenImage: @escaping (MacImagePreviewSelection) -> Void = { _ in },
        onOpenHTMLArtifact: @escaping (ContentRef) -> Void = { _ in }
    ) {
        self.sessionId = sessionId
        self.viewModel = prebuiltViewModel
        self.entryGeneration = entryGeneration
        self.onOpenImage = onOpenImage
        self.onOpenHTMLArtifact = onOpenHTMLArtifact
    }

    private struct StepsTarget: Identifiable {
        let id = UUID()
        let seq: Int
        let live: Bool
    }

    private var session: SessionInfo? { viewModel.session }
    private var isDeviceOnline: Bool { viewModel.isDeviceOnline }
    private var providerWaitingForLatest: Bool {
        viewModel.isWaitingForLatestBubble
    }
    private var hasLocalPresentation: Bool {
        !viewModel.displayMessages.isEmpty || liveCardForList(viewModel) != nil || !isDeviceOnline
    }
    private var waitingForLatest: Bool {
        guard viewModel.sessionId == sessionId else { return true }
        // Present a prepared local tail immediately and reconcile a newer relay
        // head in place. Reserve the full-screen gate for a truly empty online
        // Session whose initial head request is still active.
        if hasLocalPresentation { return false }
        return ChatEntryLoading.isEntryGateActive(
            providerWaitingForLatest: providerWaitingForLatest,
            hasMaterializedLatest: hasMaterializedLatest
        )
    }
    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[sessionId] ?? session?.mode ?? .discuss
    }
    private var composerVisible: Bool {
        isDeviceOnline || viewModel.isCompacting
    }
    private var effectiveBottomInputHeight: CGFloat {
        // The Composer is a floating overlay. Keep one stable base clearance so
        // the last bubble can rest above the input capsule, but never couple
        // Chat geometry to multiline typing, microphone, or streaming height.
        // Those surfaces grow upward over the Chat without moving its viewport.
        guard composerVisible else { return 0 }
        return 62
    }

    private var spineRevision: Int {
        // Read the observable store DIRECTLY. Going through
        // MessageProvider.currentWindow() hides the dependency behind a
        // non-observable façade, so Swift Observation may never invalidate the
        // view when an async replay batch materialises the window.
        let window = appState.messageStore.messages[sessionId] ?? []
        let state = appState.messageStore.windows[sessionId]
        var hash = state?.bottomSeq ?? 0
        hash = hash &* 31 &+ (state?.topSeq ?? 0)
        hash = hash &* 31 &+ window.count
        hash = hash &* 31 &+ (window.last?.seq ?? 0)
        hash = hash &* 31 &+ (window.last?.type.hashValue ?? 0)
        hash = hash &* 31 &+ (window.last?.content?.hashValue ?? 0)
        hash = hash &* 31 &+ (viewModel.card == nil ? 0 : 1)
        hash = hash &* 31 &+ (viewModel.card?.text.hashValue ?? 0)
        if let action = viewModel.card?.action {
            hash = hash &* 31 &+ action.type.hashValue
            hash = hash &* 31 &+ (action.toolCallId?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.headline?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.permissionId?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.payload["decision"]?.stringValue?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.questionId?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.question?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.answer?.hashValue ?? 0)
            hash = hash &* 31 &+ (action.choices?.joined(separator: "\u{1F}").hashValue ?? 0)
            hash = hash &* 31 &+ (action.cancelled ? 1 : 0)
            hash = hash &* 31 &+ (action.payload["success"]?.boolValue == true ? 1 : 0)
            hash = hash &* 31 &+ (action.payload["running"]?.intValue ?? 0)
        }
        hash = hash &* 31 &+ (appState.commandSender?.outbox[sessionId]?.count ?? 0)
        return hash
    }

    var body: some View {
        let _ = appState.messageStore.messages[sessionId]?.count
        let _ = appState.messageStore.windows[sessionId]
        let _ = viewModel.sessionLastSeq
        let _ = viewModel.windowBottomSeq
        let _ = viewModel.card
        let _ = viewModel.runtimeStatus

        ZStack {
            Color.surfacePrimary.ignoresSafeArea()
            // Keep the production AppKit list mounted across Session
            // navigation. Replacing this branch with ProgressView destroys
            // the scroll view, cell pool and CoreText objects, turning every
            // Session switch into an avoidable cold start.
            chatList(viewModel)
                .opacity(waitingForLatest ? 0 : 1)
                .allowsHitTesting(!waitingForLatest)
            if !waitingForLatest {
                chatEdgeFades
            }
            if !waitingForLatest,
               viewModel.displayMessages.isEmpty,
               liveCardForList(viewModel) == nil {
                emptyConversationState(viewModel)
            }
            if waitingForLatest {
                ProgressView()
                    .controlSize(.large)
                    .accessibilityLabel("Loading latest messages")
            }
        }
        .overlay(alignment: .topTrailing) {
            if !waitingForLatest { chatTopControls }
        }
        .overlay(alignment: .bottom) {
            if !waitingForLatest, composerVisible {
                bottomInputArea
            }
        }
        .background(Color.surfacePrimary)
        .task {
            MacMarkdown.prewarmSyntaxHighlighter()
        }
        .onChange(of: entryGeneration, initial: true) { _, _ in
            hasMaterializedLatest = hasLocalPresentation || !providerWaitingForLatest
            stepsTarget = nil
        }
        .onChange(of: appState.messageStore.messages[sessionId]?.count ?? 0) { _, _ in
            viewModel.refreshMessageCache()
        }
        .onChange(of: appState.messageStore.windows[sessionId]?.bottomSeq ?? 0) { _, _ in
            viewModel.refreshMessageCache()
        }
        .onChange(of: spineRevision) { _, _ in
            viewModel.refreshMessageCache()
        }
        .onChange(of: providerWaitingForLatest, initial: true) { _, waiting in
            if !waiting { hasMaterializedLatest = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .macOpenSessionInfo)) { _ in
            showInfo = true
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .macNativeAutomationAction)) { note in
            guard MacAutomationDriver.shared.enabled,
                  (note.userInfo?["sessionId"] as? String ?? sessionId) == sessionId,
                  let actionName = note.userInfo?["action"] as? String else { return }
            switch actionName {
            case "permission":
                guard let action = viewModel.card?.action,
                      let permissionId = action.permissionId,
                      let decision = note.userInfo?["decision"] as? String else { return }
                resolveLivePermission(permissionId, toolName: action.toolName, decision)
            case "answer":
                guard let action = viewModel.card?.action,
                      let questionId = action.questionId else { return }
                answerLiveQuestion(questionId, note.userInfo?["text"] as? String ?? "")
            case "steps":
                let requestedSeq = note.userInfo?["seq"] as? Int
                let fallbackSeq = viewModel.cachedMessages.last(where: { $0.steps ?? 0 > 0 })?.seq
                guard let seq = requestedSeq ?? fallbackSeq, seq > 0 else { return }
                stepsTarget = StepsTarget(seq: seq, live: viewModel.card != nil)
                viewModel.requestSteps(forBubbleSeq: seq)
            case "info":
                showInfo = true
            case "jumpLatest":
                reanchorNewest(viewModel)
            case "pageOlder":
                viewModel.loadOlderIfPossible()
            case "toggleModePicker":
                withAnimation { modePickerExpanded.toggle() }
            default:
                break
            }
        }
        #endif
        .sheet(item: $stepsTarget, onDismiss: {
            #if DEBUG
            MacAutomationDriver.shared.clearPresentedSteps()
            #endif
        }) { target in
            MacStepsView(
                sessionId: sessionId,
                targetSeq: target.seq,
                live: target.live,
                agent: session?.agent ?? "claude",
                store: appState.messageStore
            )
            .environment(appState)
        }
        .sheet(isPresented: $showInfo) {
            if let session {
                MacSessionInfoSheet(session: session)
                    .environment(appState)
            }
        }
    }

    private var chatEdgeFades: some View {
        VStack(spacing: 0) {
            MacChatTopDarkFade()
                .frame(height: 68)
            Spacer(minLength: 0)
            Rectangle()
                .fill(.bar)
                .opacity(0.30)
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black.opacity(0.58), location: 0.62),
                            .init(color: .black, location: 1),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .padding(.horizontal, 18)
                .frame(height: 88)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var chatTopControls: some View {
        ZStack {
            if let session {
                Text(session.displayTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textTitle)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 460)
                    .padding(.horizontal, 130)
                    .opacity(modePickerExpanded ? 0 : 1)
                    .animation(.easeInOut(duration: 0.18), value: modePickerExpanded)
            }

            HStack {
                Spacer(minLength: 0)
                MacChatModePicker(
                    currentMode: currentMode,
                    expanded: $modePickerExpanded,
                    onSelect: { mode in
                        appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
                    }
                )

                Button {
                    NotificationCenter.default.post(name: .macOpenSessionInfo, object: nil)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(Color.textSecondary)
                        .frame(width: 29, height: 29)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .background { glassControlBackground(Circle()) }
                .accessibilityLabel("More")
            }
        }
        .frame(height: 34)
        .padding(.top, 4)
        .padding(.horizontal, 12)
    }

    @ViewBuilder
    private func glassControlBackground<S: Shape>(_ shape: S) -> some View {
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.stroke(Color.white.opacity(0.12), lineWidth: 0.5))
        }
    }

    private func chatList(_ viewModel: ChatViewModel) -> some View {
        GeometryReader { geometry in
            MacChatListRepresentable(
                sessionId: viewModel.sessionId,
                agent: session?.agent ?? "claude",
                messageStore: appState.messageStore,
                attachmentStore: appState.attachmentStore,
                documentWidth: geometry.size.width,
                messages: viewModel.displayMessages,
                liveCard: liveCardForList(viewModel),
                liveTraceSeq: viewModel.lastUserMessage?.seq ?? 0,
                liveSteps: viewModel.lastUserStepsHint,
                sessionMode: currentMode,
                entryGeneration: entryGeneration,
                bottomContentInset: effectiveBottomInputHeight,
                isLoadingOlder: viewModel.isLoadingOlder,
                isLoadingNewer: viewModel.isFillingTail,
                atOldest: viewModel.atHistoryStart,
                atNewest: viewModel.atHead,
                onJumpToLatest: {
                    reanchorNewest(viewModel)
                },
                onLoadOlder: { viewModel.loadOlderIfPossible() },
                onLoadNewer: {
                    if viewModel.pageNewerRaw() {
                        viewModel.refreshMessageCache()
                    }
                },
                onOpenSteps: { seq, live in
                    guard seq > 0 else { return }
                    stepsTarget = StepsTarget(seq: seq, live: live)
                    viewModel.requestSteps(forBubbleSeq: seq)
                },
                onResolvePermission: resolveLivePermission,
                onAnswerQuestion: answerLiveQuestion,
                onOpenImage: onOpenImage,
                onOpenHTMLArtifact: onOpenHTMLArtifact
            )
        }
    }

    private var bottomInputArea: some View {
        VStack(spacing: 8) {
            if viewModel.isCompacting {
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
                MacChatComposer(
                    sessionId: sessionId,
                    pendingPermission: viewModel.permissions.first,
                    pendingQuestion: viewModel.questions.first,
                    isCompacting: viewModel.isCompacting,
                    hasLiveCard: viewModel.card != nil
                )
            }
        }
    }

    private func emptyConversationState(_ viewModel: ChatViewModel) -> some View {
        VStack(spacing: 10) {
            Image(systemName: viewModel.isDeviceOnline ? "bubble.left" : "wifi.slash")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Color.textMuted)
            Text("No conversation messages")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.textTitle)
            Text(
                viewModel.isDeviceOnline
                    ? "This session has no messages to display yet."
                    : "The session device is offline and no cached conversation is available."
            )
            .font(.system(size: 12))
            .foregroundStyle(Color.textSecondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: 360)
        }
        .padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
    }

    private func reanchorNewest(_ viewModel: ChatViewModel) {
        let head = viewModel.sessionLastSeq
        let bottom = viewModel.windowBottomSeq
        let gap = head - bottom
        if bottom > 0, head > 0, gap <= 2_000 {
            var pages = 0
            while viewModel.windowBottomSeq < head, pages < 12 {
                guard viewModel.pageNewerRaw() else { break }
                pages += 1
            }
        } else {
            viewModel.jumpToHead()
        }
        viewModel.refreshMessageCache()
    }

    private func liveCardForList(_ viewModel: ChatViewModel) -> MessageStore.SessionCard? {
        guard let card = viewModel.card else { return nil }
        return !card.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || card.action != nil
            ? card
            : nil
    }

    private func resolveLivePermission(_ permissionId: String, toolName: String?, _ decision: String) {
        switch decision {
        case "approve":
            appState.commandSender?.approve(sessionId: sessionId, permissionId: permissionId)
        case "execute":
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

/// Compact Mac presentation of the same information/actions exposed by the iOS
/// SessionInfoSheet. Kept local to the chat chrome so the More button is not a
/// dead affordance on macOS.
private struct MacSessionInfoSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    let session: SessionInfo

    @State private var editingTitle = false
    @State private var titleDraft = ""
    @State private var showDeleteConfirmation = false
    @FocusState private var titleFocused: Bool

    private var currentMode: SessionMode {
        appState.sessionStore.sessionModes[session.id] ?? session.mode
    }
    private var usage: SessionUsage? {
        appState.sessionStore.sessionUsage[session.id] ?? session.usage
    }
    private var device: DeviceSummary? {
        appState.deviceStore.devices[session.deviceId]
    }
    private var version: String? {
        appState.deviceStore.deviceVersions[session.deviceId]
    }
    private var availableModels: [String] {
        appState.deviceStore.models(for: session.deviceId, agentId: session.agent)
    }
    private var contextWindow: Int? {
        guard let model = session.model else { return nil }
        return appState.deviceStore
            .modelDetails(for: session.deviceId, agentId: session.agent)
            .first(where: { $0.id == model })?.contextWindow
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Session Info").font(.system(size: 17, weight: .semibold))
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    modeSection
                    sessionSection
                    if let usage { usageSection(usage) }
                    if let device { deviceSection(device) }
                    actionsSection
                }
                .padding(20)
            }
        }
        .frame(width: 440, height: 580)
        .background(Color.surfacePrimary)
        .confirmationDialog(
            "Delete Session",
            isPresented: $showDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                appState.commandSender?.deleteSession(sessionId: session.id)
                dismiss()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete this session and all its messages.")
        }
    }

    private var modeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("Mode")
            Picker("Mode", selection: Binding(
                get: { currentMode },
                set: { appState.commandSender?.setSessionMode(sessionId: session.id, mode: $0) }
            )) {
                ForEach([SessionMode.safe, .discuss, .execute, .delegate], id: \.self) { mode in
                    Text(mode.rawValue.capitalized).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .tint(Color.modeColor(currentMode))
        }
    }

    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Session")
            infoRow(label: "Title") {
                if editingTitle {
                    TextField("Session title", text: $titleDraft)
                        .multilineTextAlignment(.trailing)
                        .focused($titleFocused)
                        .onSubmit { commitTitleEdit() }
                        .onChange(of: titleFocused) { _, focused in
                            if !focused && editingTitle { commitTitleEdit() }
                        }
                } else {
                    Button {
                        titleDraft = session.title ?? session.autoTitle ?? ""
                        editingTitle = true
                        DispatchQueue.main.async { titleFocused = true }
                    } label: {
                        HStack(spacing: 4) {
                            Text(session.displayTitle).lineLimit(1).truncationMode(.middle)
                            LucideIcon(.pencil, size: 11, strokeWidth: 2, color: .secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            infoRow("Agent", session.agent)
            infoRow(label: "Model") {
                if availableModels.isEmpty {
                    Text(session.model ?? "—")
                } else {
                    Picker("", selection: Binding(
                        get: { session.model ?? availableModels.first ?? "" },
                        set: { appState.commandSender?.setSessionModel(sessionId: session.id, model: $0) }
                    )) {
                        ForEach(availableModels, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 250, alignment: .trailing)
                }
            }
            infoRow("Created", session.createdAt.formatted(date: .abbreviated, time: .shortened))
        }
    }

    private func usageSection(_ usage: SessionUsage) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Usage")
            if let used = usage.contextTokens {
                if let ceiling = contextWindow, ceiling > 0 {
                    let ratio = min(1, Double(used) / Double(ceiling))
                    let context = "\(macFormatTokenCount(used)) / \(macFormatTokenCount(ceiling))  ·  \(Int((ratio * 100).rounded()))%"
                    VStack(alignment: .leading, spacing: 6) {
                        infoRow("Context", context)
                        ProgressView(value: ratio).tint(contextBandColor(ratio))
                    }
                } else {
                    infoRow("Context", macFormatTokenCount(used))
                }
            }
            infoRow("Input tokens", macFormatTokenCount(usage.inputTokens))
            infoRow("Output tokens", macFormatTokenCount(usage.outputTokens))
            infoRow("Cache read", macFormatTokenCount(usage.cacheReadTokens))
            infoRow("Cache write", macFormatTokenCount(usage.cacheWriteTokens))
            Divider()
            infoRow("Total cost", macFormatCost(usage.totalCost))
            infoRow("Duration", macFormatDuration(usage.totalDurationMs))
        }
    }

    private func deviceSection(_ device: DeviceSummary) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            sectionHeader("Device")
            infoRow("Name", device.name)
            infoRow(label: "Status") {
                HStack(spacing: 4) {
                    Circle().fill(device.online ? Color.green : Color.gray).frame(width: 6, height: 6)
                    Text(device.online ? "Online" : "Offline")
                }
            }
            if let version { infoRow("Version", version) }
        }
    }

    private var actionsSection: some View {
        HStack(spacing: 12) {
            Button {
                appState.commandSender?.forkSession(sessionId: session.id)
                dismiss()
            } label: {
                HStack(spacing: 5) {
                    LucideIcon(.gitFork, size: 16, color: .krakiPrimary)
                    Text("Fork")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.krakiPrimary)

            Button(role: .destructive) { showDeleteConfirmation = true } label: {
                Label("Delete", systemImage: "trash").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .tint(.red)
        }
    }

    private func commitTitleEdit() {
        let trimmed = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.renameSession(sessionId: session.id, title: trimmed)
        editingTitle = false
        titleFocused = false
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.caption.weight(.semibold))
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
    }

    private func infoRow(_ label: String, _ value: String) -> some View {
        infoRow(label: label) { Text(value).multilineTextAlignment(.trailing) }
    }

    private func infoRow<Trailing: View>(
        label: String,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: 8) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            trailing()
        }
        .font(.system(size: 15))
        .contentShape(Rectangle())
    }

    private func macFormatTokenCount(_ count: Int) -> String {
        if count < 1_000 { return "\(count)" }
        if count < 1_000_000 {
            let value = Double(count) / 1_000
            return value < 10 ? String(format: "%.1fK", value) : String(format: "%.0fK", value)
        }
        let value = Double(count) / 1_000_000
        return value < 10 ? String(format: "%.1fM", value) : String(format: "%.0fM", value)
    }

    private func macFormatCost(_ cost: Double) -> String {
        cost < 0.01 ? String(format: "$%.4f", cost) : String(format: "$%.3f", cost)
    }

    private func macFormatDuration(_ milliseconds: Double) -> String {
        let seconds = milliseconds / 1_000
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return "\(Int(seconds) / 60)m \(Int(seconds) % 60)s"
    }

    private func contextBandColor(_ ratio: Double) -> Color {
        if ratio >= 0.85 { return .red }
        if ratio >= 0.60 { return Color(hex: 0xFBBF24) }
        return .green
    }
}
#endif
