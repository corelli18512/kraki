import Foundation

/// Leaving the app used to close the relay socket at once, so coming back
/// always paid a full reconnect + re-auth + session_list (about 1.1 s p50).
/// Diag 10-12→10-21: 34% of iPhone returns came back within 30 s, 46% within
/// a minute.
///
/// Instead keep the authenticated socket for a short grace period (an iOS
/// background task) and tell the Head the app is hidden, so notifications
/// still go out through push exactly as if the socket were closed. Back
/// within the grace period: nothing to reconnect. Otherwise the socket is
/// closed as before.
///
/// Platform-free so it is testable; AppState supplies the hooks. Main thread
/// only (scene-phase callbacks).
final class BackgroundSocketGrace {
    struct Hooks {
        /// The relay socket is authenticated and the Head understands
        /// `app_visibility` (older Heads would stop pushing to us).
        var canKeep: () -> Bool
        /// Tell the Head whether the app is on screen.
        var setVisible: (Bool) -> Void
        /// The normal background teardown (close voice + relay sockets).
        var teardown: () -> Void
        /// Ask the OS for background time; returns a token for `endTask`.
        var beginTask: (_ expired: @escaping () -> Void) -> Int?
        var endTask: (Int) -> Void
    }

    /// iOS grants a background task about 30 s; leave room for the close.
    static let grace: Duration = .seconds(25)

    private let hooks: Hooks
    private var timer: Task<Void, Never>?
    private var token: Int?
    /// Bumped on every begin/resume/expiry: a timer or OS expiration handler
    /// from an earlier background visit must not end a newer one.
    private var visit = 0
    private(set) var isActive = false

    init(hooks: Hooks) { self.hooks = hooks }

    /// Called instead of the immediate teardown. Returns false (caller tears
    /// down now) when the socket cannot be kept.
    func begin(grace: Duration = grace) -> Bool {
        // A second background notification while one grace runs: keep it.
        if isActive { return true }
        cancelTimer()
        guard hooks.canKeep() else { return false }
        visit += 1
        let thisVisit = visit
        guard let token = hooks.beginTask({ [weak self] in
            // UIKit calls this on the main thread right before suspending:
            // close now, a hop to the next runloop turn might never run.
            if Thread.isMainThread { self?.expire(visit: thisVisit) } else {
                DispatchQueue.main.async { self?.expire(visit: thisVisit) }
            }
        }) else { return false }
        self.token = token
        isActive = true
        hooks.setVisible(false)
        timer = Task { @MainActor [weak self] in
            try? await Task.sleep(for: grace)
            guard !Task.isCancelled else { return }
            self?.expire(visit: thisVisit)
        }
        return true
    }

    /// Back on screen within the grace period. Returns whether the socket
    /// was kept (the caller then has nothing to reconnect).
    @discardableResult
    func resume() -> Bool {
        guard isActive else { return false }
        cancelTimer()
        isActive = false
        visit += 1
        hooks.setVisible(true)
        endTask()
        return true
    }

    /// The kept socket dropped: reconnecting from the background is
    /// pointless, close everything as a plain background would.
    func abandon() { expire(visit: visit) }

    /// Grace period over (or the OS took our background time back).
    private func expire(visit expiring: Int) {
        guard isActive, expiring == visit else { return }
        cancelTimer()
        isActive = false
        visit += 1
        hooks.teardown()
        endTask()
    }

    private func cancelTimer() { timer?.cancel(); timer = nil }

    private func endTask() {
        if let token { hooks.endTask(token) }
        token = nil
    }
}
