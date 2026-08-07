#if os(macOS)
import AppKit
import CoreText
import SwiftUI
import UniformTypeIdentifiers

private enum MacComposerIntent: Equatable {
    case prompt
    case steer
    case answerQuestion
    case denyPermission
}

/// macOS counterpart of the production iOS `MessageInputView`.
///
/// The view intentionally keeps the same hierarchy and constants: a floating
/// row with an image circle, one unified 42pt liquid-glass input capsule, and
/// an optional 42pt stop circle. Permission/question controls remain in the
/// live bubble; the composer only changes its textual submission intent.
struct MacChatComposer: View {
    let sessionId: String
    var pendingPermission: PendingPermission? = nil
    var pendingQuestion: PendingQuestion? = nil
    var isCompacting = false
    var hasLiveCard = false

    @Environment(AppState.self) private var appState
    @State private var imageData: Data?
    @State private var previewImage: NSImage?
    @State private var imageMimeType = "image/jpeg"
    @State private var imageAttachError: String?
    @State private var awaitingActive = false
    @State private var abortPending = false
    @State private var voiceDraftPrefix = ""
    @State private var composerFocusRequest = 0
    @State private var isFocused = false

    // Mode swipe state — mirrors iOS MessageInputView.
    @State private var rawDragX: CGFloat = 0
    @State private var dragStartMode: SessionMode?
    @State private var measuredInputBoxWidth: CGFloat = 0
    @State private var showModeToast = false
    @State private var modeToastMode: SessionMode = .discuss
    @State private var modeToastTask: Task<Void, Never>?

