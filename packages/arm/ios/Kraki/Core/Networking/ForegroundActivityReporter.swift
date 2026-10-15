import Foundation

/// Minimal account usage signal, independent of optional performance uploads.
/// No history/backlog: only an authenticated, currently foreground app reports.
/// Head chooses the date and deduplicates accounts across devices.
final class ForegroundActivityReporter {
    private let eligible: () -> Bool
    private let platformActive: () -> Bool
    private let send: () -> Void
    private let now: () -> Date
    private var timer: Timer?
    private var lastSent: Date?

    init(eligible: @escaping () -> Bool, platformActive: @escaping () -> Bool,
         send: @escaping () -> Void, now: @escaping () -> Date = Date.init) {
        self.eligible = eligible
        self.platformActive = platformActive
        self.send = send
        self.now = now
    }

    deinit { timer?.invalidate() }

    func refresh() {
        guard eligible(), platformActive() else { stop(); return }
        let time = now()
        if lastSent.map({ time.timeIntervalSince($0) >= 60 || time < $0 }) ?? true {
            send()
            lastSent = time
        }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        lastSent = nil
    }
}
