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

enum MacComposerPlaceholderPolicy {
    static func isVisible(committedText: String, nativeEditorHasText: Bool) -> Bool {
        committedText.isEmpty && !nativeEditorHasText
    }
}

/// macOS counterpart of the production iOS `MessageInputView`.
///
/// Same structure as iOS: one glass capsule [image | thumbnail] text
/// [clear] [mic], and beside it one round primary control (the size and
/// column of the chat's jump controls) that morphs Send / Stop / Steer.
/// Dictation stays a single row on macOS (the capsule is wide enough).
/// Session mode is chosen in the chat header, not on the composer.
/// Permission/question controls remain in the live bubble.
enum MacComposerMetrics {
    /// Single-line and recording capsule match the primary/jump circles.
    static let capsuleHeight: CGFloat = control
    /// Primary circle — same as the chat's jump controls.
    static let control: CGFloat = 36
    /// Capsule ↔ primary circle, and between stacked round controls.
    static let controlGap: CGFloat = 8
    /// Primary circle ↔ the jump control above it (+1 pt balances the
    /// bordered glass control against the solid circle).
    static let stackGap: CGFloat = 9
    static let verticalPadding: CGFloat = 6
    /// Outside the scrolling viewport: retained even when text scrolls.
    static let textVerticalPadding: CGFloat = 8
    static let maxVisibleTextLines: CGFloat = 3
    static var minimumTextHeight: CGFloat { capsuleHeight - textVerticalPadding * 2 }
    /// Distance from the chat bottom to the bottom of the ↓ jump control.
    static var jumpControlBottom: CGFloat {
        verticalPadding + (capsuleHeight - control) / 2 + control + stackGap
    }
    static let stopRed = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(red: 0.62, green: 0.17, blue: 0.17, alpha: 1)
            : NSColor(red: 0.78, green: 0.16, blue: 0.16, alpha: 1)
    })
}

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
    @State private var composerFocusRequest = 0
    @State private var isFocused = false
    @State private var nativeEditorHasText = false
    @State private var selection: NSRange?

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

    private static let inputBoxHeight: CGFloat = MacComposerMetrics.capsuleHeight
    private static let voiceStartSound: NSSound? = {
        guard let data = NSDataAsset(name: "VoiceStartCue")?.data else { return nil }
        let sound = NSSound(data: data)
        sound?.volume = 1.0
        return sound
    }()

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
    private var voiceComposer: IOSVoiceComposer { appState.iosVoiceComposer }
    private var voiceOwnsComposer: Bool { voiceComposer.isRecording(in: sessionId) }
    private var voiceSendPending: Bool {
        guard voiceComposer.sessionID == sessionId, let phase = voiceComposer.operation?.phase,
              case .staged = phase else { return false }
        return true
    }
    private var canSend: Bool {
        if voiceOwnsComposer { return true }
        return !voiceSendPending && (isStructuredResponse ? hasText : (hasText || hasImage))
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
        voiceController.hasFailure(for: sessionId)
    }

    /// Agent running and nothing typed: the primary control stops the turn.
    private var showsStop: Bool { !voiceOwnsComposer && canShowAbort && !hasText && !hasImage }

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
                    voiceComposer.depart(sessionID: activeVoiceSession)
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
                voiceComposer.depart(sessionID: sessionId)
            }
            .onChange(of: voiceOwnsComposer) { wasOwned, ownsComposer in
                guard wasOwned, !ownsComposer else { return }
                if NSApp.isActive, NSApp.keyWindow?.isKeyWindow == true {
                    isFocused = true
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .krakiVoiceEditRequested)) { note in
                guard note.userInfo?["sessionId"] as? String == sessionId,
                      let clientID = note.userInfo?["clientId"] as? String else { return }
                editStagedVoice(clientID)
            }
            .onChange(of: voiceComposer.dispatchSignal) { _, _ in
                if voiceComposer.dispatchedSessionID == sessionId { awaitingActive = true }
            }
            .onChange(of: voiceComposer.editorRequest) { _, _ in
                if voiceComposer.editorSessionID == sessionId { requestComposerFocus() }
            }
            .background {
                MacComposerVoiceKeyProbe(
                    enabled: canShowVoice,
                    voiceActive: voiceOwnsComposer,
                    onToggle: handleVoiceButton,
                    onCancel: {
                        if voiceController.activeSessionID == sessionId {
                            voiceComposer.cancel()
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
        .padding(.top, MacComposerMetrics.verticalPadding)
        .padding(.bottom, MacComposerMetrics.verticalPadding)
        .frame(maxWidth: .infinity)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: MacComposerMetrics.controlGap) {
            inputBox
            primaryButton
                .padding(.bottom, (Self.inputBoxHeight - MacComposerMetrics.control) / 2)
        }
    }

    private var inputBox: some View {
        Group {
            if voiceOwnsComposer {
                HStack(alignment: .bottom, spacing: 0) {
                    imageSlot
                    MacComposerVoiceSurface(
                        controller: voiceController,
                        preview: voiceComposer.preview,
                        onFinish: { voiceComposer.finishToDraft() },
                        onCancel: { voiceComposer.cancel() }
                    )
                }
            } else {
                HStack(alignment: .bottom, spacing: 0) {
                    imageSlot
                    textFieldForMode
                    if hasText || hasImage { clearButton }
                    if canShowVoice { inlineVoiceButton }
                }
                .padding(.trailing, 5)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: Self.inputBoxHeight)
        .background { inputBoxGlassBackground }
        .contentShape(RoundedRectangle(cornerRadius: Self.inputBoxHeight / 2, style: .continuous))
    }

    @ViewBuilder
    private var inputBoxGlassBackground: some View {
        let shape = RoundedRectangle(cornerRadius: Self.inputBoxHeight / 2, style: .continuous)
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(.ultraThinMaterial)
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
                .padding(.leading, 4)
                .opacity(MacComposerPlaceholderPolicy.isVisible(
                    committedText: text,
                    nativeEditorHasText: nativeEditorHasText
                ) ? 1 : 0)
                .allowsHitTesting(false)
            MacComposerScrollableTextInput(
                text: Binding(
                    get: { text },
                    set: {
                        guard $0 != text else { return }
                        voiceComposer.takeOver(sessionID: sessionId)
                        sessionStore.setDraft(sessionId, $0)
                    }
                ),
                focused: Binding(
                    get: { isFocused },
                    set: { isFocused = $0 }
                ),
                nativeEditorHasText: $nativeEditorHasText,
                enabled: !voiceOwnsComposer,
                focusRequest: composerFocusRequest,
                selectionRequest: voiceComposer.editorSessionID == sessionId ? voiceComposer.selectionRequest : nil,
                onRequestFocus: requestComposerFocus,
                onSubmit: handleModeSubmit,
                onSelection: { selection = $0 },
                onTakeOver: { voiceComposer.takeOver(sessionID: sessionId) }
            )
            .padding(.leading, 0)
            .padding(.trailing, 4)
            .padding(.vertical, MacComposerMetrics.textVerticalPadding)
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

    private enum PrimaryRole: Equatable { case send, stop }
    private var primaryRole: PrimaryRole { showsStop ? .stop : .send }

    private var primaryGlyph: String {
        if primaryRole == .stop { return "stop.fill" }
        if voiceOwnsComposer && pendingPermission != nil { return "checkmark" }
        return submissionIntent == .steer ? "arrow.turn.right.up" : "arrow.up"
    }

    /// One circle; its fill and glyph cross-fade between Send / Stop / Steer.
    /// The animation is scoped to those style modifiers only: a button-wide
    /// implicit (or transaction) animation also animated the chat's layout on
    /// every update while a reply streamed and stalled the main thread.
    private var primaryButton: some View {
        let role = primaryRole
        let glyph = primaryGlyph
        let fill: Color = role == .stop ? MacComposerMetrics.stopRed
            : canSend ? Color.krakiPrimary : Color(nsColor: .quaternaryLabelColor)
        let morph = Animation.easeInOut(duration: 0.22)
        let active = role == .stop || canSend
        return Button(action: role == .stop ? requestAbort : handleModeSubmit) {
            ZStack {
                MacPrimaryGlassCircle(tint: active ? fill : nil, fallback: fill)
                ForEach(["arrow.up", "arrow.turn.right.up", "stop.fill", "checkmark"], id: \.self) { name in
                    Image(systemName: name)
                        .font(.system(size: name == "stop.fill" ? 11 : 15, weight: .bold))
                        .foregroundStyle(active ? Color.white : Color.secondary)
                        .animation(morph) {
                            $0.opacity(name == glyph && !(role == .stop && abortPending) ? 1 : 0)
                                .scaleEffect(name == glyph ? 1 : 0.6)
                        }
                }
                if role == .stop && abortPending {
                    ProgressView().controlSize(.small).tint(.white)
                }
            }
            .frame(width: MacComposerMetrics.control, height: MacComposerMetrics.control)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(role == .stop ? (abortPending || !isDeviceReachable) : !canSend)
        .opacity(role == .stop ? (isDeviceReachable ? 1 : 0.5) : (canSend && !isDeviceReachable ? 0.6 : 1))
        .accessibilityLabel(voiceOwnsComposer ? (pendingPermission != nil ? "Edit voice text" : (pendingQuestion != nil ? "Submit voice answer" : "Send voice message")) : (role == .stop ? "Stop agent" : sendAccessibilityLabel))
        .accessibilityIdentifier(voiceOwnsComposer ? "voice-send" : "chat-primary")
        .accessibilityHint(role == .stop ? "Aborts the current agent turn" : sendAccessibilityHint)
    }

    private var clearButton: some View {
        Button {
            sessionStore.setDraft(sessionId, "")
            clearImage()
            requestComposerFocus()
        } label: {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(.tertiary)
                .frame(width: 26, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear message")
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
            ZStack {
                Image(systemName: "mic")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
                    .opacity(voiceComposer.isFinishing(in: sessionId) ? 0 : 1)
                if voiceComposer.isFinishing(in: sessionId) { ProgressView().controlSize(.small) }
            }
            .frame(width: 32, height: Self.inputBoxHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canStartVoice)
        .opacity(canStartVoice || voiceComposer.isFinishing(in: sessionId) ? 1 : 0.4)
        .accessibilityLabel("Start voice input")
        .accessibilityIdentifier("chat-voice-microphone")
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
        if voiceOwnsComposer {
            voiceComposer.finishToDraft()
            return
        }
        guard canStartVoice, let session else { return }
        Self.playVoiceStartCue()
        voiceController.clearFailure()
        isFocused = false
        let voiceContext = VoiceSessionContextBuilder.build(
            session: session,
            recentMessages: appState.messageStore.recentFromDB(sessionId, limit: 20)
        )
        voiceComposer.begin(sessionID: sessionId, selection: selection, context: voiceContext)
    }

    private static func playVoiceStartCue() {
        guard let sound = voiceStartSound else {
            KLog.diag("🎙️ [voice] start cue unavailable; continuing silently")
            return
        }
        sound.stop()
        let played = sound.play()
        KLog.diag("🎙️ [voice] start cue played=\(played)")
        // A missing/unplayable cue must not become an unrelated warning beep.
    }

    /// Single image: the attach icon itself becomes the thumbnail (click to
    /// replace, small × to remove).
    private var imageSlot: some View {
        Group {
            if let previewImage {
                ZStack(alignment: .topTrailing) {
                    Button(action: chooseImage) {
                        Image(nsImage: previewImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 28, height: 28)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .frame(width: 38, height: Self.inputBoxHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button(action: clearImage) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.black.opacity(0.6))
                    }
                    .buttonStyle(.plain)
                    .offset(x: -1, y: 4)
                    .accessibilityLabel("Remove image")
                }
            } else {
                Button(action: chooseImage) {
                    LucideIcon(.imagePlus, size: 19, strokeWidth: 2.1, color: .secondary)
                        .frame(width: 38, height: Self.inputBoxHeight)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 6)
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

    private func editStagedVoice(_ clientID: String) {
        guard let sender = appState.commandSender,
              sender.isStaged(sessionId: sessionId, clientId: clientID),
              let message = sender.pendingInputs(sessionId).first(where: { $0.payload["clientId"]?.stringValue == clientID }) else { return }
        let attachments = message.attachments ?? []
        // Never discard an image if the single-image composer already has
        // another one, or cannot decode it. Keep the complete staged bubble.
        guard attachments.count <= 1, attachments.isEmpty || imageData == nil else { NSSound.beep(); return }
        if let attachment = attachments.first {
            guard let data = Data(base64Encoded: attachment.data), let image = NSImage(data: data) else { NSSound.beep(); return }
            imageData = data
            previewImage = image
            imageMimeType = attachment.mimeType
        }
        let original = sender.originalText(sessionId: sessionId, clientId: clientID) ?? ""
        sender.discardPending(sessionId: sessionId, clientId: clientID)
        sessionStore.setDraft(sessionId, VoiceDraftMerger.merge(existing: text, final: original))
        requestComposerFocus()
    }

    private func handleModeSubmit() {
        if voiceOwnsComposer {
            // Free-form answers use main's answerTo-aware staged outbox;
            // only permission denial still requires review in the editor.
            if pendingPermission != nil { voiceComposer.finishToDraft(); return }
            let attachments = imageData.map {
                [ImageAttachment(type: "image", mimeType: imageMimeType, data: $0.base64EncodedString())]
            }
            if voiceComposer.send(attachments: attachments, delivery: submissionIntent == .steer ? .steer : .prompt,
                                  answerTo: pendingQuestion?.id) {
                clearImage()
                didSubmitFromComposer()
                requestComposerFocus()
            }
            return
        }
        guard !voiceSendPending else { return }
        voiceComposer.takeOver(sessionID: sessionId)
        switch submissionIntent {
        case .denyPermission:
            guard hasText, let permission = pendingPermission else { return }
            let reason = text.trimmingCharacters(in: .whitespacesAndNewlines)
            // Keep the draft if the decision could not be sent.
            guard appState.commandSender?.deny(
                sessionId: sessionId,
                permissionId: permission.id,
                reason: reason
            ) == true else { NSSound.beep(); return }
            sessionStore.setDraft(sessionId, "")
            didSubmitFromComposer()
        case .answerQuestion:
            guard hasText, let question = pendingQuestion else { return }
            let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard appState.commandSender?.answer(
                sessionId: sessionId,
                questionId: question.id,
                answer: answer,
                attachments: imageData.map {
                    [ImageAttachment(type: "image", mimeType: imageMimeType, data: $0.base64EncodedString())]
                }
            ) == true else { NSSound.beep(); return }
            sessionStore.setDraft(sessionId, "")
            clearImage()
            didSubmitFromComposer()
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
        didSubmitFromComposer()
    }

    /// Anything submitted from the composer is a new message: the Chat
    /// returns to its newest edge, and focus stays in the composer so a
    /// follow-up can be typed immediately (as on iOS).
    private func didSubmitFromComposer() {
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil,
                                        userInfo: ["sessionId": sessionId])
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
    var onTakeOver: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onTakeOver?()
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        onTakeOver?()
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
    @Binding var nativeEditorHasText: Bool
    let enabled: Bool
    let focusRequest: Int
    var selectionRequest: NSRange? = nil
    let onRequestFocus: () -> Void
    let onSubmit: () -> Void
    let onSelection: (NSRange) -> Void
    let onTakeOver: () -> Void

    private static let font = NSFont.systemFont(ofSize: 15)
    private static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    // One point for the text/caret; the stable visual padding lives outside
    // the scroll view so it remains present at every scroll position.
    private static let verticalPadding: CGFloat = 1

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacComposerScrollableTextInput
        weak var scrollView: NSScrollView?
        weak var textView: MacComposerTextView?
        var isApplying = false
        var wasComposing = false
        var appliedFocusRequest = -1
        var appliedSelectionRequest: NSRange?

        init(_ parent: MacComposerScrollableTextInput) {
            self.parent = parent
        }

        func reportVisualTextPresence(
            of textView: MacComposerTextView,
            deferred: Bool = false
        ) {
            let apply = { [weak self, weak textView] in
                guard let self,
                      let textView,
                      self.textView === textView else { return }
                let hasText = !textView.string.isEmpty
                if self.parent.nativeEditorHasText != hasText {
                    self.parent.nativeEditorHasText = hasText
                }
            }
            if deferred {
                DispatchQueue.main.async(execute: apply)
            } else {
                apply()
            }
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            guard !isApplying, let textView = notification.object as? MacComposerTextView,
                  textView.window?.firstResponder === textView else { return }
            parent.onSelection(textView.selectedRange())
        }

        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? MacComposerTextView else { return }
            // Marked IME text intentionally does not round-trip through the
            // persisted draft, but it is still visible native text and must
            // hide the SwiftUI placeholder immediately.
            reportVisualTextPresence(of: textView)
            guard !isApplying else { return }
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
        textView.onTakeOver = onTakeOver
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
        context.coordinator.reportVisualTextPresence(of: textView, deferred: true)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let textView = scrollView.documentView as? MacComposerTextView else { return }
        textView.onTakeOver = onTakeOver
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
        if let selectionRequest, context.coordinator.appliedSelectionRequest != selectionRequest,
           !textView.hasMarkedText() {
            context.coordinator.isApplying = true
            let range = IOSVoiceComposer.safeRange(selectionRequest, in: textView.string)
            textView.setSelectedRange(range)
            context.coordinator.appliedSelectionRequest = selectionRequest
            context.coordinator.isApplying = false
            // Keep continuation's insertion range in sync without treating a
            // programmatic selection as the user taking over correction.
            DispatchQueue.main.async { onSelection(range) }
        }
        context.coordinator.reportVisualTextPresence(of: textView, deferred: true)
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
        let minHeight = MacComposerMetrics.minimumTextHeight
        let maxHeight = Self.lineHeight * MacComposerMetrics.maxVisibleTextLines + Self.verticalPadding * 2
        return CGSize(width: width, height: min(max(measured, minHeight), maxHeight))
    }

    private static func measuredHeight(_ text: String, width: CGFloat) -> CGFloat {
        // Measure with the same TextKit layout as NSTextView, including an
        // empty trailing line. CoreText's extra rounding used to change the
        // apparent padding when the editor grew from one line to two.
        let storage = NSTextStorage(string: text.isEmpty ? " " : text, attributes: [.font: font])
        let layout = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: max(1, width - 8), height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        let height = max(layout.usedRect(for: container).maxY, layout.extraLineFragmentRect.maxY)
        return max(lineHeight, ceil(height)) + verticalPadding * 2
    }
}

// MARK: - Inline VoiceType transcript surface

/// A quiet transcript-only backdrop driven by real microphone peaks, never
/// a canned idle animation. Faded ends keep the adjacent image and action
/// slots clear. Background geometry cannot resize or intercept the controls.
struct MacVoiceBackgroundWaveform: View {
    let levels: [Float]

    static func heightFractions(levels: [Float], count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let recent = Array(levels.suffix(8))
        let samples = Array(repeating: Float(0), count: max(0, 8 - recent.count)) + recent
        return (0..<count).map { index in
            let position = CGFloat(index) / CGFloat(max(1, count - 1)) * CGFloat(samples.count - 1)
            let left = Int(position)
            let right = min(left + 1, samples.count - 1)
            let mix = position - CGFloat(left)
            let amplitude = VoiceLevelBars.loudness(samples[left]) * (1 - mix)
                + VoiceLevelBars.loudness(samples[right]) * mix
            return 0.06 + amplitude * 0.78
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let count = max(8, min(160, Int(geometry.size.width / 8)))
            let heights = Self.heightFractions(levels: levels, count: count)
            HStack(spacing: 0) {
                ForEach(heights.indices, id: \.self) { index in
                    Capsule()
                        .fill(Color.krakiPrimary.opacity(0.10))
                        .frame(width: 3, height: max(2, geometry.size.height * heights[index]))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .animation(.spring(response: 0.18, dampingFraction: 0.8), value: levels)
        }
    }
}

private struct MacComposerVoiceSurface: View {
    let controller: KrakiVoiceInputController
    let preview: (prefix: String, spoken: String, suffix: String)
    let onFinish: () -> Void
    let onCancel: () -> Void
    @State private var transcriptWidth: CGFloat = 0

    private var viewportHeight: CGFloat {
        guard transcriptWidth > 1 else { return MacComposerMetrics.minimumTextHeight }
        return min(
            max(MacComposerMetrics.minimumTextHeight, MacComposerVoiceTranscriptView.measure(displayedPieces, width: transcriptWidth)),
            MacComposerMetrics.minimumTextHeight + MacComposerVoiceTranscriptView.lineHeight * (MacComposerMetrics.maxVisibleTextLines - 1)
        )
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            MacComposerScrollableVoiceTranscript(pieces: displayedPieces, revision: revision)
                .frame(maxWidth: .infinity)
                .frame(height: viewportHeight)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { transcriptWidth = $0 }
                .background {
                    MacVoiceBackgroundWaveform(levels: controller.levels)
                        .mask {
                            LinearGradient(stops: [
                                .init(color: .clear, location: 0),
                                .init(color: .white, location: 0.12),
                                .init(color: .white, location: 0.88),
                                .init(color: .clear, location: 1)
                            ], startPoint: .leading, endPoint: .trailing)
                        }
                        .clipped()
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                .padding(.vertical, MacComposerMetrics.textVerticalPadding)
            Button(action: onCancel) {
                Label("Cancel", systemImage: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 70, height: 30)
                    .background(.primary.opacity(0.05), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice input")
            .accessibilityIdentifier("voice-cancel")
            .padding(.bottom, (MacComposerMetrics.control - 30) / 2)
            Button(action: onFinish) {
                Label("Edit", systemImage: "character.cursor.ibeam")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.krakiPrimary)
                    .frame(width: 62, height: 30)
                    .background(Color.krakiPrimary.opacity(0.10), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Edit voice text")
            .accessibilityIdentifier("voice-to-text")
            .padding(.bottom, (MacComposerMetrics.control - 30) / 2)
        }
        .padding(.leading, 4)
        .padding(.trailing, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var revision: String {
        "\(preview.prefix)-\(preview.spoken)-\(preview.suffix)-\(controller.state)"
    }

    private var displayedPieces: [(text: String, opacity: Double)] {
        [(preview.prefix, 1), (preview.spoken, 0.5), (preview.suffix, 1)]
    }
}

final class MacComposerVoiceTranscriptView: NSView {
    typealias Piece = (text: String, opacity: Double)

    private static let font = NSFont.systemFont(ofSize: 15)
    static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    static let maxVisibleLines: CGFloat = 8

    private var pieces: [Piece] = []
    private var value = NSAttributedString(string: "")
    private var framesetter: CTFramesetter?
    private var measuredWidth: CGFloat = 0
    private var measuredHeight: CGFloat = lineHeight
    private(set) var contentHeight: CGFloat = lineHeight
    var preservesContentHeight = false

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: measuredHeight)
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func update(pieces: [Piece], width: CGFloat) -> CGFloat {
        self.pieces = pieces
        rebuildAttributedText()
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("Voice transcript")
        setAccessibilityValue(value.string)
        if width > 1 {
            measuredWidth = width
            contentHeight = Self.measure(value, width: width)
            measuredHeight = min(contentHeight, Self.lineHeight * Self.maxVisibleLines)
        } else {
            measuredWidth = 0
            contentHeight = Self.lineHeight
            measuredHeight = Self.lineHeight
        }
        invalidateIntrinsicContentSize()
        needsDisplay = true
        return measuredHeight
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
        guard text.length > 0 else { return lineHeight }
        let framesetter = CTFramesetterCreateWithAttributedString(text)
        let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: text.length),
            nil,
            CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
            nil
        )
        return max(lineHeight, ceil(suggested.height + 1))
    }

    override func layout() {
        super.layout()
        guard bounds.width > 1,
              abs(bounds.width - measuredWidth) > 0.5 else { return }
        measuredWidth = bounds.width
        let fullHeight = Self.measure(value, width: bounds.width)
        contentHeight = fullHeight
        if preservesContentHeight,
           bounds.height < fullHeight - 0.5 {
            setFrameSize(NSSize(width: bounds.width, height: fullHeight))
        }
        let height = min(fullHeight, Self.lineHeight * Self.maxVisibleLines)
        guard abs(height - measuredHeight) > 0.5 else {
            needsDisplay = true
            return
        }
        measuredHeight = height
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    /// Short speech is vertically centered within its current viewport.
    /// Long speech keeps its complete document height and native tail scroll.
    var textDrawingRect: CGRect {
        let inset = max(0, (bounds.height - contentHeight) / 2)
        return bounds.insetBy(dx: 0, dy: inset)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext,
              let framesetter,
              value.length > 0 else { return }
        let visibleRange = contentHeight <= bounds.height + 0.5
            ? CFRange(location: 0, length: value.length)
            : visibleSuffixRange(width: bounds.width, height: bounds.height)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: bounds.height)
        context.scaleBy(x: 1, y: -1)
        let path = CGPath(rect: textDrawingRect, transform: nil)
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
        _ = transcriptView.update(pieces: pieces, width: width)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: MacComposerVoiceTranscriptView,
        context: Context
    ) -> CGSize? {
        guard let proposedWidth = proposal.width, proposedWidth > 1 else { return nil }
        let width = proposedWidth
        let contentHeight = MacComposerVoiceTranscriptView.measure(pieces, width: width)
        return CGSize(
            width: width,
            height: min(contentHeight, MacComposerVoiceTranscriptView.lineHeight * MacComposerVoiceTranscriptView.maxVisibleLines)
        )
    }
}

/// Keeps the live voice transcript at its newest line after AppKit finishes
/// a document-frame/layout pass. The scroll view still accepts normal wheel
/// and trackpad input between recognition updates.
private final class MacComposerVoiceScrollView: NSScrollView {
    var followsTail = true

    override func layout() {
        super.layout()
        guard followsTail,
              let documentView,
              documentView.frame.height > contentView.bounds.height + 0.5 else { return }
        let maximumY = max(0, documentView.frame.height - contentView.bounds.height)
        guard abs(contentView.bounds.origin.y - maximumY) > 0.5 else { return }
        contentView.bounds.origin.y = maximumY
        super.reflectScrolledClipView(contentView)
    }
}

/// A growing, three-line-capped native scroll surface for voice text. The
/// document keeps the complete CoreText layout while the clip view follows
/// its bottom edge after every recognition update, so long dictation remains
/// readable and the newest words never disappear below the composer.
private struct MacComposerScrollableVoiceTranscript: NSViewRepresentable {
    let pieces: [MacComposerVoiceTranscriptView.Piece]
    let revision: String

    final class Coordinator {
        var revision = ""
        var width: CGFloat = 0
        var proposedWidth: CGFloat = 0
        weak var documentView: MacComposerVoiceTranscriptView?

        func apply(
            pieces: [MacComposerVoiceTranscriptView.Piece],
            revision: String,
            to scrollView: NSScrollView
        ) {
            guard let documentView else { return }
            let clipWidth = scrollView.contentView.bounds.width
            let viewWidth = scrollView.bounds.width
            let width = max(1, clipWidth > 1 ? clipWidth : (viewWidth > 1 ? viewWidth : proposedWidth))
            let changed = self.revision != revision || abs(self.width - width) > 0.5
            guard changed else { return }
            self.revision = revision
            self.width = width
            _ = documentView.update(pieces: pieces, width: width)
            let documentHeight = max(documentView.contentHeight, scrollView.contentView.bounds.height)
            documentView.frame = NSRect(
                x: 0,
                y: 0,
                width: width,
                height: documentHeight
            )
            documentView.needsLayout = true
            scrollView.layoutSubtreeIfNeeded()
            // NSScrollView may perform an internal clip-view layout after the
            // representable update. Reassert the document extent after that
            // pass so AppKit cannot collapse the document back to its
            // intrinsic viewport height.
            documentView.setFrameSize(NSSize(width: width, height: documentHeight))
            documentView.setFrameOrigin(.zero)
            scrollToTail(scrollView)
            DispatchQueue.main.async { [weak self, weak scrollView] in
                guard let self, let scrollView else { return }
                self.scrollToTail(scrollView)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self, weak scrollView] in
                    guard let self, let scrollView else { return }
                    self.scrollToTail(scrollView)
                }
            }
        }

        func scrollToTail(_ scrollView: NSScrollView) {
            let clipView = scrollView.contentView
            let maxY = max(0, clipView.documentRect.height - clipView.bounds.height)
            clipView.bounds.origin.y = maxY
            scrollView.reflectScrolledClipView(clipView)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = MacComposerVoiceScrollView(frame: .zero)
        scrollView.drawsBackground = false
        scrollView.contentView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasHorizontalScroller = false
        // Keep the viewport visually scrollbar-free while allowing native
        // trackpad/wheel packets to move the clip view.
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .automatic
        scrollView.horizontalScrollElasticity = .none

        let documentView = MacComposerVoiceTranscriptView(frame: .zero)
        documentView.autoresizingMask = [.width]
        documentView.preservesContentHeight = true
        documentView.wantsLayer = true
        documentView.layer?.masksToBounds = false
        scrollView.documentView = documentView
        scrollView.followsTail = true
        context.coordinator.documentView = documentView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.apply(pieces: pieces, revision: revision, to: scrollView)
        // SwiftUI may deliver the first update before the representable has
        // its final width. Re-apply after AppKit has committed that layout.
        DispatchQueue.main.async { [weak scrollView] in
            guard let scrollView else { return }
            context.coordinator.apply(pieces: pieces, revision: revision, to: scrollView)
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: NSScrollView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width > 1 else { return nil }
        context.coordinator.proposedWidth = width
        return CGSize(
            width: width,
            height: min(
                max(MacComposerMetrics.minimumTextHeight, MacComposerVoiceTranscriptView.measure(pieces, width: width)),
                MacComposerMetrics.minimumTextHeight + MacComposerVoiceTranscriptView.lineHeight * (MacComposerMetrics.maxVisibleTextLines - 1)
            )
        )
    }
}

#if DEBUG
/// Debug-only fixed-height stress probe for the native voice transcript
/// scroll surface (the production composer now grows to a three-line cap). It is intentionally isolated from Relay and AppState.
enum MacComposerVoiceScrollRegression {
    static func run() -> [String: Any] {
        let text = String(repeating: "Long voice transcript keeps appending so the newest words remain visible. ", count: 18)
        let host = NSHostingView(
            rootView: AnyView(
                MacComposerScrollableVoiceTranscript(
                    pieces: [(text: text, opacity: 1)],
                    revision: "long"
                )
                .frame(width: 280, height: MacComposerVoiceTranscriptView.lineHeight * 2)
            )
        )
        let window = NSWindow(
            contentRect: NSRect(x: -20_000, y: -20_000, width: 280, height: 44),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = host
        host.frame = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 280, height: 44)
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.03))
        host.layoutSubtreeIfNeeded()

        func descendants(of view: NSView) -> [NSView] {
            view.subviews.flatMap { [$0] + descendants(of: $0) }
        }
        guard let scrollView = descendants(of: host).compactMap({ $0 as? NSScrollView }).first,
              let documentView = scrollView.documentView as? MacComposerVoiceTranscriptView else {
            return ["passed": false, "scrollView": false]
        }

        let viewportHeight = scrollView.contentView.bounds.height
        let documentHeight = documentView.frame.height
        let maxY = max(0, documentHeight - viewportHeight)
        let tailAttached = abs(scrollView.contentView.bounds.origin.y - maxY) < 1.0
        let measuredHeight = MacComposerVoiceTranscriptView.measure(
            [(text: text, opacity: 1)],
            width: max(1, scrollView.contentView.bounds.width)
        )
        let contentExceedsViewport = documentHeight > viewportHeight + 1.0
        let fixedViewport = abs(viewportHeight - MacComposerVoiceTranscriptView.lineHeight * 2) < 1.0
        let passed = contentExceedsViewport && fixedViewport && tailAttached
        return [
            "passed": passed,
            "scrollView": true,
            "contentExceedsViewport": contentExceedsViewport,
            "fixedViewport": fixedViewport,
            "tailAttached": tailAttached,
            "viewportHeight": viewportHeight,
            "documentHeight": documentHeight,
            "documentLength": documentView.debugAttributedText.length,
            "measuredHeight": measuredHeight,
            "scrollWidth": scrollView.bounds.width,
            "clipWidth": scrollView.contentView.bounds.width,
            "originY": scrollView.contentView.bounds.origin.y,
            "documentRectHeight": scrollView.contentView.documentRect.height,
        ]
    }
}
#endif

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


#if DEBUG
@MainActor
private final class MacComposerFocusRegressionState {
    var text = ""
    var focused = true
    var nativeEditorHasText = false
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
            nativeEditorHasText: Binding(
                get: { state.nativeEditorHasText },
                set: { state.nativeEditorHasText = $0 }
            ),
            enabled: true,
            focusRequest: state.focusRequest,
            onRequestFocus: {
                state.focused = true
                state.focusRequest += 1
            },
            onSubmit: {},
            onSelection: { _ in },
            onTakeOver: {}
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

                    // Simulate visible native IME text before it commits. The
                    // persisted draft remains empty, but the placeholder must
                    // already be hidden because the NSTextView is not empty.
                    state.text = ""
                    coordinator.isApplying = true
                    replacement.string = "zhong"
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    coordinator.isApplying = false
                    let placeholderHiddenForNativeText = state.nativeEditorHasText
                        && !MacComposerPlaceholderPolicy.isVisible(
                            committedText: state.text,
                            nativeEditorHasText: state.nativeEditorHasText
                        )

                    replacement.string = ""
                    coordinator.isApplying = true
                    coordinator.textDidChange(
                        Notification(name: NSText.didChangeNotification, object: replacement)
                    )
                    coordinator.isApplying = false
                    let placeholderRestoredAfterClear = !state.nativeEditorHasText
                        && MacComposerPlaceholderPolicy.isVisible(
                            committedText: state.text,
                            nativeEditorHasText: state.nativeEditorHasText
                        )

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
                                && placeholderHiddenForNativeText
                                && placeholderRestoredAfterClear
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
                                "placeholderHiddenForNativeText": placeholderHiddenForNativeText,
                                "placeholderRestoredAfterClear": placeholderRestoredAfterClear,
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
/// Send / stop / steer circle: regular Liquid Glass tinted by role (as the
/// composer capsule); untinted when there is nothing to send. Tint animation
/// is scoped to this view (see the primary button note).
private struct MacPrimaryGlassCircle: View {
    let tint: Color?
    let fallback: Color
    var body: some View {
        if #available(macOS 26.0, *) {
            Circle().fill(.clear)
                .glassEffect(tint.map { Glass.regular.tint($0) } ?? Glass.regular, in: Circle())
                .animation(.easeInOut(duration: 0.22), value: tint)
        } else {
            Circle().animation(.easeInOut(duration: 0.22)) { $0.foregroundStyle(fallback) }
        }
    }
}

#endif
