#if os(iOS)
/// MessageInputView — Floating bottom input.
///
/// One glass capsule: [image / thumbnail] text [ⓧ] [mic] [send | stop].
/// It grows upward with multi-line text. Tapping the mic expands the same
/// capsule into two rows — a live transcript above [Cancel] level/time
/// [Edit] (the send circle stays beside the capsule) — and collapses back
/// when dictation ends.
///
/// Voice ↑ sends at once as an optimistic bubble that is corrected in place
/// and transmitted when correction completes (see IOSVoiceComposer).
/// Session mode is chosen in the chat header, not on the composer.

import SwiftUI
import PhotosUI

enum MessageComposerIntent: Equatable {
    case prompt
    case steer
    case answerQuestion
    case denyPermission
}

enum MessageComposerPolicy {
    static func intent(isBusy: Bool, hasPermission: Bool, hasQuestion: Bool) -> MessageComposerIntent {
        if hasPermission { return .denyPermission }
        if hasQuestion { return .answerQuestion }
        return isBusy ? .steer : .prompt
    }
}

enum IOSComposerMetrics {
    /// One-line capsule height (buttons keep >= 44pt touch targets).
    static let height: CGFloat = 48
    /// Primary (send / stop) circle — same as the chat's jump controls.
    static let control: CGFloat = 44
    /// Gap between the capsule and the primary button, and between stacked
    /// round controls (matches the jump controls' spacing).
    static let controlGap: CGFloat = 8
    /// Gap between the send circle and the ↓/↑ control above it (8 pt + 1 pt
    /// to balance the bordered glass controls against the solid circle).
    static let stackGap: CGFloat = 9
    /// Dictation box: its top lines up with the top of the round control
    /// stacked above the send circle (send is centred on the one-line row).
    static let recordingMinHeight: CGFloat = (height - control) / 2 + control + stackGap + control
    /// Stop: a deep red that stays calm in Dark Mode.
    static let stopRed = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.62, green: 0.17, blue: 0.17, alpha: 1)
            : UIColor(red: 0.78, green: 0.16, blue: 0.16, alpha: 1)
    })
}

struct MessageInputView: View {
    let sessionId: String
    var pendingPermission: PendingPermission? = nil
    var pendingQuestion: PendingQuestion? = nil
    var isCompacting: Bool = false
    var hasLiveCard: Bool = false
    var onHeightChange: (CGFloat) -> Void = { _ in }

    @Environment(AppState.self) private var appState
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var imageMimeType: String = "image/jpeg"
    /// Surfaces image-attach failures (too large after compression,
    /// unsupported format, etc.) so the user sees that the picker
    /// didn't silently swallow their selection.
    @State private var imageAttachError: String?
    /// Transient "couldn't send" hint. The draft is kept so nothing is lost.
    @State private var submitFailure: String?
    @State private var submitFailureTask: Task<Void, Never>?
    @State private var awaitingActive = false
    @State private var abortPending = false
    @State private var textSelection: TextSelection?
    @State private var selectionText = ""
    @State private var programmaticVoiceFocus = false
    @FocusState private var isFocused: Bool

    private static let inputBoxHeight: CGFloat = IOSComposerMetrics.height
    private var sessionStore: SessionStore { appState.sessionStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }
    private var sessionActive: Bool {
        session?.state == .active || session?.state == .compacting
    }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var isBusy: Bool { sessionActive || isCompacting || awaitingActive }
    private var isIdle: Bool { !isBusy }
    private var isStructuredResponse: Bool { pendingPermission != nil || pendingQuestion != nil }
    private var submissionIntent: MessageComposerIntent {
        MessageComposerPolicy.intent(
            isBusy: isBusy,
            hasPermission: pendingPermission != nil,
            hasQuestion: pendingQuestion != nil
        )
    }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasImage: Bool { imageData != nil }
    private var voiceController: KrakiVoiceInputController { appState.voiceInputController }
    private var voice: IOSVoiceComposer { appState.iosVoiceComposer }
    private var isRecordingHere: Bool { voice.isRecording(in: sessionId) }
    /// A sent voice message of this session is still being corrected. Typed
    /// sends wait for it so messages reach the agent in order.
    private var voiceSendPending: Bool {
        guard voice.sessionID == sessionId, let phase = voice.operation?.phase else { return false }
        if case .staged = phase { return true }
        return false
    }
    private var canSend: Bool {
        !isRecordingHere && !voiceSendPending && (isStructuredResponse ? hasText : (hasText || hasImage))
    }
    /// Agent running and nothing typed: the primary button stops the turn.
    /// As soon as there is something to send it becomes Send (steer).
    private var showsStop: Bool { canShowAbort && !hasText && !hasImage }
    private var canShowAbort: Bool { sessionActive || isCompacting || hasLiveCard }

