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
/// Dictation keeps one row until it wraps; multi-line actions share a column.
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
    /// Space below the Composer row: keeps the capsule and the right-hand
    /// control column off the window's bottom edge.
    static let bottomPadding: CGFloat = 12
    /// Outside the scrolling viewport: retained even when text scrolls.
    static let textVerticalPadding: CGFloat = 8
    static let maxVisibleTextLines: CGFloat = 3
    #if DEBUG
    /// Off-screen snapshot tests: cacheDisplay cannot draw Liquid Glass (nor
    /// anything composited into it), so draw flat fills instead.
    static var snapshotFlatGlass = false
    #endif
    static var usesGlass: Bool {
        #if DEBUG
        if snapshotFlatGlass { return false }
        #endif
        return true
    }
    static var minimumTextHeight: CGFloat { capsuleHeight - textVerticalPadding * 2 }
    /// Distance from the chat bottom to the bottom of the ↓ jump control.
    static var jumpControlBottom: CGFloat {
        bottomPadding + (capsuleHeight - control) / 2 + control + stackGap
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
    @State private var showVoiceConsent = false
    @State private var composerFocusRequest = 0
    @State private var isFocused = false
    @State private var nativeEditorHasText = false
    @State private var selection: NSRange?
    /// Widths of the editor / recording surface (stable while typing), so
    /// the height they will take is known in the same update as the text.
    @State private var textInputWidth: CGFloat = 0
    /// Width of the resting box (constant while typing).
    @State private var restingWidth: CGFloat = 0
    private var showsClear: Bool { hasText || hasImage }

    /// Multi-line drafts use two rows: the text spans the box, the controls
    /// sit in a row below (as on iOS, and as dictation). Decided from the
    /// one-row width only, so it switches once at the wrap.
    private var stacksRows: Bool {
        guard hasText, restingWidth > 1 else { return false }
        let oneRowText = restingWidth - 44 - (showsClear ? 26 : 0) - (canShowVoice ? 32 : 0) - 5 - 8
        return MacComposerScrollableTextInput.fittedHeight(text, width: oneRowText)
            > MacComposerMetrics.minimumTextHeight + 0.5
    }
    @State private var voiceSurfaceWidth: CGFloat = 0

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
        // Connection state belongs to the title area, never above the input:
        // reconnecting is silent and messages queue until it is back. Only a
        // computer that really can't receive right now is worth a note here.
        guard appState.hasCompletedInitialConnect, let deviceId = session?.deviceId else { return nil }
        let device = appState.deviceStore.devices[deviceId]
        if device?.online != true {
            let name = device?.name ?? session?.deviceName ?? "Device"
            return "\(name) is offline — message will deliver when it reconnects."
        }
        return nil
    }

    var body: some View {
        composeCard
            .alert(VoiceConsent.title, isPresented: $showVoiceConsent) {
                Button(VoiceConsent.continueButton) {
                    VoiceConsent.grant()
                    handleVoiceButton()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(VoiceConsent.message)
            }
            .overlay(alignment: .top) {
                unreachableHintPill
                    .offset(y: -28)
                    .allowsHitTesting(false)
            }
            .settlesComposerLatches(sessionId: sessionId, state: session?.state,
                                    awaitingActive: $awaitingActive, abortPending: $abortPending)
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
        .padding(.bottom, MacComposerMetrics.bottomPadding)
        .frame(maxWidth: .infinity)
    }

    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: MacComposerMetrics.controlGap) {
            inputBox
            primaryButton
                .padding(.bottom, (Self.inputBoxHeight - MacComposerMetrics.control) / 2)
        }
        // Growing / shrinking (a new line, the transcript wrapping) eases
        // instead of jumping; the bottom edge stays put, so it grows upward.
        .animation(.easeOut(duration: 0.18), value: contentHeightKey)
    }

    /// The height the box's content will take for the current text.
    private var contentHeightKey: CGFloat {
        if voiceOwnsComposer {
            let pieces = MacComposerVoiceTranscriptOnly.pieces(controller: voiceController, preview: voiceComposer.preview)
            return 10_000 + MacVoiceSurfaceLayout(pieces: pieces).geometry(width: voiceSurfaceWidth).height
        }
        return (stacksRows ? 1_000 : 0) + MacComposerScrollableTextInput.fittedHeight(text, width: textInputWidth)
    }

    private var inputBox: some View {
        Group {
            if voiceOwnsComposer {
                HStack(alignment: .center, spacing: 0) {
                    imageSlot
                    MacComposerVoiceSurface(
                        controller: voiceController,
                        preview: voiceComposer.preview,
                        onFinish: { voiceComposer.finishToDraft() },
                        onCancel: { voiceComposer.cancel() }
                    )
                    .onGeometryChange(for: CGFloat.self) { $0.size.width - 9 } action: { voiceSurfaceWidth = $0 }
                }
            } else {
                // One layout places the same views in one or two rows: the
                // native editor (focus, IME) is never rebuilt at the wrap.
                MacComposerRestingLayout(stacked: stacksRows, showsClear: showsClear, showsMic: canShowVoice) {
                    imageSlot
                    textFieldForMode
                    clearButton
                        .opacity(showsClear ? 1 : 0)
                        .allowsHitTesting(showsClear)
                        .accessibilityHidden(!showsClear)
                    inlineVoiceButton
                        .opacity(canShowVoice ? 1 : 0)
                        .allowsHitTesting(canShowVoice)
                        .accessibilityHidden(!canShowVoice)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { restingWidth = $0 }
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
        if #available(macOS 26.0, *), MacComposerMetrics.usesGlass {
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
                uncorrectedRange: voiceComposer.uncorrectedRange(in: sessionId),
                onRequestFocus: requestComposerFocus,
                onSubmit: handleModeSubmit,
                onSelection: { selection = $0 },
                onTakeOver: { voiceComposer.takeOver(sessionID: sessionId) }
            )
            .padding(.leading, 0)
            .padding(.trailing, 4)
            .padding(.vertical, MacComposerMetrics.textVerticalPadding)
            .onGeometryChange(for: CGFloat.self) { $0.size.width - 4 } action: { textInputWidth = $0 }
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
        guard VoiceConsent.isGranted else {
            showVoiceConsent = true
            return
        }
        Self.playVoiceStartCue()
        voiceController.clearFailure()
        isFocused = false
        let voiceContext = VoiceSessionContextBuilder.build(
            session: session,
            recentMessages: appState.messageStore.recentFromDB(sessionId, limit: 20)
        )
        voiceComposer.begin(sessionID: sessionId, selection: selection, context: voiceContext)
    }

    static func playVoiceStartCue() {
        if NativeTestRuntime.isHeadlessTestHost { return } // silent local test runs
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
        .background {
            #if DEBUG
            MacComposerControlGeometryProbe(identifier: "chat-attach-image")
            #endif
        }
        .accessibilityIdentifier("chat-attach-image")
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
        // Any submission resolves a voice failure note ("text is back in the box").
        if voiceController.hasFailure(for: sessionId) { voiceController.clearFailure() }
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

// MARK: - Resting layout

/// The resting Composer: [image] text [clear] [mic] on one row, or — once
/// the draft wraps — the text across the box with the controls in a row
/// below (the iOS Composer's shape, and dictation's: text over controls).
/// Subviews: image, text, clear, mic (always present; hidden ones invisible).
struct MacComposerRestingLayout: Layout {
    var stacked: Bool
    var showsClear: Bool
    var showsMic: Bool
    var rowHeight: CGFloat = MacComposerMetrics.capsuleHeight
    static let stackedLeading: CGFloat = 12
    /// The text's bottom padding and the row's top inset overlap by this.
    static let rowOverlap: CGFloat = 6

    private func frames(width: CGFloat, _ s: Subviews) -> (frames: [CGRect], height: CGFloat) {
        let image = s[0].sizeThatFits(.unspecified)
        let clear = s[2].sizeThatFits(.unspecified)
        let mic = s[3].sizeThatFits(.unspecified)
        let clearW = showsClear ? clear.width : 0, micW = showsMic ? mic.width : 0
        if stacked {
            let textW = max(1, width - Self.stackedLeading)
            let textH = s[1].sizeThatFits(ProposedViewSize(width: textW, height: nil)).height
            let rowTop = max(0, textH - Self.rowOverlap)
            return ([CGRect(x: 0, y: rowTop, width: image.width, height: rowHeight),
                     CGRect(x: Self.stackedLeading, y: 0, width: textW, height: textH),
                     CGRect(x: width - micW - clear.width, y: rowTop + (rowHeight - clear.height) / 2,
                            width: clear.width, height: clear.height),
                     CGRect(x: width - mic.width, y: rowTop + (rowHeight - mic.height) / 2,
                            width: mic.width, height: mic.height)], rowTop + rowHeight)
        }
        let textW = max(1, width - image.width - clearW - micW)
        let textH = s[1].sizeThatFits(ProposedViewSize(width: textW, height: nil)).height
        let height = max(rowHeight, textH)
        return ([CGRect(x: 0, y: (height - image.height) / 2, width: image.width, height: image.height),
                 CGRect(x: image.width, y: 0, width: textW, height: height),
                 CGRect(x: image.width + textW, y: height - clear.height, width: clear.width, height: clear.height),
                 CGRect(x: width - mic.width, y: height - mic.height, width: mic.width, height: mic.height)], height)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 600
        return CGSize(width: width, height: frames(width: width, subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 4 else { return }
        for (view, f) in zip(subviews, frames(width: bounds.width, subviews).frames) {
            view.place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), anchor: .topLeading,
                       proposal: ProposedViewSize(f.size))
        }
    }
}

/// Send / stop / steer circle: regular Liquid Glass tinted by role (as the
/// composer capsule); untinted when there is nothing to send. Tint animation
/// is scoped to this view (see the primary button note).
private struct MacPrimaryGlassCircle: View {
    let tint: Color?
    let fallback: Color
    var body: some View {
        if #available(macOS 26.0, *), MacComposerMetrics.usesGlass {
            Circle().fill(.clear)
                .glassEffect(tint.map { Glass.regular.tint($0) } ?? Glass.regular, in: Circle())
                .animation(.easeInOut(duration: 0.22), value: tint)
        } else {
            Circle().animation(.easeInOut(duration: 0.22)) { $0.foregroundStyle(fallback) }
        }
    }
}

#endif
