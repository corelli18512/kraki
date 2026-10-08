import Foundation

/// Account deletion (App Store 5.1.1(v)): the app asks the relay to delete
/// the account; the relay deletes everything it keeps, then sends
/// `account_deleted` to every device (or `auth_error` code `account_deleted`
/// to one that was offline). This device then signs out for good.
enum AccountDeletionState: Equatable {
    case idle
    case deleting
    case failed(String)
}

extension AppState {
    /// Ask the relay to delete the account. The answer is `account_deleted`
    /// (→ `accountWasDeleted()`) or a `server_error` (→ `.failed`).
    func requestAccountDeletion() {
        guard connectionStatus == .connected else {
            accountDeletion = .failed("Connect to Kraki first. The account is deleted on the server.")
            return
        }
        guard sendRelayControl(["type": "delete_account"]) else {
            accountDeletion = .failed("Couldn't reach Kraki. Try again.")
            return
        }
        accountDeletion = .deleting
        let attempt = UUID()
        accountDeletionAttempt = attempt
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard let self, self.accountDeletionAttempt == attempt, self.accountDeletion == .deleting else { return }
            self.accountDeletion = .failed("Kraki didn't answer. Check the connection and try again.")
        }
    }

    /// A `server_error` while a deletion is pending is its answer.
    func accountDeletionFailedIfPending(_ message: String) -> Bool {
        guard accountDeletion == .deleting else { return false }
        accountDeletion = .failed(message)
        return true
    }

    /// The relay deleted this account (asked from here or from another
    /// device). Sign out and forget everything, including — on the Mac — the
    /// local Kraki's sign-in, so nothing signs back in on its own.
    func accountWasDeleted() {
        guard !accountDeletedHandled else { return }
        accountDeletedHandled = true
        KLog.diag("Account deleted — signing out")
        #if os(macOS)
        Self.forgetLocalKrakiSignIn()
        onAccountDeleted?()
        #endif
        logout()
        #if os(macOS)
        // Nothing left to reuse: setup starts from the beginning.
        signedOutByUser = false
        #endif
        accountDeletion = .idle
        accountDeletionAttempt = nil
        accountDeletedNotice = true
        accountDeletedHandled = false
    }

    /// Plaintext control for the relay itself (not end-to-end encrypted to
    /// the user's computers), sent on the raw socket.
    @discardableResult
    func sendRelayControl(_ message: [String: Any]) -> Bool {
        guard let wsClient,
              let data = try? JSONSerialization.data(withJSONObject: message),
              let string = String(data: data, encoding: .utf8) else { return false }
        wsClient.sendRaw(string)
        return true
    }

    #if os(macOS)
    /// The files the local `kraki` keeps for its sign-in and identity
    /// (mirrors packages/tentacle/src/account-deleted.ts). Sessions stay.
    static func forgetLocalKrakiSignIn(home: URL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".kraki")) {
        let fm = FileManager.default
        for name in ["config.json", "channel.key", "github-token", "device-id", "keys"] {
            try? fm.removeItem(at: home.appendingPathComponent(name))
        }
    }
    #endif
}