    init(
        sessionId: String,
        pendingPermission: PendingPermission? = nil,
        pendingQuestion: PendingQuestion? = nil,
        isCompacting: Bool = false,
        hasLiveCard: Bool = false,
        initialImageData: Data? = nil
    ) {
        self.sessionId = sessionId
        self.pendingPermission = pendingPermission
        self.pendingQuestion = pendingQuestion
        self.isCompacting = isCompacting
        self.hasLiveCard = hasLiveCard
        _imageData = State(initialValue: initialImageData)
        _previewImage = State(initialValue: initialImageData.flatMap(NSImage.init(data:)))
    }

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]
    private static let inputBoxHeight: CGFloat = 42
    private static let voiceStartSound: NSSound? = {
        let sound = NSSound(
            contentsOfFile: "/System/Library/Sounds/Hero.aiff",
            byReference: false
        )
        sound?.volume = 1.0
        return sound
    }()
    private static let commitDistanceFraction: CGFloat = 0.4
    private static let momentumVelocity: CGFloat = 500

    private var sessionStore: SessionStore { appState.sessionStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var sessionActive: Bool {
        session?.state == .active || session?.state == .compacting
    }
    private var isBusy: Bool { sessionActive || isCompacting || awaitingActive }
    private var isIdle: Bool { !isBusy }
    private var isStructuredResponse: Bool { pendingPermission != nil || pendingQuestion != nil }
    private var submissionIntent: MacComposerIntent {
        if pendingPermission != nil { return .denyPermission }
        if pendingQuestion != nil { return .answerQuestion }
        return isBusy ? .steer : .prompt
    }
    private var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    private var hasImage: Bool { imageData != nil }
    private var voiceController: KrakiVoiceInputController { appState.voiceInputController }
    private var voiceOwnsComposer: Bool {
        voiceController.isBusy && voiceController.activeSessionID == sessionId
    }
    private var canSend: Bool {
        !voiceOwnsComposer && (isStructuredResponse ? hasText : (hasText || hasImage))
    }
    private var canShowVoice: Bool {
        VoiceComposerAccessPolicy.isVisible(
            capabilityAvailable: appState.voiceCapability != nil
        )
    }
    private var canStartVoice: Bool {
        VoiceComposerAccessPolicy.canStart(
            capabilityAvailable: appState.voiceCapability != nil,
            voiceControllerBusy: voiceController.isBusy
        )
    }
    private var canShowAbort: Bool { sessionActive || isCompacting || hasLiveCard }
    private var isVoiceFailure: Bool {
        if case .failed = voiceController.state { return true }
        return false
    }

    private var currentSessionMode: SessionMode {
        sessionStore.sessionModes[sessionId] ?? session?.mode ?? .discuss
    }
    private var tintBaseMode: SessionMode { dragStartMode ?? currentSessionMode }
    private var modeStepWidth: CGFloat { max(80, measuredInputBoxWidth) }

    private var isDeviceReachable: Bool {
        guard let deviceId = session?.deviceId,
              let device = appState.deviceStore.devices[deviceId] else { return false }
        return device.online && appState.isFullyOnline
    }

    private var unreachableHint: String? {
        guard let deviceId = session?.deviceId else { return nil }
        let device = appState.deviceStore.devices[deviceId]
        if device?.online != true {
            let name = device?.name ?? session?.deviceName ?? "Device"
            return "\(name) is offline — message will deliver when it reconnects."
        }
        if !appState.isFullyOnline { return "Reconnecting…" }
        return nil
    }

    var body: some View {
        composeCard
            .overlay(alignment: .topTrailing) {
                modeToast
                    .offset(x: -23, y: -32)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .top) {
                unreachableHintPill
                    .offset(y: -28)
                    .allowsHitTesting(false)
            }
            .onChange(of: session?.state) { _, newState in
                awaitingActive = false
                if newState == .idle { abortPending = false }
            }
            .onChange(of: appState.isFullyOnline) { _, online in
                if !online { abortPending = false }
            }
            .task(id: sessionId) {
                if let activeVoiceSession = voiceController.activeSessionID,
                   activeVoiceSession != sessionId {
                    voiceController.cancel()
                }
                // Session selection should land ready to type, but never steal
                // focus from another application during a background restart or
                // semantic automation run. Wait for the floating composer/TextField
                // to join the key window, then focus only while Kraki is active.
                for _ in 0..<6 {
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    if NSApp.isActive,
                       let window = NSApp.keyWindow,
                       window.isKeyWindow {
                        isFocused = true
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(35))
                }
            }
            .onDisappear {
                if voiceController.activeSessionID == sessionId {
                    voiceController.cancel()
                }
            }
            .background {
                MacComposerVoiceKeyProbe(
                    enabled: canShowVoice,
                    voiceActive: voiceOwnsComposer,
                    onToggle: handleVoiceButton,
                    onCancel: {
                        if voiceController.activeSessionID == sessionId {
                            voiceController.cancel()
                            if NSApp.isActive, NSApp.keyWindow?.isKeyWindow == true {
                                isFocused = true
                            }
                        }
                    }
                )
                .frame(width: 0, height: 0)
            }
            .background {
                MacComposerPasteProbe(
                    enabled: isFocused && isIdle,
                    onPasteImage: { image in
                        attachImage(image)
                        requestComposerFocus()
                    }
                )
                .frame(width: 0, height: 0)
            }
            .alert(
                "Couldn't attach image",
                isPresented: Binding(
                    get: { imageAttachError != nil },
                    set: { if !$0 { imageAttachError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { imageAttachError = nil }
            } message: {
                Text(imageAttachError ?? "")
            }
    }

    private var composeCard: some View {
        VStack(spacing: 8) {
            if isVoiceFailure { voiceFailureRow }
            inputRow
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity)
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            imageAttachButton
            inputBox
            if canShowAbort { abortButton }
        }
    }

    private var inputBox: some View {
        Group {
            if voiceOwnsComposer {
                MacComposerVoiceSurface(
                    controller: voiceController,
                    draftPrefix: voiceDraftPrefix,
                    onFinish: { voiceController.finish() }
                )
            } else {
                HStack(alignment: .center, spacing: 0) {
                    textFieldForMode
                    if canShowVoice { inlineVoiceButton }
                    sendIconButton
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: Self.inputBoxHeight)
        .background { inputBoxGlassBackground }
        .contentShape(RoundedRectangle(cornerRadius: Self.inputBoxHeight / 2, style: .continuous))
        .simultaneousGesture(inputBoxModeSwipeGesture)
        .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
    }

    @ViewBuilder
    private var inputBoxGlassBackground: some View {
        let shape = RoundedRectangle(cornerRadius: Self.inputBoxHeight / 2, style: .continuous)
        ZStack(alignment: .bottom) {
            if #available(macOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: shape)
            } else {
                shape.fill(.ultraThinMaterial)
            }
            swipeBottomStrip
                .clipShape(shape)
                .allowsHitTesting(false)
        }
    }

    private var swipeBottomStrip: some View {
        GeometryReader { proxy in
            let modes = Self.allModes
            let count = modes.count
            let baseIndex = modes.firstIndex(of: tintBaseMode) ?? 1
            let previousIndex = ((baseIndex - 1) % count + count) % count
            let nextIndex = ((baseIndex + 1) % count + count) % count
            let width = proxy.size.width
            HStack(spacing: 0) {
                Color.modeColor(modes[previousIndex]).opacity(0.95)
                    .frame(width: width, height: 1.5)
                Color.modeColor(modes[baseIndex]).opacity(0.95)
                    .frame(width: width, height: 1.5)
                Color.modeColor(modes[nextIndex]).opacity(0.95)
                    .frame(width: width, height: 1.5)
            }
            .offset(x: -width + rawDragX)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .onAppear { measuredInputBoxWidth = width }
            .onChange(of: width) { _, newWidth in measuredInputBoxWidth = newWidth }
        }
    }

    private var inputBoxModeSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                if dragStartMode == nil {
                    let dx = value.translation.width
                    let dy = value.translation.height
                    guard abs(dx) > abs(dy) else { return }
                }
                handleModeSwipeChanged(value.translation.width)
            }
            .onEnded { value in
                guard dragStartMode != nil else { return }
                handleModeSwipeEnded(value.velocity.width)
            }
    }

    private var textFieldForMode: some View {
        let placeholder: String = {
            switch submissionIntent {
            case .denyPermission: return "Deny with reason…"
            case .answerQuestion: return "Type your answer…"
            case .steer: return "Steer the agent…"
            case .prompt: return "Send a message…"
            }
        }()

        return ZStack(alignment: .leading) {
            Text(placeholder)
                .font(.system(size: 15))
                .foregroundStyle(.tertiary)
                .padding(.leading, 18)
                .opacity(text.isEmpty ? 1 : 0)
                .allowsHitTesting(false)
            MacComposerScrollableTextInput(
                text: Binding(
                    get: { text },
                    set: { sessionStore.setDraft(sessionId, $0) }
                ),
                focused: Binding(
                    get: { isFocused },
                    set: { isFocused = $0 }
                ),
                enabled: !voiceOwnsComposer,
                focusRequest: composerFocusRequest,
                onRequestFocus: requestComposerFocus,
                onSubmit: handleModeSubmit
            )
            .padding(.leading, 14)
            .padding(.trailing, 4)
        }
        .frame(maxWidth: .infinity)
        .onPasteCommand(
            of: [.image, .fileURL],
            validator: { providers in
                guard isIdle else { return nil }
                return providers.first(where: { provider in
                    provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
                        || provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
                })
            },
            perform: loadPastedImage
        )
    }

    private var sendIconButton: some View {
        Button(action: handleModeSubmit) {
            Image(systemName: "arrow.right")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(Color.modeColor(currentSessionMode))
                .frame(width: 34, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
                .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .opacity(sendButtonOpacity)
        .padding(.trailing, 6)
        .accessibilityLabel(sendAccessibilityLabel)
        .accessibilityHint(sendAccessibilityHint)
    }

    private var sendButtonOpacity: Double {
        if !canSend { return 0.4 }
        if !isDeviceReachable { return 0.5 }
        return 1
    }

    private var sendAccessibilityLabel: String {
        switch submissionIntent {
        case .answerQuestion: return "Submit answer"
        case .denyPermission: return "Deny with reason"
        case .steer: return "Steer agent"
        case .prompt: return "Send message"
        }
    }

    private var sendAccessibilityHint: String {
        switch submissionIntent {
        case .answerQuestion: return "Answers the pending question"
        case .denyPermission: return "Denies the permission with this reason"
        case .steer: return "Interjects into the active agent turn"
        case .prompt: return "Sends the current message"
        }
    }

    private var inlineVoiceButton: some View {
        Button(action: handleVoiceButton) {
            Image(systemName: "mic.fill")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canStartVoice)
        .opacity(canStartVoice ? 1 : 0.4)
        .accessibilityLabel("Start voice input")
        .accessibilityHint("Click or press Option-Space to dictate into this draft")
    }

    @ViewBuilder
    private var voiceFailureRow: some View {
        HStack(spacing: 8) {
            Text(voiceStatusText)
                .font(.system(size: 12))
                .foregroundStyle(Color.red)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss") { voiceController.clearFailure() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Capsule(style: .continuous).fill(.ultraThinMaterial))
        .padding(.horizontal, 48)
    }

    private var voiceStatusText: String {
        VoiceComposerPresentation.statusText(
            state: voiceController.state,
            rawText: voiceController.rawText,
            displayText: voiceController.displayText
        )
    }

    private func requestComposerFocus() {
        isFocused = true
        composerFocusRequest &+= 1
    }

    private func handleVoiceButton() {
        if voiceController.activeSessionID == sessionId {
            if voiceController.isRecording { voiceController.finish() }
            return
        }
        guard canStartVoice, let session else { return }
        Self.playVoiceStartCue()
        voiceController.clearFailure()
        let existingDraft = text
        voiceDraftPrefix = existingDraft
        isFocused = false
        let voiceContext = VoiceSessionContextBuilder.build(
            session: session,
            recentMessages: appState.messageStore.recentFromDB(sessionId, limit: 20)
        )
        Task { @MainActor in
            await voiceController.begin(
                sessionID: sessionId,
                context: voiceContext,
                onFinal: { final in
                    guard appState.sessionStore.sessions[sessionId] != nil else { return }
                    appState.sessionStore.setDraft(
                        sessionId,
                        VoiceDraftMerger.merge(existing: existingDraft, final: final)
                    )
                    voiceDraftPrefix = ""
                    if NSApp.isActive, NSApp.keyWindow?.isKeyWindow == true {
                        isFocused = true
                    }
                }
            )
        }
    }

    private static func playVoiceStartCue() {
        guard let sound = voiceStartSound else {
            KLog.diag("🎙️ [voice] start cue unavailable; using system alert")
            NSSound.beep()
            return
        }
        sound.stop()
        let played = sound.play()
        KLog.diag("🎙️ [voice] start cue played=\(played)")
        if !played { NSSound.beep() }
    }

    private var abortButton: some View {
        Button(action: requestAbort) {
            Group {
                if abortPending {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.red)
                }
            }
            .frame(width: Self.inputBoxHeight, height: Self.inputBoxHeight)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .background(.ultraThinMaterial, in: Circle())
        .disabled(abortPending || !isDeviceReachable)
        .opacity(isDeviceReachable ? 1 : 0.5)
        .accessibilityLabel("Stop agent")
        .accessibilityHint("Aborts the current agent turn")
    }

    private var imageAttachButton: some View {
        Group {
            if let previewImage {
                ZStack(alignment: .topTrailing) {
                    Button(action: chooseImage) {
                        Image(nsImage: previewImage)
                            .resizable()
                            .scaledToFill()
                            .frame(height: Self.inputBoxHeight)
                            .frame(maxWidth: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain)
                    Button(action: clearImage) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .offset(x: 4, y: -4)
                }
            } else {
                Button(action: chooseImage) {
                    LucideIcon(.imagePlus, size: 22, strokeWidth: 2.25, color: .secondary)
                        .frame(width: Self.inputBoxHeight, height: Self.inputBoxHeight)
                        .modifier(MacGlassCircleModifier())
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .disabled(!isIdle || voiceOwnsComposer)
        .opacity(isIdle && !voiceOwnsComposer ? 1 : 0.4)
        .accessibilityLabel("Attach image")
        .accessibilityValue(previewImage == nil ? "No image selected" : "Image selected")
    }

    private func requestAbort() {
        guard canShowAbort, !abortPending, isDeviceReachable else { return }
        if appState.commandSender?.abortSession(sessionId: sessionId) == true {
            abortPending = true
        }
    }

    private func handleModeSubmit() {
        switch submissionIntent {
        case .denyPermission:
            guard hasText, let permission = pendingPermission else { return }
            let reason = text.trimmingCharacters(in: .whitespacesAndNewlines)
            appState.commandSender?.deny(
                sessionId: sessionId,
                permissionId: permission.id,
                reason: reason
            )
            sessionStore.setDraft(sessionId, "")
            isFocused = false
        case .answerQuestion:
            guard hasText, let question = pendingQuestion else { return }
            let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
            appState.commandSender?.answer(
                sessionId: sessionId,
                questionId: question.id,
                answer: answer,
                wasFreeform: true
            )
            sessionStore.setDraft(sessionId, "")
            isFocused = false
        case .prompt, .steer:
            handleSend()
        }
    }

    private func handleSend() {
        guard canSend else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sendText = trimmed.isEmpty ? "[image]" : trimmed
        let attachments = imageData.map {
            [ImageAttachment(type: "image", mimeType: imageMimeType, data: $0.base64EncodedString())]
        }
        let delivery: CommandSender.InputDelivery = submissionIntent == .steer ? .steer : .prompt
        guard appState.commandSender?.sendInput(
            sessionId: sessionId,
            text: sendText,
            attachments: attachments,
            delivery: delivery
        ) == true else { return }

        sessionStore.setDraft(sessionId, "")
        clearImage()
        if delivery == .prompt { awaitingActive = true }
        isFocused = false
    }

    private func handleModeSwipeChanged(_ dx: CGFloat) {
        if dragStartMode == nil { dragStartMode = currentSessionMode }
        let limit = modeStepWidth
        if abs(dx) <= limit {
            rawDragX = dx
        } else {
            let excess = abs(dx) - limit
            let rubber = excess / (1 + excess / 80) * 0.4
            rawDragX = (dx > 0 ? 1 : -1) * (limit + rubber)
        }
    }

    private func handleModeSwipeEnded(_ velocity: CGFloat) {
        let modes = Self.allModes
        let count = modes.count
        let baseMode = dragStartMode ?? currentSessionMode
        let baseIndex = modes.firstIndex(of: baseMode) ?? 1
        let dx = rawDragX
        let distanceCommit = abs(dx) >= Self.commitDistanceFraction * modeStepWidth
        let velocityCommit = abs(velocity) >= Self.momentumVelocity
            && dx != 0
            && (velocity > 0) == (dx > 0)
        let commitStep = distanceCommit || velocityCommit ? (dx > 0 ? -1 : 1) : 0
        let targetOffset: CGFloat = commitStep == 0 ? 0 : -CGFloat(commitStep) * modeStepWidth

        if commitStep != 0 {
            let targetIndex = ((baseIndex + commitStep) % count + count) % count
            let mode = modes[targetIndex]
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
            appState.commandSender?.setSessionMode(sessionId: sessionId, mode: mode)
            presentModeToast(mode)
        }

        let remaining = targetOffset - rawDragX
        let normalizedVelocity = remaining == 0 ? 0 : Double(velocity / remaining)
        let spring: Animation = .interpolatingSpring(
            mass: 1,
            stiffness: 180,
            damping: 22,
            initialVelocity: normalizedVelocity
        )
        withAnimation(spring) {
            rawDragX = targetOffset
        } completion: {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                dragStartMode = nil
                rawDragX = 0
            }
        }
    }

    private func presentModeToast(_ mode: SessionMode) {
        modeToastMode = mode
        modeToastTask?.cancel()
        withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
            showModeToast = true
        }
        modeToastTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1300))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { showModeToast = false }
        }
    }

    @ViewBuilder
    private var modeToast: some View {
        if showModeToast {
            MacModeChangeToast(mode: modeToastMode)
                .transition(.asymmetric(
                    insertion: .scale(scale: 0.85, anchor: .bottom).combined(with: .opacity),
                    removal: .opacity.combined(with: .scale(scale: 0.92, anchor: .bottom))
                ))
        }
    }

    @ViewBuilder
    private var unreachableHintPill: some View {
        if let hint = unreachableHint {
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(Capsule(style: .continuous).fill(.ultraThinMaterial))
                .padding(.horizontal, 16)
                .transition(.opacity.combined(with: .offset(y: 4)))
                .animation(.easeInOut(duration: 0.2), value: hint)
        }
    }

    private func chooseImage() {
        guard isIdle else { return }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowedContentTypes = [.image]
        panel.title = "Attach Image"
        let completion: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .OK, let url = panel.url else { return }
            loadImage(url)
        }
        if let window = NSApp.keyWindow ?? NSApp.mainWindow {
            panel.beginSheetModal(for: window, completionHandler: completion)
        } else {
            panel.begin(completionHandler: completion)
        }
    }

    private func loadImage(_ url: URL) {
        guard let image = NSImage(contentsOf: url) else {
            imageAttachError = "That file isn't a supported image format."
            return
        }
        attachImage(image)
    }

    private func loadPastedImage(_ provider: NSItemProvider) {
        if let imageType = provider.registeredTypeIdentifiers.first(where: { identifier in
            UTType(identifier)?.conforms(to: .image) == true
        }) {
            provider.loadDataRepresentation(forTypeIdentifier: imageType) { data, _ in
                Task { @MainActor in
                    guard let data, let image = NSImage(data: data) else {
                        imageAttachError = "The clipboard image couldn't be read."
                        return
                    }
                    attachImage(image)
                    isFocused = true
                }
            }
            return
        }

        provider.loadDataRepresentation(forTypeIdentifier: UTType.fileURL.identifier) { data, _ in
            Task { @MainActor in
                guard let data,
                      let string = String(data: data, encoding: .utf8),
                      let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
                      url.isFileURL else {
                    imageAttachError = "The clipboard doesn't contain a readable image."
                    return
                }
                loadImage(url)
                isFocused = true
            }
        }
    }

    private func attachImage(_ image: NSImage) {
        let maxSize = 3 * 1024 * 1024
        for quality in [0.8, 0.6] {
            if let data = Self.jpegData(from: image, maxDimension: 1024, quality: quality),
               data.count <= maxSize {
                imageData = data
                previewImage = NSImage(data: data)
                imageMimeType = "image/jpeg"
                return
            }
        }
        imageAttachError = "That image is too large to send (over 3 MB after compression). Try a smaller picture."
        clearImage()
    }

    private func clearImage() {
        imageData = nil
        previewImage = nil
    }

    private static func jpegData(from image: NSImage, maxDimension: CGFloat, quality: CGFloat) -> Data? {
        let source = image.size
        guard source.width > 0, source.height > 0 else { return nil }
        let scale = min(1, maxDimension / max(source.width, source.height))
        let target = NSSize(width: max(1, source.width * scale), height: max(1, source.height * scale))
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(target.width.rounded()),
            pixelsHigh: Int(target.height.rounded()),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { return nil }
        bitmap.size = target
        NSGraphicsContext.saveGraphicsState()
        guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
            NSGraphicsContext.restoreGraphicsState()
            return nil
        }
        NSGraphicsContext.current = context
        image.draw(
            in: NSRect(origin: .zero, size: target),
            from: NSRect(origin: .zero, size: source),
            operation: .copy,
            fraction: 1
        )
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality])
    }
}

