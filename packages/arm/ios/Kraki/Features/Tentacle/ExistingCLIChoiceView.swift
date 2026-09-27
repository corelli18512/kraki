/// ExistingCLIChoiceView — asked once when Kraki for Mac finds that the
/// command-line install already runs Kraki on this Mac.
///
/// Only one of them may run the background daemon (two would share a device
/// id). Instead of silently picking, the user chooses; the choice is stored as
/// the tentacle mode preference, so the question never comes back. Settings →
/// Tentacle can change it later.

#if os(macOS)
import SwiftUI

struct ExistingCLIChoiceView: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @State private var switching: TentacleMode?

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Image("KrakiLogo")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 56, height: 56)
                    .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                Text("Kraki is already set up on this Mac")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text(subtitle)
                    .font(.system(size: 11.5))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                option(
                    mode: .builtIn,
                    title: "Use Kraki for Mac",
                    badge: "Recommended",
                    detail: "Kraki for Mac runs Kraki in the background and updates it with the app. Your sign-in and sessions carry over. You'll allow Full Disk Access for Kraki once.",
                    identifier: "mac.ownerChoice.builtIn"
                )
                option(
                    mode: .external,
                    title: "Keep the command-line version",
                    badge: nil,
                    detail: "Kraki for Mac uses the install you already have. You keep updating it from Terminal.",
                    identifier: "mac.ownerChoice.external"
                )
            }

            if let error = tentacleCLI.lastError, switching == nil {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.orange)
                    .multilineTextAlignment(.center)
            }

            Text("You can change this later in Settings → Tentacle.")
                .font(.system(size: 10.5))
                .foregroundStyle(Color.textMuted)
        }
        .padding(26)
        .frame(width: 440)
        .interactiveDismissDisabled()
    }

    private var subtitle: String {
        let version = tentacleCLI.externalCLI?.version.map { " (\($0))" } ?? ""
        return "The command-line version of Kraki\(version) already runs your agents in the background. You only need one of them."
    }

    private func option(mode: TentacleMode, title: String, badge: String?, detail: String, identifier: String) -> some View {
        Button {
            guard switching == nil else { return }
            switching = mode
            Task {
                await tentacleCLI.switchMode(to: mode)
                switching = nil
            }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(title)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(Color.textPrimary)
                        if let badge {
                            Text(badge)
                                .font(.system(size: 9.5, weight: .semibold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.krakiPrimary.opacity(0.18), in: Capsule())
                                .foregroundStyle(Color.krakiPrimary)
                        }
                    }
                    Text(detail)
                        .font(.system(size: 11))
                        .foregroundStyle(Color.textSecondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                if switching == mode {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.textMuted)
                        .padding(.top, 2)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.surfaceSecondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(mode == .builtIn ? Color.krakiPrimary.opacity(0.7) : Color.borderPrimary.opacity(0.8), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(switching != nil)
        .accessibilityIdentifier(identifier)
    }
}

/// Presents ExistingCLIChoiceView over the main window while the choice is
/// pending. `enabled` holds it back until the launch gate is gone.
struct ExistingCLIChoicePresenter: ViewModifier {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    let enabled: Bool

    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(
            get: { enabled && tentacleCLI.ownerChoicePending },
            set: { _ in }
        )) {
            ExistingCLIChoiceView()
                .environment(tentacleCLI)
        }
    }
}

#endif
