#if os(iOS)
/// MessageInputView — Chat input bar with mode selector, image attachment, and send/stop.
///
/// Mirrors MessageInput.tsx. Provides a text field, image picker, mode switcher,
/// and contextual send/stop button at the bottom of the chat view.

import SwiftUI
import PhotosUI

struct MessageInputView: View {
    let sessionId: String

    @Environment(AppState.self) private var appState
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var imageData: Data?
    @State private var imageMimeType: String = "image/jpeg"
    @FocusState private var isFocused: Bool

    private var sessionStore: SessionStore { appState.sessionStore }
    private var session: SessionInfo? { sessionStore.sessions[sessionId] }
    private var sessionActive: Bool { session?.state == .active }
    private var text: String { sessionStore.drafts[sessionId] ?? "" }
    private var isIdle: Bool { !sessionActive }
    private var hasText: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var hasImage: Bool { imageData != nil }
    private var canSend: Bool { isIdle && (hasText || hasImage) }

    var body: some View {
        VStack(spacing: 8) {
            // Mode picker
            ModePickerView(sessionId: sessionId)

            // Input row
            HStack(alignment: .bottom, spacing: 8) {
                // Image attachment button
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
                                .frame(width: 32, height: 32)
                                .clipShape(RoundedRectangle(cornerRadius: 8))

                            Button {
                                clearImage()
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 14))
                                    .foregroundStyle(.white, .secondary)
                            }
                            .offset(x: 4, y: -4)
                        }
                    } else {
                        Image(systemName: "photo.badge.plus")
                            .font(.system(size: 18))
                            .foregroundStyle(.secondary)
                            .frame(width: 32, height: 32)
                    }
                }
                .disabled(!isIdle)
                .opacity(isIdle ? 1 : 0.4)

                // Text input
                TextField("Send a message…", text: Binding(
                    get: { text },
                    set: { sessionStore.setDraft(sessionId, $0) }
                ), axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
                .focused($isFocused)
                .disabled(!isIdle)
                .opacity(isIdle ? 1 : 0.6)
                .submitLabel(.send)
                .onSubmit { handleSend() }

                // Send / Stop button
                Button {
                    if isIdle {
                        handleSend()
                    } else {
                    appState.commandSender?.abortSession(sessionId: sessionId)
                    }
                } label: {
                    ZStack {
                        // Send icon
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(.white, canSend ? Color.accentColor : Color.accentColor.opacity(0.4))
                            .scaleEffect(isIdle ? 1 : 0)
                            .opacity(isIdle ? 1 : 0)

                        // Stop icon
                        Image(systemName: "stop.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(.white, .red)
                            .scaleEffect(isIdle ? 0 : 1)
                            .opacity(isIdle ? 0 : 1)
                            .rotationEffect(.degrees(isIdle ? -90 : 0))
                    }
                    .animation(.easeInOut(duration: 0.3), value: isIdle)
                }
                .disabled(isIdle && !canSend)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .onChange(of: selectedPhoto) { _, newItem in
            Task { await loadPhoto(newItem) }
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
        isFocused = false
    }

    private func clearImage() {
        imageData = nil
        selectedPhoto = nil
    }

    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        guard let data = try? await item.loadTransferable(type: Data.self) else { return }

        // Compress if needed (target max 3MB, max dimension 1024)
        guard let uiImage = UIImage(data: data) else { return }
        let maxDimension: CGFloat = 1024
        let maxSize = 3 * 1024 * 1024

        var targetImage = uiImage
        if uiImage.size.width > maxDimension || uiImage.size.height > maxDimension {
            let scale = maxDimension / max(uiImage.size.width, uiImage.size.height)
            let newSize = CGSize(
                width: uiImage.size.width * scale,
                height: uiImage.size.height * scale
            )
            let renderer = UIGraphicsImageRenderer(size: newSize)
            targetImage = renderer.image { _ in
                uiImage.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }

        if let compressed = targetImage.jpegData(compressionQuality: 0.8), compressed.count <= maxSize {
            imageData = compressed
            imageMimeType = "image/jpeg"
        } else if let compressed = targetImage.jpegData(compressionQuality: 0.6), compressed.count <= maxSize {
            imageData = compressed
            imageMimeType = "image/jpeg"
        }
    }
}

// MARK: - Quick Replies (shown when idle)

struct QuickRepliesView: View {
    let sessionId: String
    @Environment(AppState.self) private var appState

    private let replies = ["Yes", "No", "Continue"]

    var body: some View {
        HStack(spacing: 8) {
            ForEach(replies, id: \.self) { reply in
                Button(reply) {
                    appState.commandSender?.sendInput(sessionId: sessionId, text: reply)
                }
                .font(.subheadline)
                .fontWeight(.medium)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(.secondary.opacity(0.12), in: Capsule())
                .foregroundStyle(.primary)
            }
            Spacer()
        }
    }
}

#endif