    /// True when we can actually deliver a message right now —
    /// tentacle is online AND the relay channel is up. Drives the
    /// send button's enabled state and the offline-hint pill.
    /// Typing/voice/image picker remain fully functional regardless
    /// so the user can compose a message in advance.
    private var isDeviceReachable: Bool {
        guard let deviceId = session?.deviceId,
              let device = appState.deviceStore.devices[deviceId] else { return false }
        return device.online && appState.isFullyOnline
    }

    /// Short banner text to surface above the input row when sending
    /// wouldn't deliver right now. `nil` ⇒ no pill rendered.
    private var unreachableHint: String? {
        if let submitFailure { return submitFailure }
        guard let deviceId = session?.deviceId else { return nil }
        let device = appState.deviceStore.devices[deviceId]
        if device?.online != true {
            let name = device?.name ?? session?.deviceName ?? "Device"
            return "\(name) is offline — message will deliver when it reconnects."
        }
        if !appState.isFullyOnline {
            return "Reconnecting…"
        }
        return nil
    }

    /// Voice transcription is available anywhere this composer accepts text,
    /// including active-turn steering and structured responses.
    private var canShowVoiceToggle: Bool {
        VoiceComposerAccessPolicy.isVisible(
            capabilityAvailable: appState.voiceCapability != nil
        )
    }
    private var canStartVoice: Bool {
        VoiceComposerAccessPolicy.canStart(
            capabilityAvailable: appState.voiceCapability != nil,
            // A correction still flowing into this draft may be superseded.
            voiceControllerBusy: voiceController.isBusy
                && !(voice.sessionID == sessionId && voice.operation?.phase == .toDraft)
        )
    }

    private var isVoiceFailure: Bool {
        voiceController.hasFailure(for: sessionId)
    }

    var body: some View {
        composeCard
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { height in
                guard height > 0 else { return }
                onHeightChange(height)
            }
            .overlay(alignment: .top) {
                // Offline / reconnecting hint pill. Sits a few points
                // above the input row, full-width centered, low-key
                // tertiary text so it informs without alarming. Hidden
                // when the device is reachable.
                unreachableHintPill
                    .offset(y: -28)
                    .allowsHitTesting(false)
            }
            .task(id: sessionId) {
                if let owner = voice.sessionID, owner != sessionId { voice.depart(sessionID: owner) }
                textSelection = nil
            }
            .onDisappear { voice.depart(sessionID: sessionId) }
            .onChange(of: voice.editorRequest) { _, _ in
                guard voice.editorSessionID == sessionId, sessionStore.activeSessionId == sessionId else { return }
                applyVoiceSelection()
                programmaticVoiceFocus = true
                isFocused = true
            }
            .onChange(of: voice.selectionRequest) { _, _ in applyVoiceSelection() }
            .onChange(of: voice.dispatchSignal) { _, _ in
                // A staged voice prompt was just transmitted.
                if voice.dispatchedSessionID == sessionId { awaitingActive = true }
            }
            .onChange(of: isFocused) { _, focused in
                if focused && !programmaticVoiceFocus { voice.takeOver(sessionID: sessionId) }
                programmaticVoiceFocus = false
            }
            .onChange(of: session?.state) { _, newState in
                // A normal prompt's local latch ends at the first authoritative
                // session-state transition. Once active, subsequent submissions
                // are explicit steers; once idle, they are normal prompts.
                awaitingActive = false
                if newState == .idle { abortPending = false }
            }
            .onChange(of: appState.isFullyOnline) { _, online in
                if !online { abortPending = false }
            }
            .onChange(of: selectedPhoto) { _, newItem in
                Task { await loadPhoto(newItem) }
            }
            .alert(
                "Couldn't attach image",
                isPresented: Binding(
                    get: { imageAttachError != nil },
                    set: { if !$0 { imageAttachError = nil } }
                ),
                presenting: imageAttachError
            ) { _ in
                Button("OK", role: .cancel) { imageAttachError = nil }
            } message: { error in
                Text(error)
            }
    }