// MARK: - Scrollable native Composer text input

private final class MacComposerTextView: NSTextView {
    var onSubmit: (() -> Void)?
    var onPasteCompleted: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if (event.keyCode == 36 || event.keyCode == 76),
           !flags.contains(.shift),
           !hasMarkedText() {
            onSubmit?()
            return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        super.paste(sender)
        onPasteCompleted?()
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  let window = self.window,
                  window.isKeyWindow,
                  window.firstResponder !== self else { return }
            window.makeFirstResponder(self)
        }
    }
}

private struct MacComposerScrollableTextInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    let enabled: Bool
    let focusRequest: Int
    let onRequestFocus: () -> Void
    let onSubmit: () -> Void

    private static let font = NSFont.systemFont(ofSize: 15)
    private static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    private static let verticalPadding: CGFloat = 4

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacComposerScrollableTextInput
        weak var scrollView: NSScrollView?
        weak var textView: MacComposerTextView?
        var isApplying = false
        var wasComposing = false
        var appliedFocusRequest = -1

        init(_ parent: MacComposerScrollableTextInput) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard !isApplying,
                  let textView = notification.object as? MacComposerTextView else { return }
            textView.scrollRangeToVisible(textView.selectedRange())
            // Do not round-trip marked IME text through SwiftUI. Replacing the
            // backing string while a Chinese/Japanese composition is active
            // commits or discards the input session and can resign first
            // responder. Publish only the committed value.
            if textView.hasMarkedText() {
                wasComposing = true
                return
            }
            let committedComposition = wasComposing
            wasComposing = false
            if parent.text != textView.string {
                parent.text = textView.string
            }
            guard committedComposition else { return }
            // Publishing the committed IME value may make SwiftUI replace the
            // representable. Wait until that transaction settles; request focus
            // only if the live native editor actually lost first responder.
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self, let textView else { return }
                if let window = textView.window,
                   window.isKeyWindow,
                   window.firstResponder === textView {
                    return
                }
                self.parent.onRequestFocus()
                self.restoreCurrentTextViewFocus(attemptsRemaining: 4)
            }
        }

        func textDidBeginEditing(_ notification: Notification) {
            if !parent.focused { parent.focused = true }
        }

        func textDidEndEditing(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            // A teardown notification from an obsolete native view must not
            // clear FocusState. A genuine responder move from the current live
            // editor can be decided immediately; a transient nil responder is
            // checked once after AppKit finishes the handoff.
            guard textView === self.textView,
                  let window = textView.window,
                  self.parent.focused else { return }
            if window.firstResponder is MacComposerTextView { return }
            if let externalView = window.firstResponder as? NSView,
               externalView !== textView {
                self.parent.focused = false
                return
            }
            DispatchQueue.main.async { [weak self, weak textView] in
                guard let self,
                      let textView,
                      textView === self.textView,
                      let window = textView.window,
                      !(window.firstResponder is MacComposerTextView),
                      self.parent.focused else { return }
                self.parent.focused = false
            }
        }

        func restoreFocusAfterPaste() {
            parent.onRequestFocus()
            restoreCurrentTextViewFocus(attemptsRemaining: 3)
        }

        func restoreCurrentTextViewFocus(attemptsRemaining: Int) {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if let textView = self.textView,
                   let window = textView.window,
                   window.isKeyWindow,
                   self.parent.focused {
                    if window.firstResponder !== textView {
                        window.makeFirstResponder(textView)
                    }
                    if window.firstResponder === textView { return }
                }
                guard attemptsRemaining > 1 else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
                    self?.restoreCurrentTextViewFocus(attemptsRemaining: attemptsRemaining - 1)
                }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView(frame: .zero)
        scrollView.drawsBackground = false
        scrollView.contentView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasHorizontalScroller = false
        scrollView.hasVerticalScroller = false
        scrollView.horizontalScroller = nil
        scrollView.verticalScroller = nil
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .automatic
        scrollView.horizontalScrollElasticity = .none

        let textView = MacComposerTextView(frame: .zero)
        textView.delegate = context.coordinator
        textView.onSubmit = onSubmit
        textView.onPasteCompleted = { [weak coordinator = context.coordinator] in
            coordinator?.restoreFocusAfterPaste()
        }
        textView.drawsBackground = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.font = Self.font
        textView.textColor = .labelColor
        textView.insertionPointColor = .labelColor
        textView.textContainerInset = NSSize(width: 4, height: Self.verticalPadding)
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.heightTracksTextView = false
        textView.textContainer?.lineFragmentPadding = 0
        textView.string = text
        scrollView.documentView = textView
        context.coordinator.scrollView = scrollView
        context.coordinator.textView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? MacComposerTextView else { return }
        textView.onSubmit = onSubmit
        textView.onPasteCompleted = { [weak coordinator = context.coordinator] in
            coordinator?.restoreFocusAfterPaste()
        }
        textView.isEditable = enabled
        textView.isSelectable = enabled
        if textView.string != text, !textView.hasMarkedText() {
            context.coordinator.isApplying = true
            let selection = textView.selectedRange()
            textView.string = text
            textView.setSelectedRange(NSRange(location: min(selection.location, textView.string.utf16.count), length: 0))
            context.coordinator.isApplying = false
        }
        let layoutText = textView.hasMarkedText() ? textView.string : text
        let measuredHeight = Self.measuredHeight(layoutText, width: max(1, scrollView.contentSize.width))
        textView.frame = NSRect(
            x: 0,
            y: 0,
            width: max(1, scrollView.contentSize.width),
            height: max(measuredHeight, scrollView.contentSize.height)
        )
        // Keep the three-line editor internally scrollable without ever
        // exposing an AppKit scrollbar. NSClipView still follows the insertion
        // point; removing the scroller objects prevents system settings from
        // reserving or flashing a track inside the floating Composer.
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.verticalScroller = nil
        scrollView.horizontalScroller = nil

        let hasExplicitFocusRequest = context.coordinator.appliedFocusRequest != focusRequest
        context.coordinator.appliedFocusRequest = focusRequest
        DispatchQueue.main.async { [weak scrollView, weak textView, weak coordinator = context.coordinator] in
            guard let scrollView, let textView, let window = scrollView.window else { return }
            if focused {
                if window.isKeyWindow, window.firstResponder !== textView {
                    window.makeFirstResponder(textView)
                }
                if hasExplicitFocusRequest, window.firstResponder !== textView {
                    coordinator?.restoreCurrentTextViewFocus(attemptsRemaining: 3)
                }
            } else if window.firstResponder === textView {
                window.makeFirstResponder(nil)
            }
            textView.scrollRangeToVisible(textView.selectedRange())
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: NSScrollView,
        context: Context
    ) -> CGSize? {
        let width = max(1, proposal.width ?? nsView.frame.width)
        let measured = Self.measuredHeight(text, width: width)
        let minHeight = Self.lineHeight + Self.verticalPadding * 2
        let maxHeight = Self.lineHeight * 3 + Self.verticalPadding * 2
        return CGSize(width: width, height: min(max(measured, minHeight), maxHeight))
    }

    private static func measuredHeight(_ text: String, width: CGFloat) -> CGFloat {
        let attributed = NSAttributedString(
            string: text.isEmpty ? " " : text,
            attributes: [.font: font]
        )
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: attributed.length),
            nil,
            CGSize(width: max(1, width - 8), height: .greatestFiniteMagnitude),
            nil
        )
        return ceil(suggested.height) + verticalPadding * 2
    }
}

