import Foundation
import Network

/// Stability summaries (docs/stability-metrics.md). One record per app opening
/// (`ready.summary`: how long until the user sees what they came for) and one
/// per foreground connection outage (`outage.summary`: why it dropped and how
/// long the user was affected).
///
/// Metadata only: durations, counts and cause tags; never message content.
/// Always compiled (so it is unit tested); diagnostics builds forward the
/// summaries to KrakiDiag, other builds drop them. Main thread only (like
/// AppState, which owns it).
final class StabilityTracker {
    struct Ready: Equatable {
        enum Kind: String { case cold, warm, wake }
        enum Outcome: String { case ready, abandoned, timeout }
        var kind: Kind
        /// Time spent hidden (warm) or asleep (wake) before this opening.
        var backgroundMs: Double?
        /// Milestones, milliseconds after the app became visible.
        var firstContentMs: Double?
        var wsOpenMs: Double?
        var authedMs: Double?
        var listFreshMs: Double?
        /// The conversation on screen (or the session list) is up to date.
        var viewCurrentMs: Double?
        /// Failed connection attempts before authentication.
        var attempts = 0
        /// Messages the viewed conversation was behind when the list arrived.
        var gap = 0
        /// A conversation (rather than the session list) was on screen.
        var viewing = false
        var path: String
        var outcome: Outcome = .ready
        /// Cold only: how the previous process ended ("clean", "unclean", "first").
        var previousExit: String?
    }

    /// Tapping a conversation while online: how long until its latest
    /// messages are on screen.
    struct Open: Equatable {
        enum Outcome: String { case current, left, timeout }
        var firstContentMs: Double?
        var currentMs: Double?
        /// Messages missing locally when it was opened.
        var gap = 0
        var outcome: Outcome = .current
    }

    struct Outage: Equatable {
        enum Outcome: String { case recovered, backgrounded, abandoned }
        /// How the transport noticed (WebSocketClient recover reason).
        var reason: String
        /// Close code (peer_closed) or NSError code (transport errors).
        var code: Int?
        /// Last inbound data → drop noticed (long for half-open links).
        var detectMs: Double
        /// Drop noticed → authenticated again.
        var reconnectMs: Double?
        /// Authenticated → the view is up to date again.
        var catchupMs: Double?
        /// Last inbound data → up to date: what the user actually lost.
        var impactMs: Double?
        /// Time "Reconnecting…" was actually on screen.
        var visibleMs: Double = 0
        var attempts = 0
        var path: String
        /// The network path changed within 10 s before the drop.
        var pathChanged = false
        /// The system woke within 60 s before the drop.
        var afterWake = false
        var outcome: Outcome = .recovered
    }

