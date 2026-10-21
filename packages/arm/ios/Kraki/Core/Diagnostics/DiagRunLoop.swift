#if KRAKI_DIAG
import Foundation
import CoreFoundation

/// Records completed busy intervals, not sleeping time or a sampled stack.
/// No timer, injected gestures, display-refresh wakeups, or thread suspension.
@MainActor
final class DiagRunLoop {
    /// `inactive`: on screen but not frontmost (Mac) — hangs there are real
    /// and recorded, tagged. `off`: background / asleep.
    enum Phase { case active, inactive, off }
    static let shared = DiagRunLoop()
    private var observer: CFRunLoopObserver?
    private var started: TimeInterval?
    private var phase = Phase.active
    func start() {
        guard observer == nil else { return }
        let activities: CFRunLoopActivity = [.afterWaiting, .beforeWaiting, .exit]
        observer = CFRunLoopObserverCreateWithHandler(nil, activities.rawValue, true, 0) { [weak self] _, activity in
            guard let self else { return }
            guard self.phase != .off, KrakiDiag.recorder.isEnabled else { self.started = nil; return }
            let now = ProcessInfo.processInfo.systemUptime
            if activity == .afterWaiting { self.started = now }
            else if let start = self.started {
                self.started = nil
                let duration = (now - start) * 1000
                if duration >= 50 { KrakiDiag.record(.busy, Self.busyFields(duration, phase: self.phase)) }
            }
        }
        if let observer { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }
    func setPhase(_ value: Phase) { phase = value; started = nil }
    nonisolated static func busyFields(_ duration: Double, phase: Phase) -> [DiagField: DiagValue] {
        var fields: [DiagField: DiagValue] = [.durationMs: .number(duration)]
        if phase == .inactive { fields[.phase] = .tag("inactive") }
        return fields
    }
}
#endif
