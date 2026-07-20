#if os(iOS) && DEBUG
import SwiftUI
import UIKit

/// Deterministic smoke page for the production flat TextKit cell. Enabled only
/// with `KRAKI_FLATBUBBLE=1`; it is not linked from product UI.
struct FlatBubbleTestView: View {
    @Environment(AppState.self) private var appState
    @State private var showsSteps = false
    @State private var showsLiveSteps = false
    @State private var showsFrozenSteps = false

    private let sessionId = "flat-bubble-test"
    private let message = ChatMessage(
        type: "agent_message",
        seq: 42,
        sessionId: "flat-bubble-test",
        deviceId: "test-device",
        timestamp: "2026-07-13T00:00:00Z",
        payload: [
            "content": AnyCodable("Flat spine answer with **Markdown**, a [link](https://kraki.chat), and no grouped history."),
            "steps": AnyCodable(2),
        ]
    )

    /// A mock in-progress card (streaming narration + a running tool) to verify
    /// the live bubble exposes the Steps affordance mid-turn, mirroring the web.
    private var liveCard: MessageStore.SessionCard {
        MessageStore.SessionCard(
            text: "Streaming draft narration while a tool runs…",
            action: ChatMessage(
                type: "tool_start", seq: 0, sessionId: sessionId,
                deviceId: "test-device", timestamp: nil,
                payload: [
                    "toolName": AnyCodable("bash"),
                    "toolCallId": AnyCodable("live-1"),
                    "headline": AnyCodable("$ pwd"),
                ]))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                FlatBubbleTestCell(
                    message: message,
                    sessionId: sessionId,
                    attachmentStore: appState.attachmentStore,
                    showsSteps: $showsSteps
                )
                .frame(height: 150)

                // Unified path: the SAME TKBubbleCell renders a streaming /
                // frozen turn. Verify draft + action slot render through the
                // production TextKit cell, not a separate live-card component.
                FlatBubbleActionCell(
                    content: TKBubbleContent.live(
                        card: liveCard, agent: "pi", sessionId: sessionId, steps: 1),
                    attachmentStore: appState.attachmentStore,
                    onSteps: { showsLiveSteps = true }
                )
                .frame(height: 180)

                FlatBubbleActionCell(
                    content: TKBubbleContent.live(
                        card: MessageStore.SessionCard(
                            text: "I was writing the file when the turn failed…",
                            action: ChatMessage(type: "failed", seq: 0, sessionId: sessionId,
                                                deviceId: "d", timestamp: nil,
                                                payload: ["message": AnyCodable("Model error: context length exceeded")])),
                        agent: "pi", sessionId: sessionId, steps: 2,
                        isFrozen: true, frozenTimestamp: "2026-07-13T18:40:00.000Z"),
                    attachmentStore: appState.attachmentStore,
                    onSteps: { showsFrozenSteps = true }
                )
                .frame(height: 200)
                Spacer()
            }
            .padding(.top, 40)
            .background(Color.surfacePrimary)
            .navigationTitle("Flat Bubble")
        }
        .sheet(isPresented: $showsSteps) {
            StepsSheetView(
                sessionId: sessionId,
                targetSeq: message.seq,
                agent: "pi",
                store: appState.messageStore
            )
        }
        .sheet(isPresented: $showsLiveSteps) {
            StepsSheetView(
                sessionId: sessionId,
                targetSeq: 40,
                live: true,
                agent: "pi",
                store: appState.messageStore
            )
        }
        .sheet(isPresented: $showsFrozenSteps) {
            StepsSheetView(
                sessionId: sessionId,
                targetSeq: message.seq,
                agent: "pi",
                store: appState.messageStore
            )
        }
        .onAppear {
            // Mock trace entries with seq=0 (real off-spine trace entries
            // have no spine seq). Before the ForEach-id fix these all
            // collided on "session:0" and SwiftUI rendered only one row.
            // Use 3 distinct tools to verify every step renders.
            appState.messageStore.setTurnSteps(sessionId, bubbleSeq: message.seq, [
                ChatMessage(type: "agent_narration", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["content": AnyCodable("Let me check the codebase.")]),
                ChatMessage(type: "tool_start", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("tc1"), "headline": AnyCodable("read package.json")]),
                ChatMessage(type: "tool_complete", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("read"), "toolCallId": AnyCodable("tc1"), "headline": AnyCodable("read package.json"), "success": AnyCodable(true)]),
                ChatMessage(type: "tool_start", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("edit"), "toolCallId": AnyCodable("tc2"), "headline": AnyCodable("edit app.js")]),
                ChatMessage(type: "tool_complete", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("edit"), "toolCallId": AnyCodable("tc2"), "headline": AnyCodable("edit app.js"), "success": AnyCodable(true)]),
                ChatMessage(type: "agent_narration", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["content": AnyCodable("Now let me verify the change.")]),
                ChatMessage(type: "tool_start", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc3"), "headline": AnyCodable("$ node test.js")]),
                ChatMessage(type: "tool_complete", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                            payload: ["toolName": AnyCodable("bash"), "toolCallId": AnyCodable("tc3"), "headline": AnyCodable("$ node test.js"), "success": AnyCodable(true)]),
            ])
            appState.messageStore.setTurnSteps(sessionId, bubbleSeq: 40, liveSmokeSteps(completed: false))

            // Deterministic visual smoke: open a long live Steps sheet, then
            // replace its final running tool in place and append a new row. The
            // sheet must start at — and remain attached to — the bottom.
            if ProcessInfo.processInfo.environment["KRAKI_AUTO_OPEN_LIVE_STEPS"] == "1" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    showsLiveSteps = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) {
                    appState.messageStore.setTurnSteps(sessionId, bubbleSeq: 40, liveSmokeSteps(completed: true))
                }
            }
        }
    }

    private func liveSmokeSteps(completed: Bool) -> [ChatMessage] {
        var entries: [ChatMessage] = (1...60).map { index in
            ChatMessage(type: "agent_narration", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                        payload: ["content": AnyCodable("Live step \(index): inspecting the current turn state.")])
        }
        entries.append(ChatMessage(
            type: completed ? "tool_complete" : "tool_start", seq: 0,
            sessionId: sessionId, deviceId: "d", timestamp: nil,
            payload: [
                "toolName": AnyCodable("bash"),
                "toolCallId": AnyCodable("live-final"),
                "headline": AnyCodable(completed ? "$ pwd — complete" : "$ pwd — running"),
                "success": AnyCodable(true),
            ]))
        if completed {
            entries.append(ChatMessage(
                type: "agent_narration", seq: 0, sessionId: sessionId, deviceId: "d", timestamp: nil,
                payload: ["content": AnyCodable("Newest live step: the tool completed successfully.")]))
        }
        return entries
    }
}

