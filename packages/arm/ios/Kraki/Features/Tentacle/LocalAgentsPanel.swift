/// LocalAgentsPanel — the coding agents on this Mac, as found by
/// `kraki agents --json`.
///
/// Only agents that are installed are listed (ready, not signed in, or not
/// starting, each with its hint): someone with just one agent sees one row.
/// Every supported agent — with what it is, how Kraki finds it and how to
/// install it — is one click away in the "Supported agents" sheet, which also
/// scales as Kraki supports more agents.
///
/// Shared by setup step 1 (ThisMacSetupStep) and the "Coding Agents on This
/// Mac" window (LocalAgentsWindow) the user can open any time later.

#if os(macOS)
import AppKit
import SwiftUI

struct LocalAgentsPanel: View {
    let check: LocalAgentsCheck
    let binaryPath: String
    @State private var showingCatalog = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !check.hasResults && check.installedAgents.isEmpty {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Looking for coding agents on this Mac…")
                        .font(.system(size: 12)).foregroundStyle(Color.textSecondary)
                }
                .padding(.vertical, 8)
            } else if check.installedAgents.isEmpty {
                noAgents
            } else {
                VStack(spacing: 0) {
                    ForEach(check.installedAgents) { agent in
                        agentRow(agent)
                        if agent.id != check.installedAgents.last?.id { Divider().opacity(0.5) }
                    }
                }
            }
            HStack(spacing: 12) {
                Text(agentsSummary)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
                Spacer()
                // With nothing installed, "Choose an agent to install…" above
                // already opens the same sheet.
                if !check.installedAgents.isEmpty {
                    Button { showingCatalog = true } label: {
                        Text("Supported agents")
                            .font(.system(size: 10.5))
                            .foregroundStyle(Color.krakiPrimary)
                    }
                    .buttonStyle(.plain)
                    .onHover { inside in if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() } }
                    .accessibilityIdentifier("mac.setup.agents.catalog")
                }
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
        .sheet(isPresented: $showingCatalog) {
            SupportedAgentsSheet(check: check, binaryPath: binaryPath)
        }
    }

    /// Nothing installed yet: say so plainly and point to the catalog.
    private var noAgents: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No coding agent found on this Mac yet.")
                .font(.system(size: 12, weight: .medium)).foregroundStyle(Color.textPrimary)
            Text("Kraki runs agents like Claude Code, Codex, GitHub Copilot CLI or Pi. Install one, sign in to it, then click Check Again.")
                .font(.system(size: 11)).foregroundStyle(Color.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Button("Choose an agent to install…") { showingCatalog = true }
                .controlSize(.small)
                .padding(.top, 2)
        }
        .padding(.vertical, 6)
        .accessibilityIdentifier("mac.setup.agents.none")
    }

    private var agentsSummary: String {
        if check.isRunning { return "Checking…" }
        switch check.readyCount {
        case 0: return check.installedAgents.isEmpty ? "" : "No agent is ready yet."
        case 1: return "Ready to use."
        default: return "\(check.readyCount) agents ready."
        }
    }

    private func agentRow(_ agent: LocalAgentsCheck.Agent) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            AgentStatusIcon(status: agent.status).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(agent.name)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(Color.textPrimary)
                    if let version = agent.version {
                        Text(version).font(.system(size: 10.5)).foregroundStyle(Color.textMuted)
                    }
                }
                if let line = Self.detailLine(agent) {
                    Text(line)
                        .font(.system(size: 10.5))
                        .foregroundStyle(agent.status == .ready ? Color.textSecondary : Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 8)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("mac.setup.agent.\(agent.id)")
    }

    static func detailLine(_ agent: LocalAgentsCheck.Agent) -> String? {
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
}

struct AgentStatusIcon: View {
    let status: LocalAgentsCheck.Status
    var body: some View {
        switch status {
        case .checking:
            ProgressView().controlSize(.mini)
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.green)
        case .needsLogin, .error:
            Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Color.orange)
        case .notInstalled:
            Image(systemName: "circle.dashed").foregroundStyle(Color.textMuted)
        }
    }
}

/// Every agent Kraki supports: what it is, whether it is on this Mac, how
/// Kraki finds it, and where to install it.
struct SupportedAgentsSheet: View {
    let check: LocalAgentsCheck
    let binaryPath: String
    @Environment(\.dismiss) private var dismiss

    private func result(_ id: String) -> LocalAgentsCheck.Agent? {
        check.displayedAgents.first { $0.id == id }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Supported coding agents").font(.system(size: 15, weight: .semibold))
                Text("Kraki runs the agents you install on this Mac, with your own accounts. Install an agent and sign in to it once in Terminal, then click Check Again.")
                    .font(.system(size: 11.5)).foregroundStyle(Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 0) {
                ForEach(LocalAgentsCheck.catalog) { entry in
                    row(entry)
                    if entry.id != LocalAgentsCheck.catalog.last?.id { Divider().opacity(0.5) }
                }
            }
            HStack {
                if check.isRunning {
                    ProgressView().controlSize(.small)
                    Text("Checking…").font(.system(size: 11)).foregroundStyle(Color.textMuted)
                }
                Spacer()
                Button("Check Again") { check.run(binaryPath: binaryPath) }
                    .disabled(check.isRunning)
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityIdentifier("mac.agents.catalog")
    }

    private func row(_ entry: LocalAgentsCheck.CatalogEntry) -> some View {
        let agent = result(entry.id)
        let status = agent?.status ?? .checking
        return HStack(alignment: .top, spacing: 10) {
            AgentStatusIcon(status: status).frame(width: 16).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(entry.name).font(.system(size: 12.5, weight: .medium))
                    Text(entry.maker).font(.system(size: 10.5)).foregroundStyle(Color.textMuted)
                }
                Text(entry.blurb).font(.system(size: 11)).foregroundStyle(Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(statusLine(agent)).font(.system(size: 10.5))
                    .foregroundStyle(status == .ready ? Color.green : Color.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if status == .notInstalled {
                    Text(entry.detect).font(.system(size: 10.5)).foregroundStyle(Color.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            if status == .notInstalled {
                Button("Install guide") { NSWorkspace.shared.open(agent?.installURL ?? entry.installURL) }
                    .controlSize(.small)
                    .help((agent?.installURL ?? entry.installURL).absoluteString)
            }
        }
        .padding(.vertical, 8)
        .accessibilityIdentifier("mac.agents.catalog.\(entry.id)")
    }

    private func statusLine(_ agent: LocalAgentsCheck.Agent?) -> String {
        guard let agent else { return "Checking…" }
        switch agent.status {
        case .checking: return "Checking…"
        case .notInstalled: return "Not installed on this Mac."
        default:
            let version = agent.version.map { " \($0)" } ?? ""
            return "Installed\(version) — " + (LocalAgentsPanel.detailLine(agent) ?? "")
        }
    }
}

#endif
