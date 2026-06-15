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

struct MessageInputView: View {
    let sessionId: String
    var pendingPermission: PendingPermission? = nil
    var pendingQuestion: PendingQuestion? = nil

    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var imageMimeType: String = "image/jpeg"
    /// Surfaces image-attach failures (too large after compression,
    /// unsupported format, etc.) so the user sees that the picker
    /// didn't silently swallow their selection.
    @State private var imageAttachError: String?
    @State private var awaitingActive = false
    @FocusState private var isFocused: Bool

    // Voice
    @State private var speech = SpeechRecognizer()
    /// Persists across sessions + app launches on this device. The
    /// user's last keyboard-vs-mic choice carries over so they don't
    /// have to re-toggle when opening any other session. Per-device
    /// (not synced) — matches the local-only nature of voice input.
    @AppStorage("kraki.input.voiceMode") private var voiceMode = false
    @State private var isPressing = false
    @State private var cancelArmed = false
    /// Shows the "Enable Dictation" alert when the user toggles into
    /// voice mode but `SFSpeechRecognizer.isAvailable` is false
    /// (system Dictation toggle off, no language pack, etc.).
    @State private var showDictationDisabledAlert = false

    // Hold-to-talk vs mode-swipe arbitration (voice mode only).
    // The hold-to-talk gesture pivots into one of these branches
    // within the first 200ms of a touch, then stays there for the
    // rest of that touch. `holdDwellTask` is the 200ms timer that
    // fires the RECORD pivot if no horizontal motion happens first.
    @State private var holdDwellTask: Task<Void, Never>? = nil
    @State private var holdPivot: HoldGesturePivot? = nil

    private enum HoldGesturePivot {
        case record
        case modeSwipe
    }

    // Mode swipe — drag the input box horizontally to cycle SessionMode.
    // All algorithm + state lives in InputBoxModeSwipeController; the
    // view just measures its own width and feeds the gesture in.
    @State private var swipeController = InputBoxModeSwipeController()
    @State private var measuredInputBoxWidth: CGFloat = 0

    // Mode-change toast (liquid-glass capsule above the send icon).
    // Only triggered by an actual user-initiated commit (via the
    // swipe), not by sync from the server or initial load.
    @State private var showModeToast = false
    @State private var modeToastMode: SessionMode = .discuss
    @State private var modeToastTask: Task<Void, Never>? = nil