    // MARK: - Compose Card
    //
    // iMessage-style floating layout: no enclosing bar. The image
    // attach button, the input box capsule, and the send button each
    // have their own glass/material chrome and sit side-by-side with a
    // small horizontal gutter. Bottom placement is handled by the
    // parent's `safeAreaInset(edge: .bottom)`, which positions us
    // above the home indicator; a small bottom pad keeps the pills
    // from kissing the safe-area boundary.

    @ViewBuilder
    private var composeCard: some View {
        VStack(spacing: 8) {
            if isVoiceFailure { voiceFailureRow }
            // Permission/question controls live in the production live bubble.
            // The composer only changes its textual submission intent (answer
            // or deny-with-reason); it must not duplicate those action rows.

            // Single unified input row:
            inputRow
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Unified Input Row

    /// One glass capsule holds everything: [image] text [ⓧ] [mic] [send/stop].
    /// Dictation expands it in place into two rows (transcript + controls).
    /// Capsule + the primary button beside it. The button matches the chat's
    /// jump controls above it (44 pt circle, same trailing column, 8 pt gaps)
    /// and stays on the last line as the capsule grows.
    private var inputRow: some View {
        HStack(alignment: .bottom, spacing: IOSComposerMetrics.controlGap) {
            inputBox
            primaryButton
                .padding(.bottom, (Self.inputBoxHeight - IOSComposerMetrics.control) / 2)
        }
    }

    private static let boxShape = RoundedRectangle(cornerRadius: IOSComposerMetrics.height / 2, style: .continuous)

    /// Shared by the composer expand/collapse and the chat list's inset.
    static let expandAnimation = Animation.spring(response: 0.34, dampingFraction: 0.9)

    /// The same box throughout: dictation inserts the transcript row above
    /// and swaps the bottom row in place, so the box grows upward smoothly.
    private var inputBox: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isRecordingHere {
                recordingHeader
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)),
                                            removal: .opacity))
            }
            ZStack {
                if isRecordingHere {
                    recordingControls.transition(.opacity)
                } else {
                    restingBox.transition(.opacity)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: Self.inputBoxHeight)
        .background { inputBoxGlassBackground }
        .contentShape(Self.boxShape)
        .animation(Self.expandAnimation, value: isRecordingHere)
    }

    private var restingBox: some View {
        HStack(alignment: .bottom, spacing: 0) {
            imageSlot
            HStack(alignment: .center, spacing: 0) {
                textFieldForMode
                if hasText || hasImage { clearButton }
            }
            .frame(maxWidth: .infinity, minHeight: Self.inputBoxHeight)
            // The TextField only hit-tests its glyph rect: any other tap in
            // the text area (padding, edges) focuses it as well.
            .background {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { if !isFocused { isFocused = true } }
            }
            if canShowVoiceToggle { micButton }
        }
        .padding(.trailing, 2)
    }

    // MARK: - Dictation (two rows)

    private var recordingHeader: some View {
        recordingHeaderContent
            .frame(maxWidth: .infinity,
                   minHeight: IOSComposerMetrics.recordingMinHeight - Self.inputBoxHeight,
                   alignment: .topLeading)
    }

    private var recordingHeaderContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let imageData, let uiImage = UIImage(data: imageData) {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 40, height: 40)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.leading, 14)
                    .padding(.top, 10)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    liveTranscript
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.top, 12)
                        .padding(.bottom, 4)
                        .id("transcript")
                }
                .frame(maxHeight: 132)
                .fixedSize(horizontal: false, vertical: true)
                .onChange(of: voice.rawText) { _, _ in proxy.scrollTo("transcript", anchor: .bottom) }
            }
        }
    }

    private var recordingControls: some View {
            HStack(spacing: 6) {
                Button { withAnimation(Self.expandAnimation) { voice.cancel() } } label: {
                    Label("Cancel", systemImage: "xmark")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(Color.secondary.opacity(0.12), in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                .accessibilityIdentifier("voice-cancel")
                .accessibilityHint("Discards what you just said")
                VoiceLevelBars(levels: voiceController.levels)
                    .padding(.leading, 6)
                if let start = voice.recordingStartedAt {
                    TimelineView(.periodic(from: start, by: 1)) { context in
                        Text(Self.elapsed(from: start, to: context.date))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 4)
                Button { withAnimation(Self.expandAnimation) { voice.finishToDraft() } } label: {
                    Label("Edit", systemImage: "text.cursor")
                        .font(.subheadline.weight(.medium))
                        .padding(.horizontal, 12)
                        .frame(height: 36)
                        .background(Color.krakiPrimary.opacity(0.12), in: Capsule())
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.krakiPrimary)
                .accessibilityIdentifier("voice-to-text")
                .accessibilityHint("Stops listening and puts the text in the field to edit")
            }
            .padding(.leading, 8)
            .padding(.trailing, 6)
            .frame(height: Self.inputBoxHeight)
    }

    /// Existing draft text in the primary color, the live utterance dimmed
    /// (not editable yet) at the caret.
    private var liveTranscript: some View {
        let parts = voice.preview
        let hasSpeech = !parts.spoken.isEmpty
        return Group {
            if parts.prefix.isEmpty && parts.suffix.isEmpty && !hasSpeech {
                HStack(spacing: 7) {
                    Circle().fill(.red).frame(width: 7, height: 7)
                    Text(voiceListeningStatus).foregroundStyle(.secondary)
                }
            } else {
                Text(parts.prefix) + Text(parts.spoken).foregroundColor(.secondary) + Text(parts.suffix)
            }
        }
        .font(.body)
        .accessibilityIdentifier("voice-transcript")
    }

    private var voiceListeningStatus: String {
        switch voiceController.state {
        case .requestingPermission: return "Allow microphone access…"
        case .recording: return "Listening…"
        default: return "Starting…"
        }
    }

    private static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    @ViewBuilder
    private var inputBoxGlassBackground: some View {
        // Plain liquid glass. Session mode lives in the chat header.
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: Self.boxShape)
        } else {
            Self.boxShape.fill(.ultraThinMaterial)
        }
    }

    // MARK: - Microphone

    private var micButton: some View {
        Button(action: startVoice) {
            ZStack {
                LucideIcon(.mic, size: 22, strokeWidth: 2.1, color: .secondary)
                    .opacity(voice.isFinishing(in: sessionId) ? 0 : 1)
                if voice.isFinishing(in: sessionId) {
                    ProgressView().controlSize(.small).accessibilityLabel("Finishing transcription")
                }
            }
            .frame(width: 44, height: Self.inputBoxHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!canStartVoice)
        .opacity(canStartVoice || voice.isFinishing(in: sessionId) ? 1 : 0.4)
        .accessibilityIdentifier("chat-voice-microphone")
        .accessibilityLabel("Dictate")
        .accessibilityHint("Starts listening. Then send, edit the text, or cancel.")
    }

    @ViewBuilder
    private var voiceFailureRow: some View {
        HStack(spacing: 8) {
            Text(voiceStatusText)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss") {
                voiceController.clearFailure()
            }
            .buttonStyle(.plain)
            .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 48)
    }

    private var voiceStatusText: String {
        VoiceComposerPresentation.statusText(
            state: voiceController.state,
            rawText: voiceController.rawText,
            displayText: voiceController.displayText
        )
    }

    private func startVoice() {
        guard canStartVoice, let session else { return }
        let range = selectedRange
        voiceController.clearFailure()
        let context = VoiceSessionContextBuilder.build(session: session,
            recentMessages: appState.messageStore.recentFromDB(sessionId, limit: 20))
        withAnimation(Self.expandAnimation) {
            voice.begin(sessionID: sessionId, selection: range, context: context)
        }
        isFocused = false
    }

    /// ↑ while dictating. Prompts and steers go out as a bubble that is
    /// corrected in place and transmitted when correction completes. A
    /// structured reply (answer / deny reason) is reviewed in the field first.
    private func sendVoice() {
        guard isRecordingHere else { return }
        switch submissionIntent {
        case .answerQuestion, .denyPermission:
            withAnimation(Self.expandAnimation) { voice.finishToDraft() }
        case .prompt, .steer:
            let delivery: CommandSender.InputDelivery = submissionIntent == .steer ? .steer : .prompt
            let staged = withAnimation(Self.expandAnimation) {
                voice.send(attachments: imageAttachments, delivery: delivery)
            }
            guard staged else {
                showSubmitFailure()
                return
            }
            clearImage()
            didSubmitFromComposer()
        }
    }

    private var selectedRange: NSRange? {
        guard selectionText == text, let textSelection, case let .selection(range) = textSelection.indices else { return nil }
        return IOSVoiceComposer.selectionRange(range, in: text)
    }
    private func applyVoiceSelection() {
        guard voice.editorSessionID == sessionId || voice.sessionID == sessionId,
              let requested = voice.selectionRequest,
              let range = Range(IOSVoiceComposer.safeRange(requested, in: text), in: text) else { return }
        selectionText = text
        textSelection = TextSelection(range: range)
    }
    private var selectionBinding: Binding<TextSelection?> {
        Binding(get: { selectedRange != nil ? textSelection : nil }, set: { newSelection in
            let old = textSelection
            selectionText = text
            textSelection = newSelection
            if isFocused && old != newSelection && selectedRange != voice.selectionRequest {
                voice.takeOver(sessionID: sessionId)
            }
        })
    }

    // MARK: - Primary button (trailing edge of input box)
    //
    // Send, or Stop while the agent runs and nothing is typed. Typing turns a
    // Stop into Send (steer) in place; clearing the field turns it back.

    private enum PrimaryRole: Equatable { case send, stop, voiceSend }
    private var primaryRole: PrimaryRole {
        if isRecordingHere { return .voiceSend }
        return showsStop ? .stop : .send
    }
    private var primaryFill: Color {
        switch primaryRole {
        case .stop: return IOSComposerMetrics.stopRed
        case .voiceSend: return Color.krakiPrimary
        case .send: return canSend ? Color.krakiPrimary : Color(.systemGray4)
        }
    }

    /// Steering interjects into the running turn: same navy, a curved arrow.
    private func primaryGlyph(_ role: PrimaryRole) -> String {
        if role == .stop { return "stop.fill" }
        return submissionIntent == .steer ? "arrow.turn.right.up" : "arrow.up"
    }

    /// One circle for every role: its fill and glyph morph (Send ↔ Stop,
    /// grey ↔ active, dictation Send) instead of swapping views.
    private var primaryButton: some View {
        let role = primaryRole
        return Button {
            switch role {
            case .voiceSend: sendVoice()
            case .stop: requestAbort()
            case .send: handleModeSubmit()
            }
        } label: {
            // Animation is scoped to the fill and glyph style only: a
            // button-wide implicit animation also animates the chat's layout
            // on every update while a reply streams (costly on macOS).
            let glyph = primaryGlyph(role)
            let fill = primaryFill
            let morph = Animation.easeInOut(duration: 0.22)
            ZStack {
                Circle().animation(morph) { $0.foregroundStyle(fill) }
                ForEach(["arrow.up", "arrow.turn.right.up", "stop.fill"], id: \.self) { name in
                    Image(systemName: name)
                        .font(.system(size: name == "stop.fill" ? 14 : 18, weight: .bold))
                        .foregroundStyle(.white)
                        .animation(morph) {
                            $0.opacity(name == glyph && !(role == .stop && abortPending) ? 1 : 0)
                                .scaleEffect(name == glyph ? 1 : 0.6)
                        }
                }
                if role == .stop && abortPending {
                    ProgressView().controlSize(.small).tint(.white)
                }
            }
            .frame(width: IOSComposerMetrics.control, height: IOSComposerMetrics.control)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(role == .stop ? (abortPending || !isDeviceReachable) : false)
        .opacity(role == .stop ? (isDeviceReachable ? 1 : 0.5) : (role == .send && canSend && !isDeviceReachable ? 0.6 : 1))
        .accessibilityIdentifier(role == .voiceSend ? "voice-send" : role == .stop ? "chat-stop" : "chat-send")
        .accessibilityLabel(role == .stop ? "Stop agent" : sendAccessibilityLabel)
        .accessibilityHint(role == .stop ? "Aborts the current agent turn" : sendAccessibilityHint)
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

    private func requestAbort() {
        guard canShowAbort, !abortPending, isDeviceReachable else { return }
        if appState.commandSender?.abortSession(sessionId: sessionId) == true {
            abortPending = true
        }
    }

    // MARK: - Image Attach (single image)
    //
    // The attach icon itself becomes the thumbnail once an image is chosen:
    // tap to replace it, the small × removes it.

    @ViewBuilder
    private var imageSlot: some View {
        Group {
            if let imageData, let uiImage = UIImage(data: imageData) {
                ZStack(alignment: .topTrailing) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images, photoLibrary: .shared()) {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 32, height: 32)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .frame(width: 44, height: Self.inputBoxHeight)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Replace image")
                    Button { clearImage() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .symbolRenderingMode(.palette)
                            .foregroundStyle(.white, Color.black.opacity(0.6))
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .offset(x: -1, y: 3)
                    .accessibilityLabel("Remove image")
                }
            } else {
                PhotosPicker(selection: $selectedPhoto, matching: .images, photoLibrary: .shared()) {
                    LucideIcon(.imagePlus, size: 22, strokeWidth: 2.1, color: .secondary)
                        .frame(width: 44, height: Self.inputBoxHeight)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Attach image")
            }
        }
        .padding(.leading, 4)
        .disabled(!isIdle)
        .opacity(isIdle ? 1 : 0.4)
    }

    private var imageAttachments: [ImageAttachment]? {
        guard let imageData else { return nil }
        return [ImageAttachment(type: "image", mimeType: imageMimeType, data: imageData.base64EncodedString())]
    }

    // MARK: - Clear

    private var clearButton: some View {
        Button(action: clearDraft) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 17))
                .foregroundStyle(Color(.tertiaryLabel))
                .frame(width: 30, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-clear")
        .accessibilityLabel("Clear message")
    }

    private func clearDraft() {
        voice.takeOver(sessionID: sessionId)
        sessionStore.setDraft(sessionId, "")
        clearImage()
    }

    // MARK: - Mode-Aware Text Field

    private var textFieldForMode: some View {
        let placeholder: String = {
            switch submissionIntent {
            case .denyPermission: return "Deny with reason…"
            case .answerQuestion: return "Type your answer…"
            case .steer: return "Steer the agent…"
            case .prompt: return "Send a message…"
            }
        }()

        return TextField(placeholder, text: Binding(
            get: { text },
            set: { newValue in
                // UIKit echoes programmatic text during focus/selection updates.
                // An equal echo is not a user edit and must not bump the draft's
                // revision (otherwise it fences our own pending final).
                guard newValue != text else { return }
                voice.takeOver(sessionID: sessionId)
                // Selection callbacks can precede this text callback. Retain a
                // pending caret only once it is valid in the new snapshot.
                if let textSelection, case let .selection(range) = textSelection.indices,
                   IOSVoiceComposer.selectionRange(range, in: newValue) != nil {
                    selectionText = newValue
                }
                // Intercept newline insertions and treat them as a
                // submit. With `axis: .vertical`, the soft keyboard's
                // return key inserts `\n` into the text by default
                // and `.onSubmit` does not fire — so the user has no
                // way to send via the keyboard. Stripping the `\n` and
                // calling the submit handler routes the return key
                // through the same path as the in-app send icon,
                // matching `.submitLabel(.send)`'s visual hint.
                if newValue.hasSuffix("\n") {
                    let trimmed = String(newValue.dropLast())
                    sessionStore.setDraft(sessionId, trimmed)
                    handleModeSubmit()
                } else {
                    sessionStore.setDraft(sessionId, newValue)
                }
            }
        ), selection: selectionBinding, axis: .vertical)
        // Grows up to 5 lines, then scrolls inside the field.
        .lineLimit(1...5)
        .textFieldStyle(.plain)
        // System body (17pt default) and follows the user's Dynamic Type size.
        .font(.body)
        // The image slot clears the leading curve; 12pt vertical insets give
        // one line of body text the 48pt capsule height.
        .padding(.leading, 2)
        .padding(.trailing, 4)
        .padding(.vertical, 12)
        .focused($isFocused)
        .accessibilityIdentifier("chat-composer-text")
        .submitLabel(.send)
        .onSubmit { handleModeSubmit() }
    }

    // MARK: - Permission Action Row

    private func permissionActionRow(_ perm: PendingPermission) -> some View {
        HStack(spacing: 6) {
            Button {
                appState.commandSender?.approve(sessionId: sessionId, permissionId: perm.id)
            } label: {
                Text("Approve")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
            .modifier(GlassChoiceButtonModifier(tint: .green))

            Button {
                appState.commandSender?.alwaysAllow(sessionId: sessionId, permissionId: perm.id, toolKind: perm.toolName)
            } label: {
                Text("Always Allow")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
            .modifier(GlassChoiceButtonModifier(tint: .blue))

            Button {
                appState.commandSender?.deny(sessionId: sessionId, permissionId: perm.id)
            } label: {
                Text("Deny")
                    .font(.subheadline)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            }
            .modifier(GlassChoiceButtonModifier(tint: .red))
        }
    }

    // MARK: - Mode Submit Handlers

    private func handleModeSubmit() {
        guard !isRecordingHere else { return }
        // A correction still flowing into this draft stops at what is visible.
        if voice.sessionID == sessionId, voice.operation?.phase == .toDraft { voice.retireKeepingDraft() }
        switch submissionIntent {
        case .denyPermission:
            handlePermissionDenyWithReason()
        case .answerQuestion:
            handleQuestionAnswer()
        case .prompt, .steer:
            handleSend()
        }
    }

    private func handlePermissionDenyWithReason() {
        guard hasText, let perm = pendingPermission else { return }
        let reason = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard appState.commandSender?.deny(sessionId: sessionId, permissionId: perm.id, reason: reason) == true else {
            showSubmitFailure()
            return
        }
        sessionStore.setDraft(sessionId, "")
        didSubmitFromComposer()
    }

    private func handleQuestionAnswer() {
        guard hasText, let q = pendingQuestion else { return }
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard appState.commandSender?.answer(
            sessionId: sessionId,
            questionId: q.id,
            answer: answer,
            wasFreeform: true
        ) == true else {
            // Keep the typed answer so the user can retry.
            showSubmitFailure()
            return
        }
        sessionStore.setDraft(sessionId, "")
        didSubmitFromComposer()
    }

    /// Anything submitted from the composer is a new message: return the
    /// conversation to its newest edge. The keyboard stays up for follow-ups.
    private func didSubmitFromComposer() {
        submitFailureTask?.cancel()
        submitFailure = nil
        UIImpactFeedbackGenerator(style: .light).impactOccurred(intensity: 0.6)
        NotificationCenter.default.post(name: .krakiComposerSubmitted, object: nil,
                                        userInfo: ["sessionId": sessionId])
    }

    private func showSubmitFailure() {
        submitFailureTask?.cancel()
        withAnimation(.easeOut(duration: 0.2)) {
            submitFailure = "Couldn't send — your text is kept. Try again."
        }
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        submitFailureTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { submitFailure = nil }
        }
    }

    @ViewBuilder
    private var unreachableHintPill: some View {
        if let hint = unreachableHint {
            Text(hint)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    Capsule(style: .continuous)
                        .fill(.ultraThinMaterial)
                )
                .padding(.horizontal, 16)
                .transition(.opacity.combined(with: .offset(y: 4)))
                .animation(.easeInOut(duration: 0.2), value: hint)
        }
    }

    // MARK: - Actions

    private func handleSend() {
        guard canSend else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sendText = trimmed.isEmpty ? "[image]" : trimmed

        let attachments = imageAttachments

        let delivery: CommandSender.InputDelivery = submissionIntent == .steer ? .steer : .prompt
        guard appState.commandSender?.sendInput(
            sessionId: sessionId,
            text: sendText,
            attachments: attachments,
            delivery: delivery
        ) == true else {
            showSubmitFailure()
            return
        }

        sessionStore.setDraft(sessionId, "")
        clearImage()
        if delivery == .prompt { awaitingActive = true }
        didSubmitFromComposer()
    }

    private func clearImage() {
        imageData = nil
        selectedPhoto = nil
    }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self) else {
            await MainActor.run {
                imageAttachError = "Couldn't read that image."
                selectedPhoto = nil
            }
            return
        }
        guard let uiImage = UIImage(data: data) else {
            await MainActor.run {
                imageAttachError = "That file isn't a supported image format."
                selectedPhoto = nil
            }
            return
        }

        let maxDimension: CGFloat = 1024
        let maxSize = 3 * 1024 * 1024

        var targetImage = uiImage
        if uiImage.size.width > maxDimension || uiImage.size.height > maxDimension {
            let scale = maxDimension / max(uiImage.size.width, uiImage.size.height)
            let newSize = CGSize(width: uiImage.size.width * scale, height: uiImage.size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            targetImage = renderer.image { _ in uiImage.draw(in: CGRect(origin: .zero, size: newSize)) }
        }

        if let compressed = targetImage.jpegData(compressionQuality: 0.8), compressed.count <= maxSize {
            imageData = compressed; imageMimeType = "image/jpeg"
            return
        }
        if let compressed = targetImage.jpegData(compressionQuality: 0.6), compressed.count <= maxSize {
            imageData = compressed; imageMimeType = "image/jpeg"
            return
        }
        // Both compression attempts still exceeded the 3 MB cap.
        // Surface an explicit error and reset the picker so the user
        // can pick a smaller / different image instead of sending a
        // message with a silently missing attachment.
        await MainActor.run {
            imageAttachError = "That image is too large to send (over 3 MB after compression). Try a smaller picture."
            selectedPhoto = nil
            imageData = nil
        }
    }
}

