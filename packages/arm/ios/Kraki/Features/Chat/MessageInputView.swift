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
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var imageMimeType: String = "image/jpeg"
    @State private var awaitingActive = false
    @FocusState private var isFocused: Bool

    // Voice
    @State private var speech = SpeechRecognizer()
    @State private var voiceMode = false
    @State private var isPressing = false
    @State private var cancelArmed = false

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
    private var sessionActive: Bool { session?.state == .active }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var isIdle: Bool { !sessionActive && !awaitingActive }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasImage: Bool { imageData != nil }
    private var canSend: Bool { isIdle && (hasText || hasImage) }

    /// Voice toggle is hidden in permission flows (responses are structured,
    /// not freeform speech).
    private var canShowVoiceToggle: Bool { pendingPermission == nil }

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
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: isPressing)
            .onChange(of: sessionActive) { _, active in
                if active { awaitingActive = false }
            }
            .onChange(of: selectedPhoto) { _, newItem in
                Task { await loadPhoto(newItem) }
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
        HStack(alignment: .bottom, spacing: 0) {
            if canShowVoiceToggle {
                voiceToggleButton
            }
            if voiceMode {
                holdToTalkPrompt
            } else {
                textFieldForMode
            }
            sendIconButton
        }
        .frame(maxWidth: .infinity)
        // `minHeight` (not fixed `height`) so the TextField's
        // `.lineLimit(1...3)` can actually expand vertically when the
        // user types past one line. With the previous fixed height,
        // the TextField was constrained to a single line regardless
        // of content. HStack `alignment: .bottom` keeps the voice
        // toggle and send icon pinned to the bottom edge while the
        // text grows upward (iMessage-style).
        .frame(minHeight: Self.inputBoxHeight)
        .background { inputBoxGlassBackground }
        .contentShape(Capsule())
        // In text mode the whole input box is swipeable for mode
        // changes. In voice mode the hold-to-talk gesture owns the
        // prompt area and handles its own pivot to a mode swipe via
        // the 200ms dwell rule, so we don't attach the parent swipe
        // (it would race with the hold-to-talk).
        .simultaneousGesture(voiceMode ? nil : inputBoxModeSwipeGesture)
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
        Button {
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
        .opacity((isIdle && !canSend) ? 0.4 : 1)
        // Nudge inward from the trailing edge — mirrors the toggle's
        // leading inset so the two icons sit symmetric and don't
        // crowd the capsule's rounded ends.
        .padding(.trailing, 6)
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
    //   │     pivot MODE_SWIPE: cancel dwell, forward to
    //   │     handleModeSwipeChanged; release calls
    //   │     handleModeSwipeEnded (momentum + spring + commit).
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
                        handleModeSwipeChanged(value.translation.width)
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
                    handleModeSwipeChanged(dx)
                }
            }
            .onEnded { value in
                holdDwellTask?.cancel()
                holdDwellTask = nil
                let pivot = holdPivot
                holdPivot = nil

                switch pivot {
                case .record:
                    speech.stopRecording()
                    let cancelled = cancelArmed
                    // Brief delay so the recognizer can flush its
                    // final partial.
                    Task { @MainActor in
                        try? await Task.sleep(for: .milliseconds(180))
                        if !cancelled {
                            let captured = speech.transcript
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                            if !captured.isEmpty {
                                let prior = text
                                let merged = prior.isEmpty ? captured : (prior + " " + captured)
                                sessionStore.setDraft(sessionId, merged)
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                                    voiceMode = false
                                }
                            }
                        }
                        isPressing = false
                        cancelArmed = false
                    }
                case .modeSwipe:
                    handleModeSwipeEnded(value.velocity.width)
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
        .padding(.horizontal, 6)
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
        appState.commandSender?.deny(sessionId: sessionId, permissionId: perm.id)
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

        appState.commandSender?.sendInput(sessionId: sessionId, text: sendText, attachments: attachments)
        sessionStore.setDraft(sessionId, "")
        clearImage()
        awaitingActive = true
        isFocused = false
    }

    private func clearImage() {
        imageData = nil
        selectedPhoto = nil
    }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }
        guard let uiImage = UIImage(data: data) else { return }

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
        } else if let compressed = targetImage.jpegData(compressionQuality: 0.6), compressed.count <= maxSize {
            imageData = compressed; imageMimeType = "image/jpeg"
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

