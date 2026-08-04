/// ChatPlaceholderView — Mac chat detail-pane placeholder until iOS
/// ChatListViewController stabilizes (M2 deferred).
///
/// Shows:
///   - Session header (title, agent, model, mode, device)
///   - Banner: "Chat UI under construction"
///   - Plain-text dump of last N messages from MessageStore (proves
///     data flow is alive without committing to a layout)
///   - Disabled input stub
///
/// This is intentionally ugly so we don't mistake it for finished UI,
/// and so the swap path is one file replacement when iOS ChatView lands.

#if os(macOS)
import SwiftUI

struct ChatPlaceholderView: View {
    @Environment(AppState.self) private var appState
    let session: SessionInfo

    @State private var messages: [ChatMessage] = []
    @State private var refreshTrigger = UUID()

    private let messageLimit = 40

    var body: some View {
        VStack(spacing: 0) {
            header

            placeholderBanner

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if messages.isEmpty {
                        VStack(spacing: 6) {
                            Image(systemName: "tray")
                                .font(.system(size: 24, weight: .light))
                                .foregroundStyle(Color.textMuted)
                            Text("No messages yet.")
                                .font(.system(size: 12))
                                .foregroundStyle(Color.textSecondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(40)
                    } else {
                        ForEach(messages, id: \.seq) { msg in
                            messageRow(msg)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .background(Color.surfacePrimary)

            inputStub
        }
        .task(id: session.id) {
            await loadMessages()
        }
        .onChange(of: appState.sessionStore.sessions[session.id]?.lastSeq) {
            Task { await loadMessages() }
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            AgentAvatar(agent: session.agent, sessionId: session.id, size: .sm, status: session.state)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.textTitle)
                HStack(spacing: 6) {
                    Text(session.agent)
                    if let model = session.model { Text("· \(model)") }
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
            }

            Spacer()

            HStack(spacing: 6) {
                Circle()
                    .fill(Color.modeColor(session.mode))
                    .frame(width: 6, height: 6)
                Text(session.mode.rawValue.uppercased())
                    .font(.system(size: 10, weight: .heavy))
                    .tracking(0.5)
                    .foregroundStyle(Color.modeColor(session.mode))
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                Capsule()
                    .fill(Color.modeColor(session.mode).opacity(0.12))
            )

            if let device = appState.deviceStore.devices[session.deviceId] {
                HStack(spacing: 5) {
                    Circle()
                        .fill(device.online ? Color(hex: 0x34D399) : Color.textMuted)
                        .frame(width: 5, height: 5)
                    Text(device.name)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Color.textSecondary)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(Color.surfaceTertiary)
                )
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.surfacePrimary)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.borderPrimary)
                .frame(height: 1)
        }
    }

    private var placeholderBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "hammer.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color(hex: 0xFBBF24))
            Text("Chat UI under construction — sharing iOS ChatListViewController once it stabilizes.")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.textSecondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(hex: 0xFBBF24).opacity(0.12))
    }

    private func messageRow(_ msg: ChatMessage) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(roleLabel(for: msg))
                    .font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .tracking(0.6)
                    .foregroundStyle(roleColor(for: msg))
                Text("#\(msg.seq)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Color.textMuted)
                Spacer()
            }
            Text(extractText(msg))
                .font(.system(size: 12))
                .textSelection(.enabled)
                .foregroundStyle(Color.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color.surfaceSecondary)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.borderPrimary, lineWidth: 1)
        )
    }

    private var inputStub: some View {
        HStack(spacing: 8) {
            TextField("Send a message (disabled — placeholder UI)", text: .constant(""))
                .disabled(true)
                .textFieldStyle(.roundedBorder)
                .help("Input UI ships with M2 chat work.")
            Button("Send") {}
                .disabled(true)
                .buttonStyle(.borderedProminent)
                .tint(Color.krakiPrimary)
                .keyboardShortcut(.return, modifiers: [])
        }
        .padding(12)
        .background(Color.surfacePrimary)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.borderPrimary)
                .frame(height: 1)
        }
    }

    // MARK: - Data

    private func loadMessages() async {
        let recent = appState.messageStore.recentFromDB(session.id, limit: messageLimit)
        await MainActor.run { self.messages = recent }
    }

    private func roleLabel(for msg: ChatMessage) -> String {
        switch msg.type {
        case "user_message": return "USER"
        case "tool_start", "tool_complete", "tool_error": return "TOOL"
        case "permission_request", "permission_response": return "PERM"
        case "question", "answer": return "Q&A"
        case "agent_text", "agent_message": return "AGENT"
        default: return msg.type.uppercased()
        }
    }

    private func roleColor(for msg: ChatMessage) -> Color {
        switch msg.type {
        case "user_message": return Color.krakiPrimary
        case "tool_start", "tool_complete", "tool_error": return Color(hex: 0xFBBF24)
        case "permission_request", "permission_response": return Color(hex: 0xF4836E)
        case "question", "answer": return Color(hex: 0x22D3EE)
        default: return Color.textMuted
        }
    }

    private func extractText(_ msg: ChatMessage) -> String {
        if let content = msg.content, !content.isEmpty { return content }
        if let headline = msg.headline, !headline.isEmpty { return headline }
        if let tool = msg.toolName { return "[\(tool)]" }
        if let q = msg.question { return q }
        if let a = msg.answer { return a }
        return "(\(msg.type))"
    }
}

#endif
