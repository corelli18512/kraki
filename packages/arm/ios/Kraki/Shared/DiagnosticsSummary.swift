import Foundation

/// One block of text with every component version, for bug reports (H3).
/// Shared by iOS Settings and the Mac About pane.
enum DiagnosticsSummary {
    struct Row: Equatable {
        let label: String
        let value: String
    }

    static func rows(appState: AppState) -> [Row] {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        #if os(iOS)
        let appLabel = "Kraki for iPhone"
        #else
        let appLabel = "Kraki for Mac"
        #endif
        var rows = [Row(label: appLabel, value: "\(short) (\(build))")]
        let computers = appState.deviceStore.devices.values
            .filter { $0.role == .tentacle }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        for device in computers {
            let version = appState.deviceStore.deviceVersions[device.id] ?? "unknown"
            let status = device.online ? "" : " · offline"
            rows.append(Row(label: device.name, value: "Kraki \(version)\(status)"))
        }
        let host = URL(string: appState.relayURL)?.host ?? appState.relayURL
        rows.append(Row(label: "Relay", value: "\(host) · \(appState.relayVersion ?? "—")"))
        return rows
    }

    static func text(appState: AppState) -> String {
        rows(appState: appState).map { "\($0.label): \($0.value)" }.joined(separator: "\n")
    }
}
