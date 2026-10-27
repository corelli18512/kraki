#if os(iOS) && DEBUG
import Foundation
import QuartzCore
import UIKit

/// Offline reproduction of "a new message arrives in another Session while the
/// Session list is on screen": every tick, a Session further down the list gets
/// a new agent reply and the scripted Tentacle pushes a full `session_list`
/// digest through `MessageRouter.handleDataMessage` — the same path a real
/// Tentacle's digest takes — so the row moves to the top.
///
/// Enabled with `KRAKI_IOS_NEW_SESSION_SCENARIO=1` plus
/// `KRAKI_SCENARIO_LIST_TICKER_MS=<interval>`. Used to look at swipe actions
/// and row animation while the list reorders.
@MainActor
enum IOSSessionListReorderScenario {
    private struct Row {
        let id: String
        let title: String
        let createdAt: Date
        var lastSeq: Int
        var readSeq: Int
        var preview: String
        var previewAt: Date
    }

    private static var rows: [Row] = []
    private static var tick = 0
    private static var timer: Timer?

    static func install(on app: AppState) {
        guard let raw = ProcessInfo.processInfo.environment["KRAKI_SCENARIO_LIST_TICKER_MS"],
              let intervalMs = Int(raw), intervalMs > 0 else { return }
        let device = IOSNewSessionScenario.deviceID
        // The base scenario adds existing-0…5; add more so the list fills the
        // screen and a moving row travels a real distance.
        var extraTitles = ["Fix flaky reconnect test", "Write the release notes", "Audit push notifications",
                           "Session card swipe actions", "Profile list scrolling", "Clean up old worktrees"]
        // KRAKI_SCENARIO_LIST_EXTRA=<n>: a longer, more realistic list.
        let extra = Int(ProcessInfo.processInfo.environment["KRAKI_SCENARIO_LIST_EXTRA"] ?? "") ?? extraTitles.count
        while extraTitles.count < extra { extraTitles.append("Background task \(extraTitles.count + 1)") }
        for (index, title) in extraTitles.prefix(extra).enumerated() {
            let id = "extra-\(index)"
            app.sessionStore.upsertSession(SessionInfo(
                id: id, deviceId: device, deviceName: "Scenario Mac", agent: "pi", model: "m",
                title: title, state: .idle, mode: .auto, lastSeq: 4, readSeq: 4, messageCount: 4,
                createdAt: Date().addingTimeInterval(Double(-3_600 * (index + 7))), pinned: false))
        }
        let now = Date()
        rows = app.sessionStore.sessions.values
            .filter { $0.deviceId == device }
            .map { session in
                Row(id: session.id, title: session.displayTitle, createdAt: session.createdAt,
                    lastSeq: session.lastSeq, readSeq: session.readSeq,
                    preview: "Earlier reply in \(session.displayTitle)",
                    previewAt: session.createdAt < now ? session.createdAt : now)
            }
        push(app)
        FrameMonitor.shared.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            timer = Timer.scheduledTimer(withTimeInterval: Double(intervalMs) / 1_000, repeats: true) { _ in
                MainActor.assumeIsolated { step(app) }
            }
        }
    }

    /// Bump a Session that is not already first: alternate between one near
    /// the bottom and one in the middle of the visible list.
    private static func step(_ app: AppState) {
        let order = rows.sorted { $0.previewAt > $1.previewAt }
        guard order.count > 3 else { return }
        tick += 1
        let pick = tick.isMultiple(of: 2) ? order[order.count / 2] : order[min(order.count - 1, 7)]
        guard let index = rows.firstIndex(where: { $0.id == pick.id }) else { return }
        rows[index].lastSeq += 2
        rows[index].preview = "New reply #\(tick): finished the step and waiting for you"
        rows[index].previewAt = Date()
        let started = CACurrentMediaTime()
        FrameMonitor.shared.markTick(tick)
        push(app)
        let routerMs = (CACurrentMediaTime() - started) * 1_000
        IOSNewSessionScenario.log("list-ticker tick=\(tick) bump=\(pick.id) rows=\(rows.count) routerMs=\(String(format: "%.1f", routerMs))")
    }

    /// Logs every display frame that took longer than 25 ms (a dropped frame
    /// at 60 Hz), with its offset from the latest tick.
    @MainActor final class FrameMonitor: NSObject {
        static let shared = FrameMonitor()
        private var link: CADisplayLink?
        private var last: CFTimeInterval = 0
        private var tickAt: CFTimeInterval = 0
        private var tick = 0

        func start() {
            guard link == nil else { return }
            let link = CADisplayLink(target: self, selector: #selector(frame(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        func markTick(_ tick: Int) { self.tick = tick; tickAt = CACurrentMediaTime() }

        @objc private func frame(_ link: CADisplayLink) {
            defer { last = link.timestamp }
            guard last > 0, tickAt > 0 else { return }
            let gap = (link.timestamp - last) * 1_000
            let sinceTick = (link.timestamp - tickAt) * 1_000
            if gap > 25, sinceTick < 1_500 {
                IOSNewSessionScenario.log("hitch tick=\(tick) gapMs=\(String(format: "%.0f", gap)) atMs=\(String(format: "%.0f", sinceTick))")
            }
        }
    }

    private static func push(_ app: AppState) {
        let sessions: [[String: Any]] = rows.map { row in
            [
                "id": row.id, "agent": "pi", "model": "m", "title": row.title,
                "state": "idle", "mode": "auto",
                "lastSeq": row.lastSeq, "readSeq": row.readSeq, "messageCount": row.lastSeq,
                "createdAt": ISO8601.withFractional.string(from: row.createdAt), "pinned": false,
                "preview": ["text": row.preview, "type": "agent", "timestamp": ISO8601.withFractional.string(from: row.previewAt)],
            ]
        }
        let message: [String: Any] = [
            "type": "session_list", "deviceId": IOSNewSessionScenario.deviceID,
            "timestamp": ISO8601.now(), "seq": 0, "payload": ["sessions": sessions],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        app.messageRouter?.handleDataMessage(data)
    }
}
#endif