// MARK: - Inline VoiceType transcript surface

private struct MacComposerVoiceSurface: View {
    let controller: KrakiVoiceInputController
    let draftPrefix: String
    let onFinish: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            MacComposerVoiceTranscript(pieces: displayedPieces, revision: revision)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onFinish) {
                VoiceComposerStatusModule(state: controller.state)
                    .frame(width: 38, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!controller.isRecording)
            .accessibilityLabel(controller.isRecording ? "Stop voice input" : "Correcting voice input")
            .accessibilityHint(controller.isRecording ? "Stops recording and starts transcription correction" : "")
        }
        .padding(.leading, 18)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
    }

    private var revision: String {
        "\(draftPrefix)-\(controller.state)-\(controller.rawText)-\(controller.correctionText)-\(controller.correctionSourceOffset)"
    }

    private var displayedPieces: [(text: String, opacity: Double)] {
        VoiceComposerPresentation.transcriptPieces(
            prefix: draftPrefix,
            state: controller.state,
            rawText: controller.rawText,
            correctionSource: controller.correctionSource,
            correctionText: controller.correctionText,
            correctionSourceOffset: controller.correctionSourceOffset
        )
    }
}

final class MacComposerVoiceTranscriptView: NSView {
    typealias Piece = (text: String, opacity: Double)

