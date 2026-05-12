#if os(iOS)
/// MessageInputView — Exact match of web MessageInput.tsx.
///
/// Two rows:
///   Row 1: image attach (left) + mode picker (right)
///   Row 2: rounded TextField + send/stop button (36×36, kraki coral)
///
/// awaitingActive state prevents flicker after send.
/// Gradient fade above for seamless chat transition.

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

    private var sessionStore: SessionStore { appState.sessionStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }
    private var sessionActive: Bool { session?.state == .active }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var isIdle: Bool { !sessionActive && !awaitingActive }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasImage: Bool { imageData != nil }
    private var canSend: Bool { isIdle && (hasText || hasImage) }

    var body: some View {
        VStack(spacing: 8) {
            // Top row: context-dependent
            if let permission = pendingPermission {
                // Permission: 3 action buttons
                permissionActionRow(permission)
                    .padding(.horizontal, 12)
            } else if let question = pendingQuestion, let choices = question.choices, !choices.isEmpty {
                // Question: choice buttons stacked
                questionChoicesRow(question, choices: choices)
                    .padding(.horizontal, 12)
            } else {
                // Normal: image attach + mode picker
                HStack {
                    imageAttachButton
                    Spacer()
                    ModePickerView(sessionId: sessionId)
                }
                .padding(.horizontal, 12)
            }

            // Bottom row: text input + send/action
            HStack(alignment: .bottom, spacing: 8) {
                textFieldForMode
                actionButtonForMode
            }
            .padding(.horizontal, 12)
            .padding(.bottom, max(12, UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.bottom }
                .first ?? 0))
        }
        .onChange(of: sessionActive) { _, active in
            if active { awaitingActive = false }
        }
        .onChange(of: selectedPhoto) { _, newItem in
            Task { await loadPhoto(newItem) }
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
                if #available(iOS 26.0, *) {
                    LucideIcon(.imagePlus, size: 18, color: .secondary)
                        .frame(width: 36, height: 36)
                        .glassEffect(.regular)
                } else {
                    LucideIcon(.imagePlus, size: 18, color: .secondary)
                        .frame(width: 36, height: 36)
                        .background(.ultraThinMaterial, in: Circle())
                }
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
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .modifier(GlassTextFieldModifier())
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
            // Deny with reason — only active when text is non-empty
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
            // Submit freeform answer
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

// MARK: - Glass Modifiers (iOS 26 liquid glass with fallback)

private struct GlassTextFieldModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular)
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
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
/// actions). Falls back to `.bordered` on iOS < 26 so semantic tints still
/// read correctly.
private struct GlassChoiceButtonModifier: ViewModifier {
    let tint: Color

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.buttonStyle(.glass(.regular.tint(tint)))
        } else {
            content
                .buttonStyle(.bordered)
                .tint(tint)
        }
    }
}

#endif
