#if os(iOS)
/// MessageInputView — Edge-to-edge bottom bar with text + voice modes.
///
/// Layout: a single full-width liquid-glass surface that rounds only the
/// top corners and extends through the home-indicator safe area, containing
///   ① Optional pending action row (permission buttons / question choices)
///   ② Input row: voice toggle (left) + text field OR hold-to-talk pill
///   ③ Optional expanded mode picker (its own row when expanded)
///   ④ Bottom toolbar: image attach, collapsed mode pill, send/stop
///
/// The mic toggle lives inline at the leading edge of the input row so it
/// stays right next to the typing cursor (WeChat/Doubao style). Tapping it
/// swaps the text field for a press-and-hold "Hold to Talk" pill that drives
/// on-device transcription via SpeechRecognizer. Drag-up while holding arms
/// cancellation. Release with text fills the draft and auto-switches back to
/// text mode for review/send.
///
/// The mode picker's expanded segmented control is too wide to share a row
/// with the image-attach + send buttons, so when expanded it flows onto its
/// own dedicated row above the bottom toolbar.

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

    // Mode picker expansion is lifted here so the expanded picker can flow
    // onto its own row inside the compose card (it's too wide to share a
    // row with the image-attach + send buttons).
    @State private var modePickerExpanded = false

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

    /// Mode picker only makes sense in normal compose state.
    private var canShowModePicker: Bool { pendingPermission == nil && pendingQuestion == nil }

    var body: some View {
        composeCard
            .ignoresSafeArea(.container, edges: .bottom)
            .overlay(alignment: .top) {
                if isPressing {
                    recordingOverlay
                        .offset(y: -96)
                        .transition(.scale.combined(with: .opacity))
                }
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

    @ViewBuilder
    private var composeCard: some View {
        VStack(spacing: 8) {
            // ① Pending action row (permission / question)
            if let perm = pendingPermission {
                permissionActionRow(perm)
            } else if let q = pendingQuestion, let choices = q.choices, !choices.isEmpty {
                questionChoicesRow(q, choices: choices)
            }

            // ② Input row (mic toggle + text field, OR hold-to-talk pill)
            inputRow

            // ③ Expanded mode picker on its own row (too wide for bottom toolbar)
            if canShowModePicker && modePickerExpanded {
                ModePickerView(sessionId: sessionId, expanded: $modePickerExpanded)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            // ④ Bottom toolbar
            bottomToolbar
        }
        .padding(.horizontal, 14)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .frame(maxWidth: .infinity)
        .modifier(ComposeCardGlassModifier())
        .animation(.easeInOut(duration: 0.2), value: modePickerExpanded)
    }

    // MARK: - Input Row (mic toggle + text field / hold-to-talk pill)

    private var inputRow: some View {
        HStack(spacing: 4) {
            if canShowVoiceToggle {
                voiceToggleButton
            }
            if voiceMode {
                holdToTalkPill
            } else {
                textFieldForMode
            }
        }
    }

    // MARK: - Bottom Toolbar

    private var bottomToolbar: some View {
        HStack(spacing: 8) {
            imageAttachButton
            if canShowModePicker && !modePickerExpanded {
                ModePickerView(sessionId: sessionId, expanded: $modePickerExpanded)
            }
            Spacer(minLength: 0)
            if !voiceMode {
                actionButtonForMode
            }
        }
        .animation(.easeInOut(duration: 0.2), value: voiceMode)
    }

    // MARK: - Voice Toggle (lives inside the input row, leading edge)

    private var voiceToggleButton: some View {
        Button {
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                voiceMode.toggle()
                if voiceMode { isFocused = false }
            }
        } label: {
            Image(systemName: voiceMode ? "keyboard" : "mic.fill")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Hold to Talk Pill

    private var holdToTalkPill: some View {
        let activeTint: Color = cancelArmed ? .red : .krakiPrimary
        let label: String = isPressing
            ? (cancelArmed ? "Release to cancel" : "Recording…")
            : "Hold to Talk"
        let icon: String = isPressing
            ? (cancelArmed ? "xmark.circle.fill" : "waveform")
            : "mic.fill"

        return HStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .medium))
            Text(label)
                .font(.subheadline)
        }
        .foregroundStyle(isPressing ? activeTint : .secondary)
        .frame(maxWidth: .infinity)
        .frame(minHeight: 44)
        .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .background(holdToTalkPillBackground(tint: activeTint))
        .scaleEffect(isPressing ? 0.98 : 1)
        .animation(.spring(response: 0.25, dampingFraction: 0.85), value: isPressing)
        .animation(.easeInOut(duration: 0.15), value: cancelArmed)
        .gesture(holdToTalkGesture)
    }

    @ViewBuilder
    private func holdToTalkPillBackground(tint: Color) -> some View {
        if #available(iOS 26.0, *) {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(isPressing ? tint.opacity(0.18) : Color.clear)
                .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(isPressing ? tint.opacity(0.18) : Color(.tertiarySystemBackground))
                .overlay(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .stroke((isPressing ? tint : .secondary).opacity(0.25), lineWidth: 1)
                )
        }
    }

    private var holdToTalkGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !isPressing {
                    isPressing = true
                    cancelArmed = false
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    speech.startRecording()
                }
                cancelArmed = value.translation.height < -60
            }
            .onEnded { _ in
                speech.stopRecording()
                let cancelled = cancelArmed
                // Brief delay so the recognizer can flush its final partial.
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
                        .frame(height: 32)
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
                LucideIcon(.imagePlus, size: 18, color: .secondary)
                    .frame(width: 36, height: 36)
                    .modifier(GlassCircleModifier())
                    .frame(width: 44, height: 44)
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
            set: { sessionStore.setDraft(sessionId, $0) }
        ), axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .font(.system(size: 16))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .focused($isFocused)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.6)
        .submitLabel(.send)
        .onSubmit { handleModeSubmit() }
    }

    // MARK: - Mode-Aware Action Button

    @ViewBuilder
    private var actionButtonForMode: some View {
        if pendingPermission != nil {
            Button { handlePermissionDenyWithReason() } label: {
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.red.opacity(hasText ? 0.85 : 0.3))
                    )
            }
            .disabled(!hasText)
        } else if pendingQuestion != nil {
            Button { handleQuestionAnswer() } label: {
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(Color.krakiPrimary.opacity(hasText ? 0.85 : 0.3))
                    )
            }
            .disabled(!hasText)
        } else {
            sendStopButton
        }
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

    // MARK: - Send / Stop Button

    private var sendStopButton: some View {
        Button {
            if isIdle { handleSend() }
            else { appState.commandSender?.abortSession(sessionId: sessionId) }
        } label: {
            ZStack {
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .scaleEffect(isIdle ? 1 : 0)
                    .opacity(isIdle ? 1 : 0)

                LucideIcon(.square, size: 14, strokeWidth: 0, color: .white)
                    .frame(width: 14, height: 14)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                    .scaleEffect(isIdle ? 0 : 1)
                    .opacity(isIdle ? 0 : 1)
            }
            .frame(width: 36, height: 36)
            .animation(.easeInOut(duration: 0.5), value: isIdle)
        }
        .modifier(GlassSendButtonModifier(tint: Color.krakiPrimary, enabled: canSend || !isIdle))
        .disabled(isIdle && !canSend)
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

/// Edge-to-edge bottom bar of liquid glass: rounds only the top corners.
/// The view that uses this modifier should also call
/// `.ignoresSafeArea(.container, edges: .bottom)` on its outer body so the
/// glass actually slides under the home indicator. Pre-iOS 26 falls back
/// to .ultraThinMaterial in the same shape.
private struct ComposeCardGlassModifier: ViewModifier {
    private static let topRadius: CGFloat = 22

    private var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: Self.topRadius,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: Self.topRadius,
            style: .continuous
        )
    }

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: shape)
        } else {
            content.background(.ultraThinMaterial, in: shape)
        }
    }
}

private struct GlassTextFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular)
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        }
    }
}

private struct GlassCircleModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: Circle())
        } else {
            content.background(.ultraThinMaterial, in: Circle())
        }
    }
}

private struct GlassSendButtonModifier: ViewModifier {
    let tint: Color
    let enabled: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .buttonStyle(.glass(.regular.tint(tint)))
                .opacity(enabled ? 1 : 0.4)
        } else {
            content
                .buttonStyle(.plain)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(tint)
                        .opacity(enabled ? 1 : 0.4)
                )
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

#endif
