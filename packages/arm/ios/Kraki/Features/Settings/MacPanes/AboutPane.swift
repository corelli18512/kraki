/// AboutPane — Version + links.

#if os(macOS)
import SwiftUI

struct AboutPane: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    }
    private var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
    }
    private var tentacleVersion: String {
        if case let .available(_, v) = tentacleCLI.installState, let v {
            return v
        }
        return "—"
    }

    var body: some View {
        VStack(spacing: 14) {
            Spacer().frame(height: 20)

            Image("KrakiLogo")
                .resizable()
                .interpolation(.high)
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                .shadow(color: Color.black.opacity(0.18), radius: 18, y: 8)

            VStack(spacing: 4) {
                Text("KRAKI")
                    .font(.system(size: 18, weight: .heavy, design: .monospaced))
                    .tracking(3.5)
                    .foregroundStyle(Color.textTitle)
                Text("Multi-device · Multi-agent · Coding")
                    .font(.system(size: 10, weight: .medium))
                    .tracking(0.3)
                    .foregroundStyle(Color.textMuted)
                    .textCase(.uppercase)
            }

            VStack(spacing: 3) {
                versionRow("Mac App",  value: "\(version) (\(build))")
                versionRow("Tentacle", value: tentacleVersion)
                versionRow("Relay",    value: "kraki.chat")
            }
            .padding(.top, 6)

            Divider().frame(width: 220).padding(.vertical, 6)

            HStack(spacing: 16) {
                Link("Website",       destination: URL(string: "https://kraki.chat")!)
                Link("Documentation", destination: URL(string: "https://kraki.chat/docs")!)
                Link("GitHub",        destination: URL(string: "https://github.com/kraki/kraki")!)
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Color.krakiPrimary)

            Spacer()

            Text("© 2026 Kraki")
                .font(.system(size: 10))
                .foregroundStyle(Color.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(24)
        .background(Color.surfacePrimary)
    }

    private func versionRow(_ label: String, value: String) -> some View {
        HStack(spacing: 6) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .heavy, design: .monospaced))
                .tracking(0.5)
                .foregroundStyle(Color.textMuted)
                .frame(width: 70, alignment: .trailing)
            Text(value)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.textSecondary)
                .textSelection(.enabled)
        }
    }
}

#endif
