/// ThisMacSetupStep — setup step 1, "Set up this Mac".
///
/// Shows which of the coding agents Kraki supports can run on this Mac
/// (installed, signed in, models available — checked with the built-in
/// tentacle, see LocalAgentsCheck) and asks for Full Disk Access, which the
/// agents need to work in any folder without macOS prompts.
///
/// The step can be skipped: the user may use this Mac only to control agents
/// on other computers, in which case no background service runs here.

#if os(macOS)
import AppKit
import SwiftUI

struct ThisMacSetupStep: View {
    let binaryPath: String
    let onContinue: () -> Void
    let onSkip: () -> Void

    @State private var check: LocalAgentsCheck
    @State private var hasFullDiskAccess: Bool
    private let pollsFullDiskAccess: Bool

    init(binaryPath: String, onContinue: @escaping () -> Void, onSkip: @escaping () -> Void) {
        self.binaryPath = binaryPath
        self.onContinue = onContinue
        self.onSkip = onSkip
        _check = State(initialValue: LocalAgentsCheck())
        _hasFullDiskAccess = State(initialValue: BuiltInTentacle.hasFullDiskAccess())
        pollsFullDiskAccess = true
    }

    #if DEBUG
    /// Previews / snapshot tests: fixed agent results and FDA state.
    init(preview agents: [LocalAgentsCheck.Agent], fullDiskAccess: Bool) {
        binaryPath = ""
        onContinue = {}
        onSkip = {}
        _check = State(initialValue: LocalAgentsCheck.preview(agents))
        _hasFullDiskAccess = State(initialValue: fullDiskAccess)
        pollsFullDiskAccess = false
    }
    #endif

    var body: some View {
        StepCard(
            step: "Step 1 of 2",
            title: "Set up this Mac",
            detail: "Kraki runs the coding agents installed on this Mac, so you can use them from here, your phone and your other computers."
        ) {
            VStack(spacing: 14) {
                section(title: "Coding agents") {
                    LocalAgentsPanel(check: check, binaryPath: binaryPath)
                }
                fullDiskAccessSection
                actions
            }
        }
        .task { if !check.previewOnly { check.run(binaryPath: binaryPath) } }
        .task {
            // Picks up the grant while System Settings is open (and after the
            // Quit & Reopen macOS offers, the step reloads with it granted).
            while pollsFullDiskAccess, !Task.isCancelled {
                hasFullDiskAccess = BuiltInTentacle.hasFullDiskAccess()
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        .onDisappear { check.cancel() }
    }

    // MARK: Full Disk Access

    private var fullDiskAccessSection: some View {
        section(title: "Full Disk Access") {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: hasFullDiskAccess ? "checkmark.circle.fill" : "lock.circle")
                    .foregroundStyle(hasFullDiskAccess ? Color.green : Color.textMuted)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 4) {
                    Text(hasFullDiskAccess
                         ? "Allowed. Agents can work in any folder without macOS prompts."
                         : "Agents read and edit files across your projects. Allow it once and macOS won't interrupt them with permission prompts.")
                        .font(.system(size: 10.5))
                        .foregroundStyle(Color.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !hasFullDiskAccess {
                        Text("Turn on “Kraki” in the list. If macOS offers to quit and reopen Kraki, choose Quit & Reopen.")
                            .font(.system(size: 10))
                            .foregroundStyle(Color.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if !hasFullDiskAccess {
                    Button("Open System Settings") { BuiltInTentacle.openFullDiskAccessSettings() }
                        .controlSize(.small)
                        .accessibilityIdentifier("mac.setup.openFDA")
                }
            }
            .padding(.vertical, 6)
        }
    }

    // MARK: Actions

    /// Running agents here needs at least one working agent and Full Disk
    /// Access; without them the user can still skip (remote-only).
    private var blockingReason: String? {
        Self.blockingReason(isChecking: check.isRunning, readyAgents: check.readyCount, hasFullDiskAccess: hasFullDiskAccess)
    }

    static func blockingReason(isChecking: Bool, readyAgents: Int, hasFullDiskAccess: Bool) -> String? {
        if readyAgents == 0 {
            return isChecking ? "Checking the agents on this Mac…" : "Set up at least one coding agent, then click Check Again."
        }
        if !hasFullDiskAccess { return "Allow Full Disk Access to continue." }
        return nil
    }

    private var actions: some View {
        VStack(spacing: 8) {
            Button {
                check.cancel()
                onContinue()
            } label: {
                Text("Continue").frame(minWidth: 160, minHeight: 22)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color.krakiPrimary)
            .disabled(blockingReason != nil)
            .accessibilityIdentifier("mac.setup.thisMac.continue")

            if let reason = blockingReason {
                Text(reason)
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.textMuted)
            }

            Button {
                check.cancel()
                onSkip()
            } label: {
                Text("Skip — don't run agents on this Mac, only control other computers")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.krakiPrimary)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("mac.setup.thisMac.skip")
        }
    }

    private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 9.5, weight: .semibold))
                .tracking(0.7)
                .foregroundStyle(Color.textMuted)
            VStack(alignment: .leading, spacing: 0) { content() }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.surfaceSecondary.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .frame(maxWidth: 460)
    }
}

#endif
