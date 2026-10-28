import Foundation

extension SessionStore {
    /// Sessions matching an optional computer filter and a search query.
    /// Text search covers title, computer, model and the authoritative Preview,
    /// case- and diacritic-insensitively. A Session ID matches by prefix only:
    /// IDs are hex, so substring matching would make ordinary words ("add",
    /// "cafe") hit unrelated Sessions. Shared by the iOS list and Mac sidebar.
    func filteredSessions(_ ordered: [SessionInfo], deviceId: String?, matching query: String) -> [SessionInfo] {
        let onDevice = deviceId.map { id in ordered.filter { $0.deviceId == id } } ?? ordered
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return onDevice }
        let idPrefix = query.lowercased()
        return onDevice.filter { session in
            session.id.lowercased().hasPrefix(idPrefix)
                || [session.displayTitle, session.deviceName, session.model ?? "", sessionPreviews[session.id]?.text ?? ""]
                    .contains { $0.localizedStandardContains(query) }
        }
    }
}

extension SessionStore {
    /// The unread definition behind `unreadSessionIDs`: readSeq < lastSeq.
    static func unreadIDs(in sessions: [String: SessionInfo]) -> Set<String> {
        Set(sessions.values.compactMap { session in
            session.readSeq < session.lastSeq ? session.id : nil
        })
    }
}
