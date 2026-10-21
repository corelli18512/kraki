import SwiftUI

/// The same links on iOS and Mac. A link is not an assertion that the installed app was verified.
struct BuildProvenanceView: View {
    var info: BuildInfo = .current

    var body: some View {
        if let runURL = info.runURL, let sourceURL = info.sourceURL {
            row(String(localized: "GitHub Run ID"), value: info.runLabel, url: runURL)
            row(String(localized: "Source commit"), value: String((info.commit ?? "").prefix(8)), url: sourceURL)
            if let provenanceURL = info.provenanceURL {
                row(String(localized: "Build provenance"), value: String(localized: "View on GitHub"), url: provenanceURL)
            }
        } else {
            HStack {
                Text("Build")
                Spacer()
                Text("Local build").foregroundStyle(.secondary)
            }
        }
    }

    private func row(_ title: String, value: String, url: URL) -> some View {
        Link(destination: url) {
            HStack(spacing: 8) {
                Text(title).foregroundStyle(.primary)
                Spacer(minLength: 12)
                Text(value)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(value), opens GitHub")
    }
}

#if os(iOS)
/// Two groups: this app (its version and the build it came from), then the
/// relay it is connected to — a separate component with its own version.
struct AboutBuildSection: View {
    var version: String
    var relayVersion: String
    var buildInfo: BuildInfo = .current

    var body: some View {
        Section {
            LabeledContent("Kraki for iPhone", value: version)
            BuildProvenanceView(info: buildInfo)
        } header: {
            HStack(spacing: 8) {
                Image("KrakiLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 28, height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text("About Kraki")
            }
        } footer: {
            if buildInfo.hasBuildRecord {
                Text("Build records identify the source and IPA submitted to Apple. Apple processes the app for distribution.")
            }
        }
        Section("Relay") {
            LabeledContent("Version", value: relayVersion)
        }
    }
}
#endif
