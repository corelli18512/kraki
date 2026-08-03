#if os(macOS)
import SwiftUI

/// TRACE-axis history for one concluded or live bubble. Content lifecycle and
/// spacing mirror iOS `StepsSheetView`; only the presentation container is a
/// native Mac popover instead of an iOS sheet.
struct MacStepsView: View {
    let sessionId: String
    let targetSeq: Int
    var live = false
    let agent: String
    let store: MessageStore

    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    private var loadedSteps: [ChatMessage]? {
        store.turnSteps(sessionId, bubbleSeq: targetSeq)
    }
    private var steps: [ChatMessage] {
        loadedSteps ?? []
    }
    private var liveActionKey: String? {
        StepsLiveSyncMac.actionKey(store.cards[sessionId]?.action)
    }
    private var mergedStepsSignature: String {
        StepsLiveSyncMac.stepsSignature(mergedSteps)
    }

    var body: some View {
        let _ = store.traceRevision
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                Group {
                    if loadedSteps == nil {
                        VStack(spacing: 10) {
                            ProgressView()
                            Text("Loading steps…")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if steps.isEmpty {
                        ContentUnavailableView(
                            "No steps recorded",
                            systemImage: "checkmark.circle",
                            description: Text("This turn completed without a recorded tool trace.")
                        )
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                ForEach(Array(mergedSteps.enumerated()), id: \.offset) { _, step in
                                    stepView(step)
                                }
                                Color.clear.frame(height: 1).id(StepsLiveSyncMac.bottomID)
                            }
                            .padding(16)
                        }
                    }
                }
                .onAppear {
                    #if DEBUG
                    if MacAutomationDriver.shared.enabled {
                        MacAutomationDriver.shared.updatePresentedSteps(sessionId: sessionId, seq: targetSeq)
                    }
                    #endif
                    scrollToLatest(proxy, animated: false)
                    refreshTrace()
                }
                .onChange(of: mergedStepsSignature) { oldValue, newValue in
                    guard !newValue.isEmpty else { return }
                    if live || oldValue.isEmpty {
                        scrollToLatest(proxy, animated: live && !oldValue.isEmpty)
                    }
                }
                .onChange(of: liveActionKey) { oldValue, newValue in
                    guard live, oldValue != newValue else { return }
                    refreshTrace()
                }
            }
        }
        .frame(width: 420, height: 480)
        .background(Color.surfacePrimary)
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .macNativeAutomationAction)) { note in
            guard MacAutomationDriver.shared.enabled,
                  note.userInfo?["action"] as? String == "closeSteps" else { return }
            dismiss()
        }
        #endif
    }

    private var header: some View {
        HStack {
            Text("Steps")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.textTitle)
            Spacer()
            if live {
                Text("live")
                    .font(.system(size: 10, weight: .heavy))
                    .foregroundStyle(Color.krakiPrimary)
                    .textCase(.uppercase)
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close steps")
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 44)
    }

    private func refreshTrace() {
        guard let provider = appState.messageProvider else { return }
        if live || store.turnSteps(sessionId, bubbleSeq: targetSeq)?.isEmpty == true {
            provider.invalidateTurnTrace(sessionId: sessionId, bubbleSeq: targetSeq)
        }
        provider.requestTurnTrace(sessionId: sessionId, bubbleSeq: targetSeq)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        guard !mergedSteps.isEmpty else { return }
        Task { @MainActor in
            await Task.yield()
            if animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(StepsLiveSyncMac.bottomID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(StepsLiveSyncMac.bottomID, anchor: .bottom)
            }
        }
    }

    private var mergedSteps: [ChatMessage] {
        var output: [ChatMessage] = []
        var starts: [String: Int] = [:]
        for message in steps.sorted(by: { $0.seq < $1.seq }) {
            guard let callId = message.toolCallId, !callId.isEmpty else {
                output.append(message)
                continue
            }
            if message.type == "tool_start" {
                starts[callId] = output.count
                output.append(message)
            } else if message.type == "tool_complete", let index = starts.removeValue(forKey: callId) {
                output[index] = message
            } else {
                output.append(message)
            }
        }
        return output
    }

    @ViewBuilder
    private func stepView(_ message: ChatMessage) -> some View {
        switch message.type {
        case "tool_start", "tool_complete":
            MacToolActivityRow(message: message, sessionId: sessionId)
        case "agent_message", "agent_narration":
            if let content = message.content, !content.isEmpty {
                Text(content)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.textSecondary)
                    .textSelection(.enabled)
            }
        case "error":
            Label(message.content ?? message.result ?? "Error", systemImage: "exclamationmark.triangle")
                .font(.system(size: 15))
                .foregroundStyle(.red)
        case "permission":
            Label(message.content ?? "Permission request", systemImage: "lock")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        case "question":
            Label(message.question ?? message.content ?? "Question", systemImage: "questionmark.circle")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
        default:
            if let content = message.content, !content.isEmpty {
                Text(content)
                    .font(.system(size: 15))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

private enum StepsLiveSyncMac {
    static let bottomID = "__steps_bottom__"

    static func actionKey(_ action: ChatMessage?) -> String? {
        guard let action else { return nil }
        switch action.type {
        case "tool_start", "tool_complete":
            return "\(action.type):\(action.toolCallId ?? action.headline ?? action.toolName ?? "tool")"
        case "tool_batch":
            return "tool_batch:\(action.payload["running"]?.intValue ?? 0)"
        case "permission":
            let state = action.cancelled ? "cancelled" : action.payload["decision"]?.stringValue ?? "pending"
            return "permission:\(action.permissionId ?? "unknown"):\(state)"
        case "question":
            let state = action.cancelled ? "cancelled" : action.answer.map { "answered:\($0)" } ?? "pending"
            return "question:\(action.questionId ?? "unknown"):\(state)"
        case "user_abort":
            return "user_abort:\(action.payload["abortedAt"]?.stringValue ?? "")"
        case "failed":
            return "failed:\(action.payload["failedAt"]?.stringValue ?? ""):\(action.payload["code"]?.stringValue ?? "")"
        default:
            return nil
        }
    }

    static func stepsSignature(_ steps: [ChatMessage]) -> String {
        steps.map { step in
            [
                step.type,
                step.toolCallId ?? "",
                step.toolName ?? "",
                step.headline ?? "",
                step.content ?? "",
                step.result ?? "",
                step.payload["success"]?.boolValue.map(String.init) ?? "",
                step.cancelled ? "cancelled" : "",
                step.payload["decision"]?.stringValue ?? "",
                step.answer ?? "",
            ].joined(separator: "|")
        }.joined(separator: "\u{1F}")
    }
}
#endif