private struct FlatBubbleTestCell: UIViewRepresentable {
    let message: ChatMessage
    let sessionId: String
    let attachmentStore: AttachmentStore
    @Binding var showsSteps: Bool

    func makeUIView(context: Context) -> TKBubbleCell {
        TKBubbleCell(frame: .zero)
    }

    func updateUIView(_ cell: TKBubbleCell, context: Context) {
        let width = UIScreen.main.bounds.width
        cell.bounds = CGRect(x: 0, y: 0, width: width, height: 150)
        let content = TKBubbleContent.make(message: message, sessionId: sessionId, agent: "pi")
        cell.attachmentStore = attachmentStore
        cell.configure(content, cellWidth: width)
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
        cell.onOpenSteps = { _ in
            showsSteps = true
        }
    }
}

/// Hosts the unified TKBubbleCell with a live / frozen content (action slot),
/// verifying the SAME cell renders streaming + terminal turns — no separate
/// live-card component.
private struct FlatBubbleActionCell: UIViewRepresentable {
    let content: TKBubbleContent
    let attachmentStore: AttachmentStore
    var onSteps: () -> Void

    func makeUIView(context: Context) -> TKBubbleCell {
        TKBubbleCell(frame: .zero)
    }

    func updateUIView(_ cell: TKBubbleCell, context: Context) {
        let width = UIScreen.main.bounds.width
        let height = content.cellHeight(cellWidth: width) + 8
        cell.bounds = CGRect(x: 0, y: 0, width: width, height: height)
        cell.onOpenSteps = { _ in onSteps() }
        cell.attachmentStore = attachmentStore
        cell.configure(content, cellWidth: width)
        cell.setNeedsLayout()
        cell.layoutIfNeeded()
    }
}
#endif
