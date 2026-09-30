/// LocalAgentsPanel — the coding agents on this Mac, as found by
/// `kraki agents --json`: one row per supported agent (ready / not signed in /
/// not installed / error, with a hint) and a Check Again button.
///
/// Shared by setup step 1 (ThisMacSetupStep) and the "Coding Agents on This
/// Mac" window (LocalAgentsWindow) the user can open any time later.

#if os(macOS)
import AppKit
import SwiftUI

struct LocalAgentsPanel: View {
    let check: LocalAgentsCheck
    let binaryPath: String


    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(spacing: 0) {
                ForEach(check.agents) { agent in
                    agentRow(agent)
                    if agent.id != check.agents.last?.id { Divider().opacity(0.5) }
                }
            }
            HStack {
                Text(agentsSummary)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
                Spacer()
                Button("Check Again") { check.run(binaryPath: binaryPath) }
                    .controlSize(.small)
                    .disabled(check.isRunning)
                    .accessibilityIdentifier("mac.setup.agents.checkAgain")
            }
            .padding(.top, 6)
            if let failure = check.failure {
                Text(failure).font(.system(size: 10.5)).foregroundStyle(Color.orange)
            }
        }
    }

    private var agentsSummary: String {
        if check.isRunning { return "Checking…" }
        switch check.readyCount {
        case 0: return "No agent is ready yet."
        case 1: return "1 agent is ready."
        default: return "\(check.readyCount) agents are ready."
        }
    }

    private func agentRow(_ agent: LocalAgentsCheck.Agent) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            statusIcon(agent.status)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(agent.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.textPrimary)
                    if let version = agent.version, agent.status != .notInstalled {
                        Text(version).font(.system(size: 10.5)).foregroundStyle(Color.textMuted)
                    }
                }
                if let line = detailLine(agent) {
                    Text(line)
                        .font(.system(size: 10.5))
                        .foregroundStyle(agent.status == .ready ? Color.textSecondary : Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
            // Installing an agent is the vendor's business: a plain link for
            // convenience, not a call to action.
            if agent.status == .notInstalled, let url = agent.installURL {
                Button { NSWorkspace.shared.open(url) } label: {
                    HStack(spacing: 2) {
                        Text("How to install")
                        Image(systemName: "arrow.up.right").font(.system(size: 8, weight: .semibold))
                    }
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
                }
                .buttonStyle(.plain)
                .help(url.absoluteString)
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("mac.setup.agent.\(agent.id)")
    }

    private func detailLine(_ agent: LocalAgentsCheck.Agent) -> String? {
        switch agent.status {
        case .checking: return nil
        case .ready:
            let noun = agent.models == 1 ? "model" : "models"
            return "Ready · \(agent.models) \(noun)"
        case .needsLogin: return "Not signed in. " + (agent.hint ?? "")
        case .notInstalled: return "Not installed"
        case .error: return agent.hint ?? "Couldn't start."
        }
    }

    @ViewBuilder
    private func statusIcon(_ status: LocalAgentsCheck.Status) -> some View {
        switch status {
        case .checking:
            ProgressView().controlSize(.mini)
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
        case .needsLogin, .error:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.orange)
        case .notInstalled:
            Image(systemName: "minus.circle").foregroundStyle(Color.textMuted)
        }
    }
}

#endif