// MARK: - Glass Modifiers (iOS 26 liquid glass with fallback)

private struct GlassCircleModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: Circle())
        } else {
            content.background(.ultraThinMaterial, in: Circle())
        }
    }
}

/// Liquid-glass button style for choice rows (question options, permission
/// actions). Uses the neutral translucent `.glass` material with the tint
/// applied to the label content — matching the New Session button pattern —
/// so the buttons read as glass pills rather than saturated solid fills.
/// Falls back to `.bordered` on iOS < 26 so semantic tints still show.
private struct GlassChoiceButtonModifier: ViewModifier {
    let tint: Color

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.glass)
                .tint(tint)
        } else {
            content
                .buttonStyle(.bordered)
                .tint(tint)
        }
    }
}

/// Live input level meter for dictation. Raw peaks from the microphone are
/// small (speech is mostly 0.02–0.3) and linear, so they are mapped through
/// decibels onto the bar height, then smoothed: fast attack, slower release,
/// and a centre-weighted envelope so the meter reads as a voice, not noise.
struct VoiceLevelBars: View {
    let levels: [Float]
    private static let barCount = 8
    private static let floorDB: Float = -48
    private static let ceilDB: Float = -6

    static func loudness(_ peak: Float) -> CGFloat {
        guard peak > 0 else { return 0 }
        let db = 20 * log10(peak)
        return CGFloat(max(0, min(1, (db - floorDB) / (ceilDB - floorDB))))
    }

    var body: some View {
        let recent = Array(levels.suffix(Self.barCount))
        let padded = Array(repeating: Float(0), count: max(0, Self.barCount - recent.count)) + recent
        HStack(spacing: 2.5) {
            ForEach(0..<Self.barCount, id: \.self) { i in
                let value = Self.loudness(padded[i])
                // Centre bars a bit taller than the edges.
                let weight = 0.6 + 0.4 * (1 - abs(CGFloat(i) - CGFloat(Self.barCount - 1) / 2) / (CGFloat(Self.barCount - 1) / 2))
                Capsule()
                    .fill(Color.krakiPrimary.opacity(0.45 + 0.5 * Double(value)))
                    .frame(width: 3, height: 4 + value * weight * 20)
            }
        }
        .frame(height: 26)
        .animation(.spring(response: 0.16, dampingFraction: 0.72), value: levels)
        .accessibilityHidden(true)
    }
}


#endif
