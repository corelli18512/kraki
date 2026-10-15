import SwiftUI

/// The same links on iOS and Mac. A link is not an assertion that the installed app was verified.
struct BuildProvenanceView: View {
    var info: BuildInfo = .current

    var body: some View {
        if let runURL = info.runURL, let sourceURL = info.sourceURL {
            row("GitHub Run ID", value: info.runLabel, url: runURL)
            row("Source commit", value: String((info.commit ?? "").prefix(8)), url: sourceURL)
            if let provenanceURL = info.provenanceURL {
                row("Build provenance", value: "View on GitHub", url: provenanceURL)
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
struct AboutBuildSection: View {
    var version: String
    var relayVersion: String
    var buildInfo: BuildInfo = .current

    var body: some View {
        Section {
            LabeledContent("Kraki for iPhone", value: version)
            LabeledContent("Relay", value: relayVersion)
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
    }
}
#endif