    private var pieces: [Piece] = []
    private var value = NSAttributedString(string: "")
    private var framesetter: CTFramesetter?

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func update(pieces: [Piece], width: CGFloat) -> CGFloat {
        self.pieces = pieces
        rebuildAttributedText()
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("Voice transcript")
        setAccessibilityValue(value.string)
        let height = Self.measure(value, width: width)
        needsDisplay = true
        return height
    }

    static func measure(_ pieces: [Piece], width: CGFloat) -> CGFloat {
        measure(attributedText(pieces: pieces, color: .labelColor), width: width)
    }

    private static func attributedText(pieces: [Piece], color: NSColor) -> NSAttributedString {
        let output = NSMutableAttributedString()
        for piece in pieces where !piece.text.isEmpty {
            output.append(NSAttributedString(
                string: piece.text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 15),
                    .foregroundColor: color.withAlphaComponent(max(0, min(1, piece.opacity))),
                ]
            ))
        }
        return output
    }

    private static func resolvedLabelColor(for appearance: NSAppearance) -> NSColor {
        var resolved = NSColor.labelColor
        appearance.performAsCurrentDrawingAppearance {
            resolved = NSColor.labelColor.usingColorSpace(.deviceRGB) ?? NSColor.labelColor
        }
        return resolved
    }

    private func rebuildAttributedText() {
        value = Self.attributedText(
            pieces: pieces,
            color: Self.resolvedLabelColor(for: effectiveAppearance)
        )
        framesetter = CTFramesetterCreateWithAttributedString(value)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        rebuildAttributedText()
        needsDisplay = true
    }

    private static func measure(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        guard text.length > 0 else { return 18 }
        let framesetter = CTFramesetterCreateWithAttributedString(text)
        let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: text.length),
            nil,
            CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
            nil
        )
        return max(18, ceil(suggested.height + 1))
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext,
              let framesetter,
              value.length > 0 else { return }
        let visibleRange = visibleSuffixRange(width: bounds.width, height: bounds.height)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: bounds.height)
        context.scaleBy(x: 1, y: -1)
        let path = CGPath(rect: bounds, transform: nil)
        let frame = CTFramesetterCreateFrame(
            framesetter,
            visibleRange,
            path,
            nil
        )
        effectiveAppearance.performAsCurrentDrawingAppearance {
            CTFrameDraw(frame, context)
        }
        context.restoreGState()
    }

    /// Select complete trailing CoreText lines that fit the clipped voice
    /// viewport. Unlike substring binary search, line origins remain stable for
    /// CJK streaming and never collapse the representable to one glyph.
    private func visibleSuffixRange(width: CGFloat, height: CGFloat) -> CFRange {
        let fullRange = CFRange(location: 0, length: value.length)
        guard value.length > 0,
              width > 1,
              height > 1,
              Self.measure(value, width: width) > height + 0.5,
              let framesetter else { return fullRange }

        let measurementPath = CGPath(
            rect: CGRect(x: 0, y: 0, width: width, height: 100_000),
            transform: nil
        )
        let fullFrame = CTFramesetterCreateFrame(framesetter, fullRange, measurementPath, nil)
        let lines = CTFrameGetLines(fullFrame) as? [CTLine] ?? []
        guard !lines.isEmpty else { return fullRange }
        let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: .systemFont(ofSize: 15)))
        let visibleLineCount = max(1, min(lines.count, Int(floor(height / max(1, lineHeight)))))
        // During a SwiftUI width/height transition, a transient one-line bound
        // must never reduce a newly wrapped stream to the first glyph of its
        // trailing line. Wait for the ideal-height layout pass instead.
        guard visibleLineCount > 1 else { return fullRange }
        let firstVisibleLine = lines[lines.count - visibleLineCount]
        let firstRange = CTLineGetStringRange(firstVisibleLine)
        let start = max(0, min(value.length, firstRange.location))
        return CFRange(location: start, length: value.length - start)
    }

    #if DEBUG
    var debugAttributedText: NSAttributedString { value }
    func debugVisibleRange(width: CGFloat, height: CGFloat) -> CFRange {
        visibleSuffixRange(width: width, height: height)
    }
    static func debugAttributedText(pieces: [Piece], appearance: NSAppearance) -> NSAttributedString {
        attributedText(pieces: pieces, color: resolvedLabelColor(for: appearance))
    }
    #endif
}