    private static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]
    private static let inputBoxHeight: CGFloat = 42
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

    private var sessionStore: SessionStore { appState.sessionStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }
    private var sessionActive: Bool { session?.state == .active }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var isIdle: Bool { !sessionActive && !awaitingActive }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasImage: Bool { imageData != nil }
    private var canSend: Bool { isIdle && (hasText || hasImage) }

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

    /// Voice toggle is hidden in permission flows (responses are structured,
    /// not freeform speech).
    ///
    /// Currently disabled across the board — the voice input flow doesn't
    /// function reliably enough to ship, so we hide the toggle (and the
    /// hold-to-talk surface) until it's reworked. The underlying
    /// `SpeechRecognizer` plumbing is left in place so we can re-enable
    /// by flipping this back to `pendingPermission == nil`.
    private var canShowVoiceToggle: Bool { false }

    var body: some View {
        composeCard
            .overlay(alignment: .top) {
                if isPressing {
                    recordingOverlay
                        .offset(y: -96)
                        .transition(.scale.combined(with: .opacity))
                }
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
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: isPressing)
            .onChange(of: sessionActive) { _, active in
                if active { awaitingActive = false }
            }
            .onChange(of: selectedPhoto) { _, newItem in
                Task { await loadPhoto(newItem) }
            }
            // If the user toggled iOS Dictation while away from the
            // app, clear the latched "disabled" state so the next
            // mic-toggle tap gets a fresh probe instead of bouncing
            // straight to the alert. `scenePhase` fires `.active` on
            // any return-to-foreground, including coming back from
            // Settings.
            .onChange(of: scenePhase) { _, newPhase in
                if newPhase == .active && speech.dictationDisabled {
                    speech.clearRecognizerError()
                }
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
            // Voice input requires Dictation to be enabled at the iOS
            // level. We can't deep-link straight to that pane (Apple
            // removed third-party `prefs:` URLs), but we surface the
            // exact path and a one-tap shortcut to the app's Settings
            // entry so the user can navigate from there.
            .alert(
                "Voice input needs Dictation",
                isPresented: $showDictationDisabledAlert
            ) {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
                Button("Not Now", role: .cancel) {}
            } message: {
                Text("Push-to-talk uses iOS Dictation. Open Settings → General → Keyboard and turn on Enable Dictation.")
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
            // ① Pending action row (permission / question)
            if let perm = pendingPermission {
                permissionActionRow(perm)
            } else if let q = pendingQuestion, let choices = q.choices, !choices.isEmpty {
                questionChoicesRow(q, choices: choices)
            }

            // ② Single unified input row:
            //    [image attach] [voice/keyboard toggle + text field or
            //    hold-to-talk pill] [send button with mode swipe]
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
        }
        .animation(.easeInOut(duration: 0.2), value: voiceMode)
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
        HStack(alignment: .center, spacing: 0) {
            if canShowVoiceToggle {
                voiceToggleButton
            }
            // Voice mode is currently disabled (see `canShowVoiceToggle`),
            // so we always render the text field even if a stale
            // `voiceMode = true` is sitting in AppStorage from a prior build.
            textFieldForMode
            sendIconButton
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
        .background {
            InputBoxModeSwipeBackground(
                controller: swipeController,
                currentMode: currentSessionMode,
                width: measuredInputBoxWidth
            )
        }
        // Single, flat width measurement (not nested inside the strip's
        // body). Width changes don't happen during a drag, so re-render
        // cost is limited to actual layout changes (rotation, etc).
        .background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: InputBoxWidthPreferenceKey.self,
                    value: proxy.size.width
                )
            }
        )
        .onPreferenceChange(InputBoxWidthPreferenceKey.self) { new in
            measuredInputBoxWidth = new
        }
        .contentShape(Capsule())
        // Voice mode is gone for now, so the whole input box is always
        // swipeable for mode changes (no hold-to-talk gesture to race with).
        .simultaneousGesture(inputBoxModeSwipeGesture)
        // NOTE: previously this view carried
        //   .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
        // for non-swipe mode changes (e.g. via the picker sheet). That
        // implicit animation now also fires during a swipe-commit and
        // races the post-release spring, producing the "two-stage" feel.
        // The send-icon glyph's own `.animation(easeInOut, value:
        // currentSessionMode)` modifier still handles the picker case;
        // for swipe commits, the gesture's `withAnimation(spring) { … }`
        // wraps `setSessionMode`, so any view that reads currentSessionMode
        // (the icon tint included) rides the same spring curve.
    }

    /// Horizontal swipe gesture that cycles SessionMode, attached to
    /// the WHOLE input box (not just the send icon) so the user can
    /// swipe anywhere on the box. Uses `simultaneousGesture` so taps
    /// on the inner TextField, voice toggle, and send icon still
    /// reach their own gesture handlers. `minimumDistance: 10`
    /// prevents an incidental finger jiggle from triggering a swipe;
    /// the controller subtracts that 10pt threshold from the first
    /// reported translation so the strip starts at exactly 0 instead
    /// of jumping.
    private var inputBoxModeSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 10)
            .onChanged { value in
                swipeController.handleChanged(
                    translation: value.translation,
                    currentMode: currentSessionMode,
                    stepWidth: modeStepWidth
                )
            }
            .onEnded { value in
                swipeController.handleEnded(
                    velocity: value.velocity.width,
                    currentMode: currentSessionMode,
                    stepWidth: modeStepWidth
                ) { newMode in
                    appState.commandSender?.setSessionMode(sessionId: sessionId, mode: newMode)
                    presentModeToast(newMode)
                }
            }
    }

    // MARK: - Voice Toggle (lives inside the input box, leading edge)

    private var voiceToggleButton: some View {
        Button {
            // Gate before flipping into voice mode. Two checks:
            //
            //   1. Latched failure from a previous press-to-talk
            //      attempt that hit "Siri and Dictation are disabled."
            //      That error is set on the recognition callback and
            //      cleared on app foreground (so flipping the iOS
            //      Dictation toggle ON and returning gets a fresh
            //      shot).
            //
            //   2. `isAvailable == false` — covers missing language
            //      packs and similar non-Dictation cases. Note this
            //      flag is unreliable for the Dictation toggle itself
            //      (returns true even when Dictation is off), which is
            //      why we also need the latch above.
            if !voiceMode && (speech.dictationDisabled || !speech.isAvailable) {
                NSLog("[VOICE] toggle into voice mode blocked — dictationDisabled=\(speech.dictationDisabled) isAvailable=\(speech.isAvailable)")
                showDictationDisabledAlert = true
                return
            }
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                voiceMode.toggle()
                if voiceMode { isFocused = false }
            }
            // Proactively prompt for mic + speech-recognition
            // permissions the first time the user switches into
            // voice mode. The system prompts only appear if not
            // previously granted, so this is a no-op on subsequent
            // toggles. Calling it BEFORE first press-to-talk avoids
            // a crash on cold mic-session start.
            if voiceMode {
                speech.requestPermissionsIfNeeded()
                // Fire-and-forget probe: start a tiny recognition
                // session and immediately finish it. If the user has
                // Dictation disabled the framework will fire the
                // error callback within ~100ms, latch
                // `dictationDisabled`, and the next tap will bounce
                // them to the alert. The user sees a brief mic
                // permission grant (if first time) and then nothing
                // — voice mode appears to work. The probe is
                // throwaway: any transcript from it is discarded
                // since we `cancelRecording()` right after.
                Task { @MainActor in
                    speech.startRecording()
                    try? await Task.sleep(for: .milliseconds(250))
                    if speech.isRecording {
                        speech.cancelRecording()
                    }
                    // If the probe latched the Dictation-disabled
                    // error, bounce the user back out of voice mode
                    // AND show the alert. Same UX as if they'd
                    // tapped mic the second time.
                    if speech.dictationDisabled {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                            voiceMode = false
                        }
                        showDictationDisabledAlert = true
                    }
                }
            }
        } label: {
            LucideIcon(voiceMode ? .keyboard : .mic, size: 22, strokeWidth: 2.25, color: .secondary)
                .frame(width: 40, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Nudge inward so the icon doesn't kiss the capsule's left
        // rounded edge — more breathing room on the leading side.
        .padding(.leading, 6)
    }

    // MARK: - Send Icon (trailing edge of input box)
    //
    // Inline icon button — tap to send (or stop while active). The
    // horizontal mode-swipe gesture lives on the parent input box
    // (`inputBoxModeSwipeGesture`), so this button only needs to
    // handle the tap action; SwiftUI's simultaneousGesture coordinator
    // routes taps here and drags to the parent.

    private var sendIconButton: some View {
        Button(action: handleSendOrStopTap) {
            sendIconGlyph
                .frame(width: 34, height: Self.inputBoxHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Three-stage opacity:
        //   - Idle + nothing to send → 40% (greyed regardless of network)
        //   - Idle + has content + device unreachable → 50% (greyed but tappable;
        //     tap will enqueue and show the offline hint)
        //   - Anything else (fully ready, or stop button) → 100%
        .opacity(sendButtonOpacity)
        // Nudge inward from the trailing edge — mirrors the toggle's
        // leading inset so the two icons sit symmetric and don't
        // crowd the capsule's rounded ends.
        .padding(.trailing, 6)
    }

    private var sendButtonOpacity: Double {
        if isIdle && !canSend { return 0.4 }
        if isIdle && !isDeviceReachable { return 0.5 }
        return 1
    }

    @ViewBuilder
    private var sendIconGlyph: some View {
        let tint = Color.modeColor(currentSessionMode)
        ZStack {
            Image(systemName: "arrow.right")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(tint)
                .scaleEffect(isIdle ? 1 : 0)
                .opacity(isIdle ? 1 : 0)

            LucideIcon(.square, size: 12, strokeWidth: 0, color: tint)
                .frame(width: 12, height: 12)
                .background(tint)
                .clipShape(RoundedRectangle(cornerRadius: 2))
                .scaleEffect(isIdle ? 0 : 1)
                .opacity(isIdle ? 0 : 1)
        }
        .animation(.easeInOut(duration: 0.4), value: isIdle)
        .animation(.easeInOut(duration: 0.22), value: currentSessionMode)
    }

    // MARK: - Hold to Talk Prompt
    //
    // Replaces the text field's content area in voice mode. Same
    // height as the text field so the surrounding input box (with
    // its voice toggle, mode-color strip, send icon, and glass
    // background) keeps the same size and shape. The user
    // press-and-holds anywhere across this center label to record;
    // drag-up while holding arms cancellation (visualized by the
    // tint shift on the label).

    private var holdToTalkPrompt: some View {
        let activeTint: Color = cancelArmed ? .red : .krakiPrimary
        let label: String = isPressing
            ? (cancelArmed ? "Release to cancel" : "Recording…")
            : "Hold to Talk"
        let icon: String = isPressing
            ? (cancelArmed ? "xmark.circle.fill" : "waveform")
            : "mic.fill"

        return HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .medium))
            Text(label)
                .font(.subheadline)
        }
        .foregroundStyle(isPressing ? activeTint : .secondary)
        .frame(maxWidth: .infinity)
        .frame(height: Self.inputBoxHeight)
        .contentShape(Rectangle())
        .scaleEffect(isPressing ? 0.98 : 1)
        .animation(.spring(response: 0.25, dampingFraction: 0.85), value: isPressing)
        .animation(.easeInOut(duration: 0.15), value: cancelArmed)
        .gesture(holdToTalkGesture)
    }

    // The hold-to-talk gesture is a 3-state machine that coexists
    // with the horizontal mode-swipe gesture on the same surface:
    //
    //  Touch-down → DWELL (200ms timer).
    //   ├── 200ms passes with no significant horizontal motion →
    //   │     pivot RECORD: start speech, drag-up arms cancel.
    //   ├── |dx| ≥ 10pt AND |dx| > |dy| BEFORE 200ms elapses →
    //   │     pivot MODE_SWIPE: cancel dwell, forward to the
    //   │     swipeController; release commits the mode change
    //   │     (predict-and-snap with spring momentum).
    //   └── Release before 200ms with sub-threshold motion →
    //         quick tap on the prompt area, no-op.
    //
    // Because the gesture pivots into exactly one branch and stays
    // there for the rest of the touch, there's no ambiguity: a flick
    // can't accidentally start recording, and a long press can't
    // accidentally switch modes.
    private var holdToTalkGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if let pivot = holdPivot {
                    switch pivot {
                    case .record:
                        cancelArmed = value.translation.height < -60
                    case .modeSwipe:
                        swipeController.handleChanged(
                            translation: value.translation,
                            currentMode: currentSessionMode,
                            stepWidth: modeStepWidth
                        )
                    }
                    return
                }

                // Not yet pivoted. Schedule the dwell timer on first
                // contact, then check whether horizontal motion has
                // already crossed the pivot threshold.
                if holdDwellTask == nil {
                    holdDwellTask = Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(200))
                        guard !Task.isCancelled else { return }
                        // 200ms elapsed without a horizontal pivot →
                        // commit to RECORD.
                        NSLog("[VOICE] dwell expired → pivot=record, startRecording")
                        holdPivot = .record
                        isPressing = true
                        cancelArmed = false
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        speech.startRecording()
                    }
                }

                let dx = value.translation.width
                let dy = value.translation.height
                if abs(dx) >= 10, abs(dx) > abs(dy) {
                    holdDwellTask?.cancel()
                    holdDwellTask = nil
                    holdPivot = .modeSwipe
                    swipeController.handleChanged(
                        translation: value.translation,
                        currentMode: currentSessionMode,
                        stepWidth: modeStepWidth
                    )
                }
            }
            .onEnded { value in
                holdDwellTask?.cancel()
                holdDwellTask = nil
                let pivot = holdPivot
                holdPivot = nil

                switch pivot {
                case .record:
                    let cancelled = cancelArmed
                    NSLog("[VOICE] release pivot=record cancelArmed=\(cancelled) transcriptAtRelease=\"\(speech.transcript)\"")
                    Task { @MainActor in
                        if cancelled {
                            NSLog("[VOICE] cancelled → cancelRecording, no send")
                            speech.cancelRecording()
                            isPressing = false
                            cancelArmed = false
                            return
                        }
                        NSLog("[VOICE] awaiting finishRecording…")
                        await speech.finishRecording()
                        let captured = speech.transcript
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        NSLog("[VOICE] finishRecording done. transcript=\"\(speech.transcript)\" captured=\"\(captured)\" isRecording=\(speech.isRecording)")
                        if !captured.isEmpty {
                            let prior = text
                            let merged = prior.isEmpty ? captured : (prior + " " + captured)
                            NSLog("[VOICE] merged=\"\(merged)\" calling setDraft + handleSend (canSend=\(canSend) hasText=\(hasText) isIdle=\(isIdle) awaitingActive=\(awaitingActive) sessionActive=\(sessionActive))")
                            sessionStore.setDraft(sessionId, merged)
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                                voiceMode = false
                            }
                            NSLog("[VOICE] post-setDraft text=\"\(text)\" canSend=\(canSend)")
                            handleSend()
                            NSLog("[VOICE] handleSend returned")
                        } else {
                            NSLog("[VOICE] empty transcript, skip send")
                        }
                        isPressing = false
                        cancelArmed = false
                    }
                case .modeSwipe:
                    swipeController.handleEnded(
                        velocity: value.velocity.width,
                        currentMode: currentSessionMode,
                        stepWidth: modeStepWidth
                    ) { newMode in
                        appState.commandSender?.setSessionMode(sessionId: sessionId, mode: newMode)
                        presentModeToast(newMode)
                    }
                case .none:
                    // Tap or sub-threshold motion before pivot →
                    // nothing to do.
                    break
                }
            }
    }

    // MARK: - Recording Overlay

    private var recordingOverlay: some View {
        VStack(spacing: 8) {
            // Animated bars
            HStack(spacing: 4) {
                ForEach(0..<9, id: \.self) { i in
                    WaveformBar(index: i, color: cancelArmed ? .red : .krakiPrimary)
                }
            }
            .frame(height: 28)

            if cancelArmed {
                Text("Release to cancel")
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Text(speech.transcript.isEmpty ? "Listening…" : speech.transcript)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .frame(maxWidth: 240)

                Text("Slide up ↑ to cancel")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .background(recordingOverlayBackground)
        .shadow(color: .black.opacity(0.15), radius: 14, y: 4)
    }

    @ViewBuilder
    private var recordingOverlayBackground: some View {
        if #available(iOS 26.0, *) {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color.clear)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(.ultraThickMaterial)
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
        .disabled(!isIdle)
        .opacity(isIdle ? 1 : 0.4)
    }

    // MARK: - Mode-Aware Text Field

    private var textFieldForMode: some View {
        let placeholder: String = {
            if pendingPermission != nil { return "Deny with reason…" }
            if pendingQuestion != nil { return "Type your answer…" }
            return "Send a message…"
        }()
        let isEnabled: Bool = {
            if pendingPermission != nil || pendingQuestion != nil { return true }
            return isIdle
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
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.6)
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

    // MARK: - Question Choices Row

    private func questionChoicesRow(_ question: PendingQuestion, choices: [String]) -> some View {
        VStack(spacing: 6) {
            ForEach(choices, id: \.self) { choice in
                Button {
                    appState.commandSender?.answer(sessionId: sessionId, questionId: question.id, answer: choice)
                    sessionStore.setDraft(sessionId, "")
                    isFocused = false
                } label: {
                    Text(choice)
                        .font(.subheadline)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .modifier(GlassChoiceButtonModifier(tint: .krakiPrimary))
            }
        }
    }

    // MARK: - Mode Submit Handlers

    private func handleModeSubmit() {
        if pendingPermission != nil {
            handlePermissionDenyWithReason()
        } else if pendingQuestion != nil {
            handleQuestionAnswer()
        } else {
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
        appState.commandSender?.answer(sessionId: sessionId, questionId: q.id, answer: answer)
        sessionStore.setDraft(sessionId, "")
        isFocused = false
    }

    // MARK: - Send-icon action handlers (wired to the UIKit gesture capture)

    private func handleSendOrStopTap() {
        if pendingPermission != nil {
            handlePermissionDenyWithReason()
        } else if pendingQuestion != nil {
            handleQuestionAnswer()
        } else if isIdle {
            guard canSend else { return }
            handleSend()
        } else {
            appState.commandSender?.abortSession(sessionId: sessionId)
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
        NSLog("[VOICE] handleSend entry canSend=\(canSend) text=\"\(text)\" hasText=\(hasText) hasImage=\(hasImage) isIdle=\(isIdle) sessionActive=\(sessionActive) awaitingActive=\(awaitingActive)")
        guard canSend else {
            NSLog("[VOICE] handleSend BAILED — canSend false")
            return
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sendText = trimmed.isEmpty ? "[image]" : trimmed
        NSLog("[VOICE] handleSend sending: \"\(sendText)\"")

        var attachments: [ImageAttachment]?
        if let imageData {
            let base64 = imageData.base64EncodedString()
            attachments = [ImageAttachment(type: "image", mimeType: imageMimeType, data: base64)]
        }

        appState.commandSender?.sendInput(sessionId: sessionId, text: sendText, attachments: attachments)
        sessionStore.setDraft(sessionId, "")
        clearImage()
        awaitingActive = true
        isFocused = false
        NSLog("[VOICE] handleSend done (commandSender=\(appState.commandSender != nil))")
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

// MARK: - Waveform Bar (recording overlay)

private struct WaveformBar: View {
    let index: Int
    let color: Color
    @State private var phase: CGFloat = 0.4

    var body: some View {
        Capsule()
            .fill(color)
            .frame(width: 3, height: 6 + phase * 22)
            .onAppear {
                let delay = Double(index) * 0.08
                withAnimation(
                    .easeInOut(duration: 0.45)
                        .repeatForever(autoreverses: true)
                        .delay(delay)
                ) {
                    phase = 1.0
                }
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