    static let readyTimeout: TimeInterval = 30
    static let outageGiveUp: TimeInterval = 600

    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var onReady: ((Ready) -> Void)?
    var onOutage: ((Outage) -> Void)?
    var onOpen: ((Open) -> Void)?
    /// Supplies `previousExit` for the cold record.
    var previousExit: (() -> String)?
    /// Test hook: delayed timeout checks are scheduled through this.
    var schedule: (TimeInterval, @escaping () -> Void) -> Void = { delay, work in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
    #if DEBUG
    private(set) var readies: [Ready] = []
    private(set) var outages: [Outage] = []
    private(set) var opens: [Open] = []
    #endif
    private var opening: (sessionId: String, since: TimeInterval, target: Int, value: Open)?

    private(set) var path = "unknown"
    private var everVisible = false
    private var hiddenAt: TimeInterval?
    private var asleepAt: TimeInterval?
    private var everAuthenticated = false
    private var lastPathChange: TimeInterval?
    private var lastWake: TimeInterval?
    private var readySince: TimeInterval?
    private var ready: Ready?
    private var outageLast: TimeInterval = 0
    private var outageDetected: TimeInterval = 0
    private var outageReauthed: TimeInterval?
    private var outage: Outage?
    private var reconnectingShownAt: TimeInterval?
    /// After (re)authentication: waiting for the session list, then for the
    /// viewed conversation to reach `targetSeq`.
    private var awaitingList = false
    private var target: (sessionId: String, seq: Int)?
    private var generation = 0

    // MARK: - Lifecycle

    /// The app is on screen. Starts a `cold` (first time in this process) or
    /// `warm` (back from the background) opening; no-op while visible.
    func appVisible(hasCachedContent: Bool, viewing: Bool) {
        if let asleep = asleepAt {
            asleepAt = nil
            lastWake = now()
            begin(.wake, since: asleep, hasCachedContent: true, viewing: viewing)
            return
        }
        if !everVisible {
            everVisible = true
            begin(.cold, since: nil, hasCachedContent: hasCachedContent, viewing: viewing)
        } else if let hidden = hiddenAt {
            hiddenAt = nil
            begin(.warm, since: hidden, hasCachedContent: true, viewing: viewing)
        }
    }

    /// The app left the screen (iOS background). Unfinished records end.
    func appHidden() {
        guard hiddenAt == nil else { return }
        hiddenAt = now()
        finishOpen(.left)
        finishReady(.abandoned)
        finishOutage(.backgrounded)
    }

    /// macOS is going to sleep; the next visibility is a `wake` opening.
    func systemWillSleep() {
        asleepAt = now()
        finishOpen(.left)
        finishReady(.abandoned)
        finishOutage(.backgrounded)
    }

    func pathChanged(to newPath: String) {
        guard newPath != path else { return }
        if path != "unknown" { lastPathChange = now() }
        path = newPath
    }

    // MARK: - Connection

    /// A connection attempt started. During an opening the first attempt is
    /// expected; every further one is a failed attempt.
    func connecting() {
        if ready != nil {
            readyConnects += 1
            ready?.attempts = max(0, readyConnects - 1)
        }
        if outage != nil, outageReauthed == nil { outage?.attempts += 1 }
    }
    private var readyConnects = 0

    func socketOpen() {
        if let since = readySince, ready?.wsOpenMs == nil { ready?.wsOpenMs = ms(since) }
    }

    /// The transport gave up on its connection (WebSocketClient.recover).
    /// `quietFor` is the time since the last inbound frame.
    func transportLost(reason: String, code: Int?, quietFor: TimeInterval?) {
        guard hiddenAt == nil, asleepAt == nil, everAuthenticated, ready == nil else { return }
        if outage != nil {
            if outageReauthed != nil {
                // Dropped again before catching up: the same outage continues.
                outageReauthed = nil
                awaitingList = false
                target = nil
            }
            return
        }
        finishOpen(.left) // the outage record covers the wait from here
        let t = now()
        var last = t - max(0, quietFor ?? 0)
        if let wake = lastWake { last = max(last, wake) } // never count sleep
        outageLast = last
        outageDetected = t
        outageReauthed = nil
        outage = Outage(
            reason: reason, code: code, detectMs: (t - last) * 1000, path: path,
            pathChanged: lastPathChange.map { t - $0 <= 10 } ?? false,
            afterWake: lastWake.map { t - $0 <= 60 } ?? false
        )
        if reconnectingShownAt != nil { reconnectingShownAt = t }
        generation += 1
        let token = generation
        schedule(Self.outageGiveUp) { [weak self] in
            guard let self, self.generation == token else { return }
            self.finishOutage(.abandoned)
        }
    }

    func authenticated() {
        everAuthenticated = true
        if let since = readySince, ready != nil {
            if ready?.authedMs == nil { ready?.authedMs = ms(since) }
            awaitingList = true
        } else if outage != nil {
            outageReauthed = now()
            outage?.reconnectMs = (now() - outageDetected) * 1000
            awaitingList = true
        }
    }

    /// The session list from the Tentacle was applied. `viewed` is the open
    /// conversation (nil: the list itself is what the user sees) with its
    /// authoritative last seq and what is stored locally.
    func sessionListApplied(viewed: (sessionId: String, lastSeq: Int, localSeq: Int)?) {
        guard awaitingList else { return }
        awaitingList = false
        if let since = readySince, ready != nil, ready?.listFreshMs == nil {
            ready?.listFreshMs = ms(since)
            if ready?.firstContentMs == nil { ready?.firstContentMs = ms(since) }
        }
        guard let viewed, viewed.localSeq < viewed.lastSeq else { return reachedCurrent() }
        if ready != nil { ready?.gap = viewed.lastSeq - viewed.localSeq }
        target = (viewed.sessionId, viewed.lastSeq)
    }

    /// Only an opening in progress or a pending catch-up needs view updates;
    /// otherwise callers skip the (database) lookups entirely.
    var wantsConversationUpdates: Bool { ready != nil || target != nil || opening != nil }

    /// The user opened a conversation. Recorded only while online and not
    /// inside an opening/outage record (those already cover the wait).
    func conversationOpened(sessionId: String, lastSeq: Int, localSeq: Int, online: Bool) {
        finishOpen(.left)
        guard online, ready == nil, outage == nil, hiddenAt == nil, asleepAt == nil else { return }
        let t = now()
        opening = (sessionId, t, lastSeq, Open(gap: max(0, lastSeq - localSeq)))
        generation += 1
        let token = generation
        schedule(Self.readyTimeout) { [weak self] in
            guard let self, self.generation == token else { return }
            self.finishOpen(.timeout)
        }
    }

    /// The conversation view refreshed. Also the moment cached content first
    /// appears on a cold start.
    func conversationRendered(sessionId: String, localSeq: Int, lastSeq: Int, hasContent: Bool) {
        if hasContent, let since = readySince, ready != nil, ready?.firstContentMs == nil {
            ready?.firstContentMs = ms(since)
        }
        if var open = opening, open.sessionId == sessionId {
            if hasContent, open.value.firstContentMs == nil { open.value.firstContentMs = ms(open.since) }
            opening = open
            if localSeq >= max(open.target, lastSeq) {
                opening?.value.currentMs = ms(open.since)
                finishOpen(.current)
            }
        }
        guard var target else { return }
        if target.sessionId != sessionId {
            // The user opened another conversation meanwhile: it is now what
            // they are waiting for.
            target = (sessionId, lastSeq)
            self.target = target
        }
        if localSeq >= target.seq { reachedCurrent() }
    }

    /// Whether "Reconnecting…" is on screen (after its debounce).
    func reconnectingShown(_ shown: Bool) {
        if shown, reconnectingShownAt == nil {
            reconnectingShownAt = now()
        } else if !shown, let since = reconnectingShownAt {
            reconnectingShownAt = nil
            if outage != nil { outage?.visibleMs += ms(since) }
        }
    }

    // MARK: - Private

    private func begin(_ kind: Ready.Kind, since: TimeInterval?, hasCachedContent: Bool, viewing: Bool) {
        finishOpen(.left)
        finishReady(.abandoned)
        finishOutage(.backgrounded)
        let t = now()
        readySince = t
        readyConnects = 0
        target = nil
        awaitingList = false
        ready = Ready(
            kind: kind,
            backgroundMs: since.map { (t - $0) * 1000 },
            firstContentMs: hasCachedContent ? 0 : nil,
            viewing: viewing,
            path: path,
            previousExit: kind == .cold ? previousExit?() : nil
        )
        generation += 1
        let token = generation
        schedule(Self.readyTimeout) { [weak self] in
            guard let self, self.generation == token else { return }
            self.finishReady(.timeout)
        }
    }

    private func reachedCurrent() {
        target = nil
        if let since = readySince, ready != nil {
            ready?.viewCurrentMs = ms(since)
            finishReady(.ready)
        } else if outage != nil, let reauthed = outageReauthed {
            outage?.catchupMs = (now() - reauthed) * 1000
            outage?.impactMs = (now() - outageLast) * 1000
            finishOutage(.recovered)
        }
    }

    private func finishReady(_ outcome: Ready.Outcome) {
        guard var value = ready else { return }
        ready = nil
        readySince = nil
        target = nil
        awaitingList = false
        value.outcome = outcome
        #if DEBUG
        readies.append(value)
        #endif
        onReady?(value)
    }

    private func finishOpen(_ outcome: Open.Outcome) {
        guard var value = opening?.value else { return }
        opening = nil
        value.outcome = outcome
        #if DEBUG
        opens.append(value)
        #endif
        onOpen?(value)
    }

    private func finishOutage(_ outcome: Outage.Outcome) {
        guard var value = outage else { return }
        if let since = reconnectingShownAt {
            value.visibleMs += ms(since)
            reconnectingShownAt = now()
        }
        outage = nil
        outageReauthed = nil
        target = nil
        awaitingList = false
        value.outcome = outcome
        #if DEBUG
        outages.append(value)
        #endif
        onOutage?(value)
    }

    private func ms(_ since: TimeInterval) -> Double { (now() - since) * 1000 }
}

/// Coarse network path for the summaries: wifi / cellular / wired / other / none.
final class NetworkPathObserver: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "kraki.network-path", qos: .utility)

    init(onChange: @escaping (String) -> Void) {
        monitor.pathUpdateHandler = { path in
            let kind: String
            if path.status != .satisfied { kind = "none" }
            else if path.usesInterfaceType(.wifi) { kind = "wifi" }
            else if path.usesInterfaceType(.cellular) { kind = "cellular" }
            else if path.usesInterfaceType(.wiredEthernet) { kind = "wired" }
            else { kind = "other" }
            DispatchQueue.main.async { onChange(kind) }
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }
}