struct MacComposerVoiceTranscript: NSViewRepresentable {
    let pieces: [MacComposerVoiceTranscriptView.Piece]
    let revision: String

    final class Coordinator {
        var revision = ""
        var width: CGFloat = 0
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> MacComposerVoiceTranscriptView {
        let view = MacComposerVoiceTranscriptView(frame: .zero)
        view.wantsLayer = true
        view.layer?.masksToBounds = true
        return view
    }

    func updateNSView(_ transcriptView: MacComposerVoiceTranscriptView, context: Context) {
        let width = max(1, transcriptView.bounds.width)
        guard context.coordinator.revision != revision
                || abs(context.coordinator.width - width) > 0.5 else { return }
        context.coordinator.revision = revision
        context.coordinator.width = width
        transcriptView.update(pieces: pieces, width: width)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: MacComposerVoiceTranscriptView,
        context: Context
    ) -> CGSize? {
        guard let proposedWidth = proposal.width, proposedWidth > 1 else { return nil }
        let width = proposedWidth
        let contentHeight = MacComposerVoiceTranscriptView.measure(pieces, width: width)
        let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: .systemFont(ofSize: 15)))
        return CGSize(width: width, height: min(contentHeight, lineHeight * 8))
    }
}

private struct MacComposerWaveform: View {
    let levels: [Float]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                let level = min(1, max(0, levels[index]))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.63, green: 0.84, blue: 1.0),
                                Color(red: 0.68, green: 0.58, blue: 1.0),
                            ],
                            startPoint: .bottom,
                            endPoint: .top
                        )
                    )
                    .opacity(0.4 + 0.6 * Double(level))
                    .frame(width: 2, height: 2.5 + CGFloat(sqrt(level)) * 12)
            }
        }
        .frame(width: 34, height: 28)
        .animation(.linear(duration: 0.1), value: levels)
    }
}

