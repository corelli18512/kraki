import Foundation

extension SessionStore {
    /// Sessions matching an optional computer filter and a search query.
    /// Search covers title, computer, model and the authoritative Preview,
    /// case- and diacritic-insensitively. Shared by the iOS list and Mac sidebar.
    func filteredSessions(_ ordered: [SessionInfo], deviceId: String?, matching query: String) -> [SessionInfo] {
        let onDevice = deviceId.map { id in ordered.filter { $0.deviceId == id } } ?? ordered
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return onDevice }
        return onDevice.filter { session in
            [session.displayTitle, session.deviceName, session.model ?? "", sessionPreviews[session.id]?.text ?? ""]
                .contains { $0.localizedStandardContains(query) }
        }
    }
}
