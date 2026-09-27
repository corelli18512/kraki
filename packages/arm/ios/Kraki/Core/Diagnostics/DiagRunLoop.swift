#if KRAKI_DIAG
import Foundation
import CoreFoundation

/// Records completed busy intervals, not sleeping time or a sampled stack.
/// No timer, injected gestures, display-refresh wakeups, or thread suspension.
@MainActor
final class DiagRunLoop {
    static let shared = DiagRunLoop()
    private var observer: CFRunLoopObserver?
    private var started: TimeInterval?
    private var active = true
    func start() {
        guard observer == nil else { return }
        let activities: CFRunLoopActivity = [.afterWaiting, .beforeWaiting, .exit]
        observer = CFRunLoopObserverCreateWithHandler(nil, activities.rawValue, true, 0) { [weak self] _, activity in
            guard let self else { return }
            guard self.active, KrakiDiag.recorder.isEnabled else { self.started = nil; return }
            let now = ProcessInfo.processInfo.systemUptime
            if activity == .afterWaiting { self.started = now }
            else if let start = self.started {
                self.started = nil
                let duration = (now - start) * 1000
                if duration >= 50 { KrakiDiag.record(.busy, [.durationMs: .number(duration)]) }
            }
        }
        if let observer { CFRunLoopAddObserver(CFRunLoopGetMain(), observer, .commonModes) }
    }
    func setActive(_ value: Bool) { active = value; started = nil }
}
#endif
