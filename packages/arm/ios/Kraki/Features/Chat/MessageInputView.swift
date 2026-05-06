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
        VStack(spacing: 0) {
            // Gradient fade from chat
            LinearGradient(
                colors: [Color.surfacePrimary.opacity(0), Color.surfacePrimary],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 16)

            // Pending permission/question cards
            if let permission = pendingPermission {
                PermissionCardView(permission: permission)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            } else if let question = pendingQuestion {
                QuestionCardView(question: question)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }

            VStack(spacing: 6) {
                // Row 1: image attach + mode picker
                HStack {
                    imageAttachButton
                    Spacer()
                    ModePickerView(sessionId: sessionId)
                }

                // Row 2: text input + send/stop
                HStack(alignment: .bottom, spacing: 8) {
                    textField
                    sendStopButton
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, max(12, UIApplication.shared.connectedScenes
                .compactMap { ($0 as? UIWindowScene)?.keyWindow?.safeAreaInsets.bottom }
                .first ?? 0))
            .background(Color.surfacePrimary)
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
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.borderPrimary, lineWidth: 1))

                    Button { clearImage() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary, Color.surfacePrimary)
                    }
                    .offset(x: 4, y: -4)
                }
            } else {
                LucideIcon(.imagePlus, size: 18, color: .secondary)
                    .frame(width: 32, height: 32)
            }
        }
        .disabled(!isIdle)
        .opacity(isIdle ? 1 : 0.4)
    }

    // MARK: - Text Field

    private var textField: some View {
        TextField("Send a message…", text: Binding(
            get: { text },
            set: { sessionStore.setDraft(sessionId, $0) }
        ), axis: .vertical)
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .font(.system(size: 16))
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.surfaceSecondary, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(isFocused ? Color.krakiPrimary : Color.borderPrimary, lineWidth: isFocused ? 1.5 : 1)
        )
        .focused($isFocused)
        .disabled(!isIdle)
        .opacity(isIdle ? 1 : 0.6)
        .submitLabel(.send)
        .onSubmit { handleSend() }
    }

    // MARK: - Send / Stop Button

    private var sendStopButton: some View {
        Button {
            if isIdle { handleSend() }
            else { appState.commandSender?.abortSession(sessionId: sessionId) }
        } label: {
            ZStack {
                // Send arrow
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .scaleEffect(isIdle ? 1 : 0)
                    .opacity(isIdle ? 1 : 0)

                // Stop square
                LucideIcon(.square, size: 14, strokeWidth: 0, color: .white)
                    .frame(width: 14, height: 14)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 2))
                    .scaleEffect(isIdle ? 0 : 1)
                    .opacity(isIdle ? 0 : 1)
            }
            .frame(width: 36, height: 36)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.krakiPrimary)
                    .opacity(canSend || !isIdle ? 1 : 0.4)
            )
            .animation(.easeInOut(duration: 0.5), value: isIdle)
        }
        .disabled(isIdle && !canSend)
        .opacity(!isIdle ? 1 : 1) // Pulse handled by animation
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

#endif
