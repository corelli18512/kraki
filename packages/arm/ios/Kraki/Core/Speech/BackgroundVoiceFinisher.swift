import Foundation

/// Going to the background while a sent voice message is still being
/// corrected used to mark it "not sent" at once (the voice and relay sockets
/// were closed in the same call), and nothing re-sends such a message
/// automatically: diag 2026-09-28 shows two of them delivered only when the
/// user tapped Retry 4 and 16 minutes later.
///
/// Instead, keep both connections for a short grace period (an iOS
/// background task) so the correction can finish and the message goes out
/// exactly as in the foreground. Only if it does not finish in time does the
/// old behaviour apply (kept as not sent, original transcript, Retry). An
/// unconfirmed correction is still never sent automatically.
///
/// Platform-free so it is testable; AppState supplies the hooks. Main thread
/// only (scene-phase callbacks); the hooks are called on the main actor.
final class BackgroundVoiceFinisher {
    struct Hooks {
        /// A staged voice message is still waiting for its correction.
        var isFinishing: () -> Bool
        /// The finished message has been confirmed by the Tentacle (or needs
        /// no further network: nothing pending for it).
        var isDelivered: () -> Bool
        /// Grace period over: keep what was heard as not sent.
        var retire: () -> Void
        /// The background teardown that was deferred (voice + relay sockets).
        var teardown: () -> Void
        /// Ask the OS for background time; returns a token for `endTask`.
        var beginTask: (_ expired: @escaping () -> Void) -> Int?
        var endTask: (Int) -> Void
    }

    static let finishBudget: Duration = .seconds(8)
    static let deliveryBudget: Duration = .milliseconds(1_500)
    static let poll: Duration = .milliseconds(100)

    private let hooks: Hooks
    private var task: Task<Void, Never>?
    private var token: Int?
    private(set) var isActive = false

    init(hooks: Hooks) { self.hooks = hooks }

    /// Called instead of the immediate teardown when the app goes to the
    /// background. Returns false (caller tears down now) if nothing is finishing.
    func beginIfNeeded(finishBudget: Duration = finishBudget,
                       deliveryBudget: Duration = deliveryBudget) -> Bool {
        guard hooks.isFinishing() else { return false }
        cancel()
        isActive = true
        token = hooks.beginTask { [weak self] in
            DispatchQueue.main.async { self?.finish(retire: true) }
        }
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            let clock = ContinuousClock()
            let finishDeadline = clock.now + finishBudget
            while self.hooks.isFinishing(), clock.now < finishDeadline {
                try? await Task.sleep(for: Self.poll)
                if Task.isCancelled { return }
            }
            if self.hooks.isFinishing() { self.finish(retire: true); return }
            // Corrected and handed to transport: give the frame a moment to
            // leave and be confirmed before the socket is closed.
            let deliveryDeadline = clock.now + deliveryBudget
            while !self.hooks.isDelivered(), clock.now < deliveryDeadline {
                try? await Task.sleep(for: Self.poll)
                if Task.isCancelled { return }
            }
            self.finish(retire: false)
        }
        return true
    }

    /// Back in the foreground before the grace period ended: nothing was torn
    /// down, so there is nothing to undo.
    func cancel() {
        task?.cancel(); task = nil
        if let token { hooks.endTask(token) }
        token = nil
        isActive = false
    }

    private func finish(retire: Bool) {
        guard isActive else { return }
        if retire { hooks.retire() }
        hooks.teardown()
        task?.cancel(); task = nil
        if let token { hooks.endTask(token) }
        token = nil
        isActive = false
    }
}
