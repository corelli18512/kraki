#if os(iOS)
/// MessageInputView — Floating bottom input, iMessage-style.
///
/// No enclosing bar. Three pill-shaped components sit side by side
/// above the home indicator, each with its own glass/material chrome:
///   ① Optional pending action row (permission buttons / question choices)
///   ② A single unified input row:
///       [image attach] [voice/keyboard toggle + text field
///        (or hold-to-talk pill)] [send button with mode swipe]
///
/// In voice mode, the input box's INNER content morphs into a
/// press-and-hold "Hold to Talk" prompt — the box's outer chrome
/// (voice/keyboard toggle, mode-color strip, send icon, glass
/// background) stays exactly the same so the size doesn't shift.
/// The voice toggle still flips back to keyboard mode. The send
/// icon dims (no draft text yet) but is still tap-able once
/// transcription fills the draft.
///
/// The send/stop button doubles as the mode selector: dragging it
/// horizontally reveals an adjacent mode color through the liquid-glass
/// capsule (max one block of travel, momentum-friendly). The fully
/// expanded segmented control lives in the session settings sheet
/// (SessionInfoSheet) for explicit mode changes.

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
    @State private var awaitingActive = false
    @State private var abortPending = false
    @State private var voiceDraftPrefix = ""
    @FocusState private var isFocused: Bool

    // Mode swipe — the send icon doubles as the mode selector.
    // Swiping it horizontally cycles SessionMode (looping). The input
    // box's glass tint blends between adjacent mode colors live during
    // the swipe; on release a tap = send, a flick or 40% drag = mode
    // commit. Visual swipe travel is clamped to ±`modeStepWidth`.
    //
    // `rawDragX` is the live horizontal drag translation (clamped).
    // `dragStartMode` snapshots the mode at gesture start so tint
    // math is stable across the drag.
    @State private var rawDragX: CGFloat = 0
    @State private var dragStartMode: SessionMode? = nil
    @State private var measuredInputBoxWidth: CGFloat = 0

    // Mode-change toast (liquid-glass capsule above the send icon).
    // Only triggered by an actual user-initiated commit (via the
    // swipe), not by sync from the server or initial load.
    @State private var showModeToast = false
    @State private var modeToastMode: SessionMode = .discuss
    @State private var modeToastTask: Task<Void, Never>? = nil

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]
    private static let inputBoxHeight: CGFloat = 42
    private static let commitDistanceFraction: CGFloat = 0.4
    private static let momentumVelocity: CGFloat = 500   // pt/s

    /// Width of one "step" — clamped to the measured input box width
    /// so a full-distance swipe can fully replace the visible mode
    /// color with the adjacent one. Falls back to a sane default
    /// while the box hasn't been measured yet.
    private var modeStepWidth: CGFloat {
        max(80, measuredInputBoxWidth)
    }

    private var currentSessionMode: SessionMode {
        appState.sessionStore.sessionModes[sessionId]
            ?? session?.mode
            ?? .discuss
    }

    /// The mode whose color tint is centered. We snapshot the start
    /// mode at gesture start so tint math stays stable across the drag
    /// (in-drag commits would otherwise re-anchor the interpolation).
    private var tintBaseMode: SessionMode {
        dragStartMode ?? currentSessionMode
    }

    /// Live tint color for the input box: blends linearly between the
    /// base mode's color and the adjacent mode's color based on the
    /// drag progress (rawDragX / modeStepWidth, clamped to ±1). At
    /// rest this is just the current mode's color.
    private var inputBoxModeTint: Color {
        let modes = Self.allModes
        let count = modes.count
        let baseIdx = modes.firstIndex(of: tintBaseMode) ?? 1
        let progress = max(-1, min(1, rawDragX / modeStepWidth))
        if progress == 0 { return Color.modeColor(modes[baseIdx]) }
        // Drag RIGHT (positive dx) → previous mode tint enters.
        let neighborIdx: Int = progress > 0
            ? ((baseIdx - 1) % count + count) % count
            : ((baseIdx + 1) % count + count) % count
        return Self.blendColors(
            Color.modeColor(modes[baseIdx]),
            Color.modeColor(modes[neighborIdx]),
            t: abs(progress)
        )
    }

    private static func blendColors(_ a: Color, _ b: Color, t: CGFloat) -> Color {
        let ua = UIColor(a)
        let ub = UIColor(b)
        var (r1, g1, b1, a1): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        var (r2, g2, b2, a2): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
        ua.getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        ub.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        let tt = max(0, min(1, t))
        return Color(
            red: Double(r1 + (r2 - r1) * tt),
            green: Double(g1 + (g2 - g1) * tt),
            blue: Double(b1 + (b2 - b1) * tt),
            opacity: Double(a1 + (a2 - a1) * tt)
        )
    }

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
    private var voiceOwnsComposer: Bool {
        voiceController.isBusy && voiceController.activeSessionID == sessionId
    }
    private var canSend: Bool {
        !voiceOwnsComposer && (isStructuredResponse ? hasText : (hasText || hasImage))
    }
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

    /// Product voice input is advertised by authenticated Head capability and
    /// stays hidden for structured permission/question responses.
    private var canShowVoiceToggle: Bool {
        appState.voiceCapability != nil && !isStructuredResponse
    }

    private var isVoiceFailure: Bool {
        if case .failed = voiceController.state { return true }
        return false
    }

    var body: some View {
        composeCard
            .onGeometryChange(for: CGFloat.self) { proxy in
                proxy.size.height
            } action: { height in
                guard height > 0 else { return }
                onHeightChange(height)
            }
            .overlay(alignment: .topTrailing) {
                // Mode-change toast — floats above the send icon
                // with a small gap (~10pt) above the input row.
                modeToast
                    .offset(x: -23, y: -32)
                    .allowsHitTesting(false)
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
                if let activeVoiceSession = voiceController.activeSessionID,
                   activeVoiceSession != sessionId {
                    voiceController.cancel()
                }
            }
            .onDisappear {
                if voiceController.activeSessionID == sessionId {
                    voiceController.cancel()
                }
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

    private var inputRow: some View {
        HStack(spacing: 8) {
            imageAttachButton
            inputBox
            if canShowAbort { abortButton }
        }
        .animation(.easeInOut(duration: 0.2), value: voiceOwnsComposer)
    }

    /// The input box. Voice/keyboard toggle on the LEFT, content in
    /// the middle (text field in text mode, hold-to-talk pill in voice
    /// mode), and the send icon on the RIGHT. The whole box has a
    /// liquid-glass capsule background tinted by the current session
    /// mode color (blends live during swipe on the send icon).
    ///
    /// Voice/keyboard toggle on the LEFT, content in the middle
    /// (text field in text mode, hold-to-talk prompt in voice mode),
    /// send icon on the RIGHT. The chrome (glass + mode-color strip)
    /// and outer dimensions are identical in both modes — only the
    /// middle content swaps. This way pressing the mic just morphs
    /// the input box's content without resizing or losing the swipe
    /// strip / voice toggle / send icon.
    private var inputBox: some View {
        Group {
            if voiceOwnsComposer {
                voiceInputSurface
            } else {
                HStack(alignment: .center, spacing: 0) {
                    if canShowVoiceToggle { voiceToggleButton }
                    textFieldForMode
                    sendIconButton
                }
            }
        }
        .frame(maxWidth: .infinity)
        // `minHeight` (not fixed `height`) so the TextField's
        // `.lineLimit(1...3)` can actually expand vertically when the
        // user types past one line. Center alignment vertically
        // centers the placeholder / single-line text alongside the
        // mic and send icons; when text grows past 1 line, the
        // HStack grows symmetrically — close enough to iMessage that
        // the icons appear to stay attached to the box.
        .frame(minHeight: Self.inputBoxHeight)
        .background { inputBoxGlassBackground }
        .contentShape(Capsule())
        .simultaneousGesture(inputBoxModeSwipeGesture)
        .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
    }

    @ViewBuilder
    private var inputBoxGlassBackground: some View {
        let shape = Capsule()
        ZStack(alignment: .bottom) {
            // Plain iOS 26 liquid glass capsule — no full-box tint;
            // the mode color lives only in the thin strip below.
            if #available(iOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: shape)
            } else {
                shape.fill(.ultraThinMaterial)
            }

            // Thin mode-color strip pinned to the bottom edge of the
            // capsule. Renders 3 horizontal blocks (prev / base /
            // next mode) wider than the box; offset by `rawDragX` so
            // it slides with the finger, peeking the adjacent
            // colors in from the swipe direction. Clipped to the
            // capsule so the colors hug the bottom curvature.
            swipeBottomStrip
                .clipShape(shape)
                .allowsHitTesting(false)
        }
    }

    private var swipeBottomStrip: some View {
        GeometryReader { proxy in
            let modes = Self.allModes
            let count = modes.count
            let baseIdx = modes.firstIndex(of: tintBaseMode) ?? 1
            let prevIdx = ((baseIdx - 1) % count + count) % count
            let nextIdx = ((baseIdx + 1) % count + count) % count
            let w = proxy.size.width
            let stripHeight: CGFloat = 1.5
            let opacity: Double = 0.95
            HStack(spacing: 0) {
                Color.modeColor(modes[prevIdx]).opacity(opacity)
                    .frame(width: w, height: stripHeight)
                Color.modeColor(modes[baseIdx]).opacity(opacity)
                    .frame(width: w, height: stripHeight)
                Color.modeColor(modes[nextIdx]).opacity(opacity)
                    .frame(width: w, height: stripHeight)
            }
            // The 3-block strip is anchored so the BASE block fully
            // covers the visible window at rest (`rawDragX == 0`).
            // `rawDragX` then slides the strip with the finger up to
            // ±w, peeking the adjacent block fully into view.
            .offset(x: -w + rawDragX)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .onAppear { measuredInputBoxWidth = w }
            .onChange(of: w) { _, newW in measuredInputBoxWidth = newW }
        }
    }

    /// Horizontal swipe gesture that cycles SessionMode, attached to
    /// the WHOLE input box (not just the send icon) so the user can
    /// swipe anywhere on the box. Uses `simultaneousGesture` so taps
    /// on the inner TextField, voice toggle, and send icon still
    /// reach their own gesture handlers. `minimumDistance: 10`
    /// prevents an incidental finger jiggle from triggering a swipe.
    /// The horizontal-vs-vertical guard runs only at the FIRST motion
    /// event so once we've committed to a horizontal swipe, vertical
    /// drift doesn't cancel it.
    private var inputBoxModeSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                guard !voiceOwnsComposer else { return }
                if dragStartMode == nil {
                    // Lock in: only start a swipe if the first
                    // motion is more horizontal than vertical.
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

    // MARK: - Voice Toggle (lives inside the input box, leading edge)

    private var voiceToggleButton: some View {
        Button(action: handleVoiceButton) {
            LucideIcon(.mic, size: 21, strokeWidth: 2.2, color: .secondary)
                .frame(width: 40, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isIdle)
        .opacity(isIdle ? 1 : 0.4)
        .padding(.leading, 6)
        .accessibilityLabel("Start voice input")
        .accessibilityHint("Transcribes speech into the current draft")
    }

    private var voiceInputSurface: some View {
        IOSVoiceComposerSurface(
            pieces: voiceTranscriptPieces,
            state: voiceController.state,
            statusText: voiceStatusText,
            onFinish: { voiceController.finish() }
        )
        .frame(minHeight: Self.inputBoxHeight)
    }

    private var voiceTranscriptPieces: [(text: String, opacity: Double)] {
        VoiceComposerPresentation.transcriptPieces(
            prefix: voiceDraftPrefix,
            state: voiceController.state,
            rawText: voiceController.rawText,
            correctionSource: voiceController.correctionSource,
            correctionText: voiceController.correctionText,
            correctionSourceOffset: voiceController.correctionSourceOffset
        )
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
                voiceDraftPrefix = ""
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

    private func handleVoiceButton() {
        if voiceController.activeSessionID == sessionId {
            if voiceController.isRecording { voiceController.finish() }
            return
        }
        guard isIdle, let session else { return }
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
                    isFocused = true
                }
            )
        }
    }

    // MARK: - Send Icon (trailing edge of input box)
    //
    // The arrow always submits the composer's contextual action. Session-level
    // abort lives in the navigation bar, so active turns no longer replace the
    // send affordance or disable the text field.

    private var sendIconButton: some View {
        Button(action: handleModeSubmit) {
            sendIconGlyph
                .frame(width: 34, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(sendAccessibilityLabel)
        .accessibilityHint(sendAccessibilityHint)
        .opacity(sendButtonOpacity)
        .padding(.trailing, 6)
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

    private var sendButtonOpacity: Double {
        if !canSend { return 0.4 }
        if !isDeviceReachable { return 0.5 }
        return 1
    }

    private var sendIconGlyph: some View {
        Image(systemName: "arrow.right")
            .font(.system(size: 16, weight: .bold))
            .foregroundStyle(Color.modeColor(currentSessionMode))
            .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
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

    private func requestAbort() {
        guard canShowAbort, !abortPending, isDeviceReachable else { return }
        if appState.commandSender?.abortSession(sessionId: sessionId) == true {
            abortPending = true
        }
    }

    // MARK: - Image Attach

    @ViewBuilder
    private var imageAttachButton: some View {
        PhotosPicker(
            selection: $selectedPhoto,
            matching: .images,
            photoLibrary: .shared()
        ) {
            if let imageData, let uiImage = UIImage(data: imageData) {
                ZStack(alignment: .topTrailing) {
                    Image(uiImage: uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(height: Self.inputBoxHeight)
                        .frame(maxWidth: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                    Button { clearImage() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary, .ultraThinMaterial)
                    }
                    .offset(x: 4, y: -4)
                }
            } else {
                LucideIcon(.imagePlus, size: 22, strokeWidth: 2.25, color: .secondary)
                    .frame(width: Self.inputBoxHeight, height: Self.inputBoxHeight)
                    .modifier(GlassCircleModifier())
                    .contentShape(Rectangle())
            }
        }
        .disabled(!isIdle || voiceOwnsComposer)
        .opacity(isIdle && !voiceOwnsComposer ? 1 : 0.4)
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
        ), axis: .vertical)
        // Caps the input box at ~2.5 visible lines. SwiftUI's lineLimit
        // is integer-only, so we use a max of 3 wrapped lines and rely
        // on the keyboard-return → send interception above to keep the
        // average case to 1–2 lines of organic content.
        .lineLimit(1...3)
        .textFieldStyle(.plain)
        .font(.system(size: 16))
        // Leading inset clears the capsule's rounded end now that the
        // voice toggle is gone; trailing stays tight against the send
        // icon which provides its own breathing room.
        .padding(.leading, 18)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .focused($isFocused)
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
        appState.commandSender?.deny(sessionId: sessionId, permissionId: perm.id, reason: reason)
        sessionStore.setDraft(sessionId, "")
        isFocused = false
    }

    private func handleQuestionAnswer() {
        guard hasText, let q = pendingQuestion else { return }
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        appState.commandSender?.answer(
            sessionId: sessionId,
            questionId: q.id,
            answer: answer,
            wasFreeform: true
        )
        sessionStore.setDraft(sessionId, "")
        isFocused = false
    }

    // MARK: - Send action

    private func handleModeSwipeChanged(_ dx: CGFloat) {
        if dragStartMode == nil { dragStartMode = currentSessionMode }
        // Rubber-band beyond ±modeStepWidth so the strip can over-
        // travel slightly with momentum (then snap back via spring),
        // but the "useful" range still tops out at one full step.
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
        let baseIdx = modes.firstIndex(of: baseMode) ?? 1

        let dx = rawDragX
        let distanceCommit = abs(dx) >= Self.commitDistanceFraction * modeStepWidth
        // Momentum commit: a fast flick in the same direction as the
        // drag wins even if the finger only moved a short distance.
        let velocityCommit = abs(velocity) >= Self.momentumVelocity
            && dx != 0
            && (velocity > 0) == (dx > 0)
        let shouldCommit = distanceCommit || velocityCommit

        // Resolve commit direction & visual target offset.
        //   Drag RIGHT (dx > 0) → previous mode peeked in from left
        //   → commit step −1, strip ends at +stepWidth (prev block
        //   fully covers the window).
        //   Drag LEFT  (dx < 0) → next mode → step +1, strip ends at
        //   −stepWidth.
        let commitStep: Int = shouldCommit ? (dx > 0 ? -1 : 1) : 0
        let targetOffset: CGFloat = commitStep == 0
            ? 0
            : -CGFloat(commitStep) * modeStepWidth

        // Fire commit + haptic at release start (not after the spring
        // settles) so the send arrow color begins its own cross-fade
        // animation immediately as the strip springs into place. The
        // strip itself stays anchored to `dragStartMode` for the
        // duration of the spring (so its visual content is stable),
        // and the silent rebase in the completion handler swaps it
        // over to the new mode at offset 0 — by which time the
        // currentSessionMode color matches the visible block, so the
        // swap is invisible.
        if commitStep != 0 {
            let targetIdx = ((baseIdx + commitStep) % count + count) % count
            let newMode = modes[targetIdx]
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            appState.commandSender?.setSessionMode(sessionId: sessionId, mode: newMode)
            presentModeToast(newMode)
        }

        // Physical spring driven by the gesture's exit velocity:
        // .interpolatingSpring with non-zero `initialVelocity` carries
        // the swipe momentum into the rest position, so a hard fling
        // overshoots+settles and a soft drop just eases home. The
        // velocity is normalized by the remaining distance so units
        // make sense to the spring.
        let remaining = targetOffset - rawDragX
        let normalizedVelocity = remaining == 0 ? 0 : Double(velocity / remaining)
        let physicsSpring: Animation = .interpolatingSpring(
            mass: 1,
            stiffness: 180,
            damping: 22,
            initialVelocity: normalizedVelocity
        )

        withAnimation(physicsSpring) {
            rawDragX = targetOffset
        } completion: {
            // Silent rebase: strip rebuilds with the new
            // currentSessionMode at the center, rawDragX = 0 leaves
            // it visually identical (same color is already centered).
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) {
                dragStartMode = nil
                rawDragX = 0
            }
        }
    }

    // MARK: - Mode-Change Toast

    private func presentModeToast(_ mode: SessionMode) {
        modeToastMode = mode
        modeToastTask?.cancel()
        withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
            showModeToast = true
        }
        modeToastTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1300))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                showModeToast = false
            }
        }
    }

    @ViewBuilder
    private var modeToast: some View {
        if showModeToast {
            ModeChangeToast(mode: modeToastMode)
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

        var attachments: [ImageAttachment]?
        if let imageData {
            let base64 = imageData.base64EncodedString()
            attachments = [ImageAttachment(type: "image", mimeType: imageMimeType, data: base64)]
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

// MARK: - Mode-Change Toast

/// Tiny liquid-glass capsule that pops above the send button when the
/// user commits a mode change via the swipe. Shows a mode-colored dot
/// next to the mode name so the user gets a clear visual confirmation
/// of the new mode without having to read the strip color.
private struct ModeChangeToast: View {
    let mode: SessionMode

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(Color.modeColor(mode))
                .frame(width: 7, height: 7)
            // Sizing trick: render the longest mode name invisibly
            // to fix the label width, then overlay the actual mode
            // name on top. This way the toast doesn't reflow when
            // names of different lengths swap in rapid succession.
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
        // Slightly longer easeInOut + softer curve for a smoother
        // crossfade between mode labels and dot colors during rapid
        // swipes.
        .animation(.easeInOut(duration: 0.35), value: mode)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background {
            if #available(iOS 26.0, *) {
                Color.clear.glassEffect(.regular, in: Capsule())
            } else {
                Capsule().fill(.ultraThinMaterial)
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 3, y: 1)
    }

    private static let labelFont: Font = .system(size: 13, weight: .medium)

    /// Longest of the four mode names, used to pin the label width.
    private static let widestModeName: String = {
        ["Safe", "Discuss", "Execute", "Delegate"].max(by: { $0.count < $1.count }) ?? "Delegate"
    }()
}

#endif