private struct MacComposerVoiceKeyProbe: NSViewRepresentable {
    let enabled: Bool
    let voiceActive: Bool
    let onToggle: () -> Void
    let onCancel: () -> Void

    func makeNSView(context: Context) -> MacComposerVoiceKeyProbeView {
        let view = MacComposerVoiceKeyProbeView()
        view.enabled = enabled
        view.voiceActive = voiceActive
        view.onToggle = onToggle
        view.onCancel = onCancel
        return view
    }

    func updateNSView(_ nsView: MacComposerVoiceKeyProbeView, context: Context) {
        nsView.enabled = enabled
        nsView.voiceActive = voiceActive
        nsView.onToggle = onToggle
        nsView.onCancel = onCancel
    }
}

private final class MacComposerVoiceKeyProbeView: NSView {
    var enabled = false
    var voiceActive = false
    var onToggle: (() -> Void)?
    var onCancel: (() -> Void)?
    private var localMonitor: Any?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isHidden = true
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.enabled, event.window === self.window else { return event }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if flags == .option, event.keyCode == 49 {
                self.onToggle?()
                return nil
            }
            if self.voiceActive, flags.isEmpty, event.keyCode == 53 {
                self.onCancel?()
                return nil
            }
            return event
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }
}

/// SwiftUI's `.onPasteCommand` is not reliably reached when the underlying
/// macOS `NSTextField`/field editor consumes Command-V first. This probe uses an
/// app-local event monitor (not a global monitor) and only intercepts paste while
/// this Composer's FocusState is active. Text-only paste is returned untouched
/// to the native responder chain.
private struct MacComposerPasteProbe: NSViewRepresentable {
    let enabled: Bool
    let onPasteImage: (NSImage) -> Void

    func makeNSView(context: Context) -> MacComposerPasteProbeView {
        let view = MacComposerPasteProbeView()
        view.enabled = enabled
        view.onPasteImage = onPasteImage
        return view
    }

    func updateNSView(_ nsView: MacComposerPasteProbeView, context: Context) {
        nsView.enabled = enabled
        nsView.onPasteImage = onPasteImage
    }
}

