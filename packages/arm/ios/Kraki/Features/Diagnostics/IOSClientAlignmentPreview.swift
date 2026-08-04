#if os(iOS) && DEBUG
import SwiftUI
import UIKit

/// Debug-only visual contract page for the shared iOS/macOS surfaces.
/// It renders the same production SessionCard, TextKit bubble, AgentAvatar,
/// Model corner, and voice composer surface used by the app.
struct IOSClientAlignmentPreview: View {
    @Environment(AppState.self) private var appState
    private let previewSessionID = "ios-alignment-preview"

    private let markdown = """
    ## Shared Markdown
    **Bold**, *italic*, `inline code`, ~~struck~~, and a [Kraki link](https://kraki.chat).

    > The block parser, inline semantics, and code language aliases are shared.

    ```swift
    struct SessionCard { let model: String? }
    ```
    """

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 18) {
                header
                section("Session Cards") {
                    ForEach([
                        "ios-alignment-preview",
                        "ios-alignment-unread",
                        "ios-alignment-question",
                    ], id: \.self) { id in
                        SessionCardView(sessionId: id)
                            .background(Color.surfaceSecondary, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
                section("Markdown") {
                    IOSAlignmentBubble(markdown: markdown)
                }
                section("Voice Composer") {
                    voiceSurface(
                        title: "Recording",
                        state: .recording,
                        prefix: "Existing draft",
                        rawText: "capture the shared transcript presentation"
                    )
                    voiceSurface(
                        title: "Correcting",
                        state: .finishing,
                        prefix: "Existing draft",
                        rawText: "capture the shared transcript presentation",
                        correctionSource: "capture the shared transcript presentation",
                        correctionText: "capture the shared transcript projection",
                        correctionSourceOffset: KrakiVoiceInputController.alignedRawPrefixLength(
                            corrected: "capture the shared transcript projection",
                            raw: "capture the shared transcript presentation"
                        )
                    )
                }
            }
            .padding(16)
        }
        .background(Color.surfacePrimary)
        .navigationTitle("Client Alignment")
        .navigationBarTitleDisplayMode(.inline)
        .task { installFixtureSessions() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Shared client surfaces")
                .font(.title2.bold())
            Text("Session Card, Model avatar, Markdown, and voice presentation")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func section<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func voiceSurface(
        title: String,
        state: KrakiVoiceInputController.State,
        prefix: String,
        rawText: String,
        correctionSource: String = "",
        correctionText: String = "",
        correctionSourceOffset: Int = 0
    ) -> some View {
        let pieces = VoiceComposerPresentation.transcriptPieces(
            prefix: prefix,
            state: state,
            rawText: rawText,
            correctionSource: correctionSource,
            correctionText: correctionText,
            correctionSourceOffset: correctionSourceOffset
        )
        return VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            IOSVoiceComposerSurface(
                pieces: pieces,
                state: state,
                statusText: VoiceComposerPresentation.statusText(
                    state: state,
                    rawText: rawText,
                    displayText: correctionText.isEmpty ? rawText : correctionText
                ),
                onFinish: {}
            )
            .background(.regularMaterial, in: Capsule())
        }
    }

    private func installFixtureSessions() {
        let baseDate = Date(timeIntervalSince1970: 1_754_300_000)
        let sessions: [(String, String, String?, SessionState, Int, Int, Bool, String)] = [
            ("ios-alignment-unread", "Unread with Model", "claude-sonnet-4.6", .idle, 18, 12, false, "agent_message"),
            ("ios-alignment-question", "Question pending", "gemini-2.5-pro", .idle, 22, 22, true, "question"),
        ]
        for (id, title, model, state, lastSeq, readSeq, pinned, previewType) in sessions {
            appState.sessionStore.sessions[id] = SessionInfo(
                id: id,
                deviceId: IOSChatAlignmentPreviewFixture.deviceID,
                deviceName: "Simulator",
                agent: "pi",
                model: model,
                title: title,
                state: state,
                mode: .discuss,
                lastSeq: lastSeq,
                readSeq: readSeq,
                messageCount: lastSeq,
                createdAt: baseDate,
                pinned: pinned
            )
            appState.sessionStore.sessionPreviews[id] = SessionPreview(
                text: previewType == "question" ? "Which target should I use?" : "Shared projection preview",
                type: previewType,
                timestamp: "2026-08-04T12:00:00.000Z"
            )
        }
    }
}

private struct IOSAlignmentBubble: UIViewRepresentable {
    let markdown: String

    func makeUIView(context: Context) -> TKBubbleCell {
        TKBubbleCell(frame: .zero)
    }

    func updateUIView(_ cell: TKBubbleCell, context: Context) {
        let width = max(280, UIScreen.main.bounds.width - 32)
        let message = ChatMessage(
            type: "agent_message",
            seq: 1,
            sessionId: "ios-alignment-preview",
            deviceId: "alignment-device",
            timestamp: "2026-08-04T12:00:00.000Z",
            payload: ["content": AnyCodable(markdown)]
        )
        TKBubbleContent.bust(message.id)
        let content = TKBubbleContent.make(
            message: message,
            sessionId: message.sessionId ?? "ios-alignment-preview",
            agent: "pi"
        )
        cell.frame = CGRect(x: 0, y: 0, width: width, height: content.cellHeight(cellWidth: width))
        cell.configure(content, cellWidth: width)
        cell.setBodyInteractive(true)
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: TKBubbleCell,
        context: Context
    ) -> CGSize? {
        let width = max(280, proposal.width ?? UIScreen.main.bounds.width - 32)
        let message = ChatMessage(
            type: "agent_message", seq: 1, sessionId: "ios-alignment-preview",
            deviceId: "alignment-device", timestamp: nil,
            payload: ["content": AnyCodable(markdown)]
        )
        let content = TKBubbleContent.make(message: message, sessionId: "ios-alignment-preview", agent: "pi")
        return CGSize(width: width, height: content.cellHeight(cellWidth: width))
    }
}
#endif
