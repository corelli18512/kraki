import Foundation

extension CommandSender {
    /// App-side connection-scoped: not retained for app reconnect replay. A
    /// request already accepted by Head may still be forwarded after reconnect;
    /// the worker coalesces reads and owns the provider cooldown/Retry-After.
    @discardableResult
    func refreshAccountUsage(deviceIds: Set<String>? = nil, automatic: Bool = false,
                             now: Date = Date()) -> Int {
        guard let appState, appState.connectionStatus == .connected else { return 0 }
        let store = appState.deviceStore
        var sent = 0
        for id in store.usageRefreshTargets(deviceIds: deviceIds) where store.canRefreshUsage(id, automatic: automatic, now: now) {
            let requestId = UUID().uuidString
            store.beginUsageRefresh(id, requestId: requestId, now: now)
            guard send(["type": "refresh_account_usage", "targetDeviceId": id,
                        "payload": ["requestId": requestId]], connectionScoped: true) else {
                store.finishUsageRefresh(id, requestId: requestId, error: "connection")
                continue
            }
            sent += 1
            let timeout = usageRefreshTimeout
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: timeout)
                self?.appState?.deviceStore.finishUsageRefresh(id, requestId: requestId, error: "timeout")
            }
        }
        return sent
    }

    /// Ask a computer to update Kraki (remote update). `when`: nil asks first
    /// if sessions are running; "now" stops them; "idle" waits for them.
    @discardableResult
    func updateDevice(_ deviceId: String, when: String? = nil) -> Bool {
        guard let appState else { return false }
        let store = appState.deviceStore
        let requestId = UUID().uuidString
        var payload: [String: Any] = ["requestId": requestId]
        if let when { payload["when"] = when }
        let info = store.deviceUpdates[deviceId]
        store.setUpdateProgress(deviceId, DeviceUpdateProgress(phase: .requested, requestId: requestId, from: info?.current, to: info?.latest))
        guard send(["type": "update_device", "targetDeviceId": deviceId, "payload": payload], connectionScoped: true) else {
            store.setUpdateProgress(deviceId, DeviceUpdateProgress(phase: .failed, requestId: requestId, error: String(localized: "Not connected.")))
            return false
        }
        return true
    }
}