private final class MacComposerPasteProbeView: NSView {
    var enabled = false
    var onPasteImage: ((NSImage) -> Void)?
    private var localMonitor: Any?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isHidden = true
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self,
                  self.enabled,
                  event.window === self.window,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v",
                  let image = Self.image(from: .general) else {
                return event
            }
            self.onPasteImage?(image)
            return nil
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
    }

    private static func image(from pasteboard: NSPasteboard) -> NSImage? {
        // Covers screenshots and browser-provided TIFF/PNG/NSImage payloads.
        if let image = NSImage(pasteboard: pasteboard) { return image }

        // Finder commonly places a copied file on the pasteboard as a file URL.
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
        ]
        if let urls = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: options
        ) as? [URL] {
            for url in urls where url.isFileURL {
                if let image = NSImage(contentsOf: url) { return image }
            }
        }

        // Some apps advertise a concrete image UTI without vending NSImage.
        for type in [
            NSPasteboard.PasteboardType(UTType.png.identifier),
            .tiff,
        ] {
            if let data = pasteboard.data(forType: type),
               let image = NSImage(data: data) {
                return image
            }
        }
        return nil
    }
}

private struct MacGlassCircleModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.glassEffect(.regular, in: Circle())
        } else {
            content.background(.ultraThinMaterial, in: Circle())
        }
    }
}

private struct MacModeChangeToast: View {
    let mode: SessionMode

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.modeColor(mode))
                .frame(width: 7, height: 7)
            Text(Self.widestModeName)
                .font(Self.labelFont)
                .hidden()
                .overlay {
                    Text(mode.rawValue.capitalized)
                        .font(Self.labelFont)
                        .foregroundStyle(Color.modeColor(mode).opacity(0.85))
                        .contentTransition(.opacity)
                }
        }
        .animation(.easeInOut(duration: 0.35), value: mode)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background {
            if #available(macOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: Capsule())
            } else {
                Capsule().fill(.ultraThinMaterial)
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
    }

    private static let labelFont: Font = .system(size: 13, weight: .medium)
    private static let widestModeName = "Delegate"
}

#if DEBUG
@MainActor
private final class MacComposerFocusRegressionState {
    var text = ""
    var focused = true
    var focusRequest = 0
}

private final class MacComposerRegressionExternalFocusView: NSView {
    override var acceptsFirstResponder: Bool { true }
}

@MainActor
enum MacComposerPasteFocusRegression {
    static func run(completion: @escaping ([String: Any]) -> Void) {
        let state = MacComposerFocusRegressionState()
        let input = MacComposerScrollableTextInput(
            text: Binding(get: { state.text }, set: { state.text = $0 }),
            focused: Binding(get: { state.focused }, set: { state.focused = $0 }),
            enabled: true,
            focusRequest: state.focusRequest,
            onRequestFocus: {
                state.focused = true
                state.focusRequest += 1
            },
            onSubmit: {}
        )
        let coordinator = MacComposerScrollableTextInput.Coordinator(input)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 90),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 90))
        window.contentView = root

        let original = MacComposerTextView(frame: NSRect(x: 0, y: 40, width: 300, height: 36))
        let replacement = MacComposerTextView(frame: original.frame)
        let external = MacComposerRegressionExternalFocusView(
            frame: NSRect(x: 0, y: 0, width: 160, height: 24)
        )
        root.addSubview(original)
        root.addSubview(external)
        coordinator.textView = original

        // Attachment updates can remove the current NSTextView while AppKit is
        // delivering textDidEndEditing. That teardown must preserve the binding.
        state.focused = true
        coordinator.textDidEndEditing(
            Notification(name: NSText.didEndEditingNotification, object: original)
        )
        original.removeFromSuperview()

        DispatchQueue.main.async {
            let teardownPreserved = state.focused

            // A newly-created Composer text view is an internal handoff, not a
            // genuine focus departure.
            root.addSubview(original)
            root.addSubview(replacement)
            window.makeFirstResponder(replacement)
            state.focused = true
            coordinator.textDidEndEditing(
                Notification(name: NSText.didEndEditingNotification, object: original)
            )

            DispatchQueue.main.async {
                let replacementPreserved = state.focused

                // The paste callback must reassert FocusState so the next
                // SwiftUI update makes the live replacement first responder.
                state.focused = false
                coordinator.textView = replacement
                coordinator.restoreFocusAfterPaste()
                let pasteRestoredBinding = state.focused

                DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                    let replacementBecameFirstResponder = window.firstResponder === replacement

                    // Simulate an IME composition committing Chinese text. The
                    // committed draft must publish while retaining the live
                    // native text view as first responder.
                    coordinator.wasComposing = true
                    replacement.string = "中文输入"
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    let imeDraftCommitted = state.text == "中文输入"
                    let imeRequestedFocus = state.focusRequest > 0

                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                        let imeRetainedFirstResponder = window.firstResponder === replacement

                        // A genuine move outside the Composer must still clear focus.
                        window.makeFirstResponder(external)
                        state.focused = true
                        coordinator.textDidEndEditing(
                            Notification(name: NSText.didEndEditingNotification, object: replacement)
                        )

                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                            let externalCleared = !state.focused
                            let passed = teardownPreserved
                                && replacementPreserved
                                && pasteRestoredBinding
                                && replacementBecameFirstResponder
                                && imeDraftCommitted
                                && imeRequestedFocus
                                && imeRetainedFirstResponder
                                && externalCleared
                            window.close()
                            completion([
                                "passed": passed,
                                "teardownPreserved": teardownPreserved,
                                "replacementPreserved": replacementPreserved,
                                "pasteRestoredBinding": pasteRestoredBinding,
                                "replacementBecameFirstResponder": replacementBecameFirstResponder,
                                "imeDraftCommitted": imeDraftCommitted,
                                "imeRequestedFocus": imeRequestedFocus,
                                "imeRetainedFirstResponder": imeRetainedFirstResponder,
                                "externalCleared": externalCleared,
                            ])
                        }
                    }
                }
            }
        }
    }
}
#endif
#endif
