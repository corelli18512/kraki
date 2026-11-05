import Foundation

// MARK: - Archive (F2) and pinning

extension CommandSender {
    func archiveSession(sessionId: String, archived: Bool) {
        send(["type": "archive_session", "payload": ["archived": archived]], sessionId: sessionId)
    }

    func requestArchivedSessions(targetDeviceId: String) {
        send(["type": "request_archived_sessions", "targetDeviceId": targetDeviceId, "payload": [:] as [String: Any]])
    }

    func setAutoArchiveDays(targetDeviceId: String, days: Int) {
        send(["type": "set_auto_archive_days", "targetDeviceId": targetDeviceId, "payload": ["days": days]])
    }

    /// Archive After applies to every computer on the account, also those
    /// that have been offline since launch (K-082). Each stays pending until
    /// its `session_list` reports the value; an offline one gets it then.
    func setAutoArchiveDaysOnAllComputers(_ days: Int) {
        guard let appState else { return }
        let computers = Set(appState.deviceStore.devices.values.filter { $0.role == .tentacle }.map(\.id))
            .union(appState.sessionStore.archiveInfo.keys)
        for deviceId in computers {
            appState.sessionStore.pendingAutoArchiveDays[deviceId] = days
            if appState.deviceStore.devices[deviceId]?.online == true {
                setAutoArchiveDays(targetDeviceId: deviceId, days: days)
            }
        }
    }

    /// A computer reported its Archive After (`session_list`). One that
    /// missed a change made here gets it now, once.
    func reconcileAutoArchiveDays(deviceId: String, reported days: Int) {
        guard let appState, let wanted = appState.sessionStore.pendingAutoArchiveDays[deviceId] else { return }
        appState.sessionStore.pendingAutoArchiveDays.removeValue(forKey: deviceId)
        if wanted != days { setAutoArchiveDays(targetDeviceId: deviceId, days: wanted) }
    }

    func deleteArchivedSessions(targetDeviceId: String) {
        guard send(["type": "delete_archived_sessions", "targetDeviceId": targetDeviceId, "payload": [:] as [String: Any]]) else {
            appState?.lastError = String(localized: "Couldn't delete archived sessions while offline. Try again when connected.")
            return
        }
        appState?.sessionStore.archivedSessions[targetDeviceId] = []
    }

    /// Restore an archived session and show it right away; the computer's
    /// next session_list confirms it.
    func openArchivedSession(_ digest: SessionDigest, deviceId: String) {
        guard let appState else { return }
        let name = appState.deviceStore.device(for: deviceId)?.name ?? deviceId
        appState.sessionStore.upsertSession(digest, deviceId: deviceId, deviceName: name)
        appState.sessionStore.archivedSessions[deviceId]?.removeAll { $0.id == digest.id }
        archiveSession(sessionId: digest.id, archived: false)
    }

    func pinSession(sessionId: String, pinned: Bool) {
        guard let appState else { return }
        // Optimistic
        appState.sessionStore.setPinned(sessionId, pinned)
        #if os(macOS)
        // Pinning moves the row (to the top, or back down among the others):
        // the sidebar follows it so it stays in view.
        appState.sessionStore.sessionListRevealId = sessionId
        #endif
        send(["type": "pin_session", "payload": ["pinned": pinned]], sessionId: sessionId)
    }
}
