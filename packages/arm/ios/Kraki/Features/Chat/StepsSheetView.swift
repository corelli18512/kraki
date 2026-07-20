#if os(iOS)
import SwiftUI

/// TRACE-axis history for one concluded spine bubble. This view deliberately
/// lives outside the bubble: opening it lazily pulls `turn_trace_batch`, while
/// the chat list remains a flat sequence of persisted messages.
struct StepsSheetView: View {
    let sessionId: String
    /// The trace target seq: a concluded turn's concluding bubble seq, or — for
    /// an in-progress (`live`) turn — the leading `user_message` seq. The
    /// tentacle resolves either to the same turn (greatest user_message ≤ seq).
    let targetSeq: Int
    /// In-progress turn: force a fresh trace pull on every open so the running
    /// steps stay current (mirrors web's `live=true`).
    var live: Bool = false
    let agent: String
    let store: MessageStore

    @Environment(AppState.self) private var appState

    private var steps: [ChatMessage] {
        store.turnSteps(sessionId, bubbleSeq: targetSeq) ?? []
    }

    /// TRACE is pull-based rather than broadcast live. Refresh only at semantic
    /// action boundaries (tool start/complete, prompt open/resolve, terminal),
    /// never from the narration draft — otherwise every streamed token would
    /// issue another trace request.
    private var liveActionKey: String? {
        StepsLiveSync.actionKey(store.cards[sessionId]?.action)
    }

    /// Count alone is insufficient: tool_start is merged in place into
    /// tool_complete, so the visible row can change while the count stays flat.
    private var mergedStepsSignature: String {
        StepsLiveSync.stepsSignature(mergedSteps)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Group {
                    if steps.isEmpty {
                        VStack(spacing: 10) {
                            ProgressView()
                            Text("Loading steps…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                // Trace entries are off-spine (seq=0) so their
                                // ChatMessage.id collides on "session:0". Use the
                                // array offset as ForEach identity — without this,
                                // SwiftUI collapses every step into a single row.
                                ForEach(Array(mergedSteps.enumerated()), id: \.offset) { _, step in
                                    stepView(step)
                                }
                                Color.clear
                                    .frame(height: 1)
                                    .id(StepsLiveSync.bottomID)
                            }
                            .padding(16)
                        }
                    }
                }
                .onAppear {
                    // Cached/concluded traces open at their newest step. Yield
                    // one layout pass so the LazyVStack has installed the bottom
                    // sentinel before asking the reader to reveal it.
                    scrollToLatest(proxy, animated: false)
                    refreshLiveTrace()
                }
                .onChange(of: mergedStepsSignature) { oldValue, newValue in
                    guard !newValue.isEmpty else { return }
                    // Live Steps are a tailing view: every new row, and every
                    // in-place start→complete replacement, stays attached to the
                    // bottom. A concluded trace only needs its initial position.
                    if live || oldValue.isEmpty {
                        scrollToLatest(proxy, animated: live && !oldValue.isEmpty)
                    }
                }
                .onChange(of: liveActionKey) { oldValue, newValue in
                    guard live, oldValue != newValue else { return }
                    refreshLiveTrace()
                }
            }
            .navigationTitle("Steps")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func refreshLiveTrace() {
        guard live, let provider = appState.messageProvider else { return }
        provider.invalidateTurnTrace(sessionId: sessionId, bubbleSeq: targetSeq)
        provider.requestTurnTrace(sessionId: sessionId, bubbleSeq: targetSeq)
    }

    private func scrollToLatest(_ proxy: ScrollViewProxy, animated: Bool) {
        guard !mergedSteps.isEmpty else { return }
        Task { @MainActor in
            await Task.yield()
            if animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(StepsLiveSync.bottomID, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(StepsLiveSync.bottomID, anchor: .bottom)
            }
        }
    }

    /// Collapse matching tool_start/tool_complete entries into the terminal
    /// entry, matching the web StepsList contract.
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
            ToolActivityView(
                type: message.type == "tool_start" ? .start : .complete,
                toolName: message.toolName ?? "tool",
                headline: message.headline,
                argsRef: message.argsRef,
                resultRef: message.resultRef,
                inlineArgs: message.args,
                sessionId: sessionId,
                success: message.payload["success"]?.boolValue,
                cancelled: message.cancelled
            )
        case "agent_message", "agent_narration":
            if let content = message.content, !content.isEmpty {
                Text(content)
                    .font(.subheadline)
                    .foregroundStyle(Color.textSecondary)
                    .textSelection(.enabled)
            }
        case "error":
            Label(message.content ?? message.result ?? "Error", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.red)
        case "permission":
            Label(message.content ?? "Permission request", systemImage: "lock")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        case "question":
            Label(message.question ?? message.content ?? "Question", systemImage: "questionmark.circle")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        default:
            if let content = message.content, !content.isEmpty {
                Text(content)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

/// Pure synchronization keys shared by the live Steps view and its tests.
/// Keeping these independent from SwiftUI makes the important contract clear:
/// draft tokens do not refresh TRACE; semantic action/row transitions do.
enum StepsLiveSync {
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
