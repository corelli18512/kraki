/// NoAgentsGuide — shown when a device is connected but reports no coding
/// agent. Kraki only relays the agents a computer already has, so a fresh
/// machine needs one installed (and signed in) before sessions can start.
import SwiftUI

struct AgentInstallLink: Identifiable {
    let id: String
    let name: String
    let url: URL

    static let all: [AgentInstallLink] = [
        AgentInstallLink(id: "claude", name: "Claude Code",
                         url: URL(string: "https://code.claude.com/docs/en/setup")!),
        AgentInstallLink(id: "codex", name: "Codex",
                         url: URL(string: "https://developers.openai.com/codex/cli")!),
        AgentInstallLink(id: "copilot", name: "GitHub Copilot CLI",
                         url: URL(string: "https://github.com/features/copilot/cli")!),
        AgentInstallLink(id: "pi", name: "pi",
                         url: URL(string: "https://github.com/earendil-works/pi#readme")!),
    ]
}

struct NoAgentsGuide: View {
    let deviceName: String
    /// True when the device is this Mac's own tentacle.
    var isThisMac: Bool = false
    /// Re-detect agents (restarts the local tentacle). nil for remote devices.
    var checkAgain: (() async -> Void)?

    @Environment(\.openURL) private var openURL
    @State private var checking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(isThisMac ? "No coding agent on this Mac" : "No coding agent on \(deviceName)")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text(isThisMac
                     ? "Kraki works with the coding agents on your computer. Install one and sign in to it, then check again."
                     : "Kraki works with the coding agents on that computer. Install one there, sign in to it, then restart Kraki on it.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 0) {
                ForEach(Array(AgentInstallLink.all.enumerated()), id: \.element.id) { index, agent in
                    if index > 0 { Divider() }
                    HStack {
                        Text(agent.name)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Color.textPrimary)
                        Spacer()
                        Button {
                            openURL(agent.url)
                        } label: {
                            HStack(spacing: 3) {
                                Text("How to install")
                                Image(systemName: "arrow.up.right")
                                    .font(.system(size: 9, weight: .semibold))
                            }
                            .font(.system(size: 12))
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.krakiPrimary)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Color.surfaceTertiary)
            )

            if let checkAgain {
                HStack {
                    Button {
                        guard !checking else { return }
                        checking = true
                        Task {
                            await checkAgain()
                            checking = false
                        }
                    } label: {
                        if checking {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Checking…")
                            }
                        } else {
                            Label("Check Again", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(checking)
                    Spacer()
                }
            }
        }
    }
}
