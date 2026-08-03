/// SessionsSidebarView (macOS) — Mirrors iOS SessionListView 1:1.
///
/// Layout (top-to-bottom):
///
///   ┌──────────────────────────┐
///   │ ◯ ◯ ◯       ⏳    ◯  +   │  ← window toolbar (real .toolbar
///   ├──────────────────────────┤    items; filter+plus sit on the
///   │ [All] device-A device-B  │    same row as the traffic lights)
///   ├──────────────────────────┤
///   │ ▸ Session row            │
///   │ …                        │
///   ├──────────────────────────┤
///   │ 👤 corelli   🟢 v0.24  ⚙ │  ← footer
///   └──────────────────────────┘
///
/// Filter contract (mirrors iOS SessionListView):
///   • Device filter only (no Active/Pinned/Q chips — those were a
///     mac-specific invention and have been removed).
///   • Filter button only renders when tentacleDevices.count > 1.
///   • Filter row toggles open/closed and shows "All" + one pill per
///     tentacle device, capsule glass background.

#if os(macOS)
import AppKit
import SwiftUI

/// Observes the NSScrollView created by SwiftUI without replacing it or
/// measuring the list. The hidden probe has no layout cost; its local event
/// monitor only consumes imprecise mouse-wheel ticks for this list.
private struct MacSessionSmoothScrollProbe: NSViewRepresentable {
    func makeNSView(context: Context) -> MacSessionSmoothScrollProbeView {
        MacSessionSmoothScrollProbeView()
    }

    func updateNSView(_ nsView: MacSessionSmoothScrollProbeView, context: Context) {
        nsView.attachToEnclosingScrollView()
    }
}

final class MacSessionSmoothScrollProbeView: NSView {
    private let controller = MacSmoothWheelController()
    private let transientScrollerController = MacTransientOverlayScrollerController()
    private weak var observedScrollView: NSScrollView?
    private var localMonitor: Any?
    private var attachGeneration = 0
    private var attachRetryCount = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = false
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        attachGeneration += 1
        attachRetryCount = 0
        attachToEnclosingScrollView()
    }

    deinit {
        if let localMonitor {
            NSEvent.removeMonitor(localMonitor)
        }
    }

    func attachToEnclosingScrollView() {
        let generation = attachGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self, generation == self.attachGeneration else { return }
            guard let scrollView = self.resolveSessionScrollView() else {
                guard self.window != nil, self.attachRetryCount < 20 else { return }
                self.attachRetryCount += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    guard let self, generation == self.attachGeneration else { return }
                    self.attachToEnclosingScrollView()
                }
                return
            }
            self.attachRetryCount = 0
            self.transientScrollerController.attach(to: scrollView)
            guard scrollView !== self.observedScrollView else { return }
            self.observedScrollView = scrollView
            self.controller.reset()
            self.installMonitorIfNeeded()
        }
    }

    private func resolveSessionScrollView() -> NSScrollView? {
        if let enclosingScrollView { return enclosingScrollView }
        var ancestor = superview
        while let root = ancestor {
            var candidates: [NSScrollView] = []
            collectVerticalScrollViews(in: root, into: &candidates)
            if let match = candidates
                .filter({ !($0 is MacChatScrollView) })
                .max(by: { $0.bounds.height < $1.bounds.height }) {
                return match
            }
            ancestor = root.superview
        }
        return nil
    }

    private func collectVerticalScrollViews(in view: NSView, into result: inout [NSScrollView]) {
        if let scrollView = view as? NSScrollView,
           let documentView = scrollView.documentView,
           documentView.frame.height > scrollView.contentView.bounds.height + 1 {
            result.append(scrollView)
        }
        for child in view.subviews where child !== self {
            collectVerticalScrollViews(in: child, into: &result)
        }
    }

    #if DEBUG
    var debugObservedScrollView: NSScrollView? { observedScrollView }

    @discardableResult
    func debugHandleScrollEvent(_ event: NSEvent) -> Bool {
        guard let scrollView = observedScrollView else { return false }
        transientScrollerController.noteScrollEvent(event)
        return controller.handle(event, in: scrollView)
    }
    #endif

    private func installMonitorIfNeeded() {
        guard localMonitor == nil else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self,
                  let scrollView = self.observedScrollView,
                  scrollView.window === event.window,
                  scrollView.bounds.contains(scrollView.convert(event.locationInWindow, from: nil)) else {
                return event
            }
            self.transientScrollerController.noteScrollEvent(event)
            return self.controller.handle(event, in: scrollView) ? nil : event
        }
    }
}

/// Delivers a primary click even when Kraki's window is not currently key.
///
/// AppKit normally consumes the first click only to activate an inactive
/// window. SwiftUI's tap gesture therefore never sees that click and the user
/// has to click the Session a second time. This transparent hit target opts
/// into first-mouse delivery for the left button only. Right-clicks pass
/// through untouched so the existing SwiftUI context menu remains native.
private struct MacFirstMouseTapOverlay: NSViewRepresentable {
    let action: () -> Void

    func makeNSView(context: Context) -> MacFirstMouseTapView {
        let view = MacFirstMouseTapView()
        view.action = action
        return view
    }

    func updateNSView(_ nsView: MacFirstMouseTapView, context: Context) {
        nsView.action = action
    }
}

private final class MacFirstMouseTapView: NSView {
    var action: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = false
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        event?.type == .leftMouseDown
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard bounds.contains(point) else { return nil }
        switch NSApp.currentEvent?.type {
        case .leftMouseDown, .leftMouseUp, .leftMouseDragged:
            return self
        default:
            return nil
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard event.buttonNumber == 0 else { return }
        action?()
    }
}

struct SessionsSidebarView: View {
    @Environment(AppState.self) private var appState

    @Binding var selectedSessionId: String?

    /// Search owned by the window rail. Filters title, device, model and
    /// authoritative Preview without introducing a second sidebar header.
    var searchText: String = ""

    /// Triggered from the rail's "+" button.
    var onNewSession: () -> Void = {}

    /// Device filter — `nil` means "All devices". Matches iOS
    /// SessionListView's `selectedDeviceFilter` exactly.
    @State private var selectedDeviceFilter: String? = nil
    @State private var showFilterRow: Bool = false

    // MARK: - Derived

    private var tentacleDevices: [DeviceSummary] {
        appState.deviceStore.tentacleDevices
    }

    private var sortedSessions: [SessionInfo] {
        appState.sessionStore.navigationOrderedSessions
    }

    private var filteredSessions: [SessionInfo] {
        let deviceFiltered: [SessionInfo]
        if let deviceId = selectedDeviceFilter {
            deviceFiltered = sortedSessions.filter { $0.deviceId == deviceId }
        } else {
            deviceFiltered = sortedSessions
        }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return deviceFiltered }
        return deviceFiltered.filter { session in
            let preview = appState.sessionStore.sessionPreviews[session.id]?.text ?? ""
            return [session.displayTitle, session.deviceName, session.model ?? "", preview]
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            if showFilterRow && tentacleDevices.count > 1 {
                deviceFilterRow
                Divider().foregroundStyle(Color.borderPrimary)
            }

            if filteredSessions.isEmpty {
                emptyState
            } else {
                sessionList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Solid, opaque canvas — no native sidebar vibrancy/glass. One
        // flat plane; the 1px seam separating sidebar from detail is
        // drawn by the parent HStack (MainWindowView), not here, so the
        // sidebar fills edge-to-edge with no trailing inset.
        .background(Color.surfacePrimary)
    }

    // MARK: - Device filter row (iOS parity)

    private var deviceFilterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                filterPill(label: "All", isSelected: selectedDeviceFilter == nil) {
                    selectedDeviceFilter = nil
                }
                ForEach(tentacleDevices) { device in
                    filterPill(label: device.name,
                               isSelected: selectedDeviceFilter == device.id) {
                        selectedDeviceFilter = device.id
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color.surfacePrimary)
    }

    @ViewBuilder
    private func filterPill(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(isSelected ? Color.white : Color.textSecondary)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
        }
        .background {
            if isSelected {
                Capsule().fill(Color.krakiPrimary)
            } else {
                Capsule()
                    .fill(Color.surfaceSecondary)
                    .overlay(
                        Capsule().stroke(Color.borderPrimary.opacity(0.6), lineWidth: 1)
                    )
            }
        }
        .clipShape(Capsule())
        .buttonStyle(.plain)
    }

    // MARK: - Session list

    private var sessionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: []) {
                ForEach(filteredSessions) { session in
                    sidebarRow(for: session)
                }
            }
            .padding(.vertical, 4)
        }
        .overlay(alignment: .topLeading) {
            MacSessionSmoothScrollProbe()
                .frame(width: 1, height: 1)
        }
    }

    private func sidebarRow(for session: SessionInfo) -> some View {
        MacSidebarSessionRow(
            session: session,
            isSelected: selectedSessionId == session.id
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(session.displayTitle)
        .accessibilityValue(accessibilityValue(for: session))
        .accessibilityHint("Open session")
        .accessibilityAction(.default) {
            selectSession(session.id)
        }
        .onTapGesture {
            selectSession(session.id)
        }
        .overlay {
            MacFirstMouseTapOverlay {
                selectSession(session.id)
            }
        }
        .contextMenu {
            Button(session.pinned ? "Unpin" : "Pin") {
                appState.commandSender?.pinSession(sessionId: session.id, pinned: !session.pinned)
            }
            Button(appState.sessionStore.isUnread(session.id) ? "Mark Read" : "Mark Unread") {
                if appState.sessionStore.isUnread(session.id) {
                    appState.sessionStore.markRead(session.id, seq: session.lastSeq)
                    appState.commandSender?.markRead(sessionId: session.id, seq: session.lastSeq)
                } else {
                    appState.commandSender?.markUnread(sessionId: session.id)
                }
            }
            Button("Fork") {
                appState.commandSender?.forkSession(sessionId: session.id)
            }
            Divider()
            Button("Delete…", role: .destructive) {
                NotificationCenter.default.post(
                    name: .macDeleteSession, object: nil,
                    userInfo: ["sessionId": session.id]
                )
            }
        }
    }

    private func selectSession(_ sessionId: String) {
        selectedSessionId = sessionId
        appState.sessionStore.clearUnread(sessionId)
    }

    private func accessibilityValue(for session: SessionInfo) -> String {
        let preview = appState.sessionStore.sessionPreviews[session.id]
        let hasDraft = appState.sessionStore.drafts[session.id]?.isEmpty == false
        let status = MacSessionSidebarStatus.resolve(
            sessionState: session.state,
            previewType: preview?.type,
            deviceOnline: appState.deviceStore.devices[session.deviceId]?.online,
            hasDraft: hasDraft
        )
        return [status.accessibilityLabel, preview?.text]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 10) {
            Spacer()
            if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(Color.textMuted)
                Text("No matching sessions")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Text("Try another search")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
            } else if selectedDeviceFilter != nil {
                Image(systemName: "line.3.horizontal.decrease.circle")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(Color.textMuted)
                Text("No sessions for this device")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Button {
                    withAnimation { selectedDeviceFilter = nil }
                } label: {
                    Text("Show all devices")
                        .font(.system(size: 11, weight: .medium))
                }
                .buttonStyle(.link)
            } else {
                Image(systemName: "ellipsis.bubble")
                    .font(.system(size: 32, weight: .light))
                    .foregroundStyle(Color.krakiPrimary.opacity(0.55))
                Text("No sessions yet")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(Color.textSecondary)
                Text("Click + or run `kraki` in Terminal.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
            }
            Spacer()
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Footer

}

// MARK: - MacSidebarSessionRow
//
// Compact desktop Session Card: title, device/model metadata, and a
// digest-authoritative preview. The leading preview slot is reserved for
// coarse state only; it never exposes a transient tool or narration.

private struct MacSidebarSessionRow: View {
    @Environment(AppState.self) private var appState
    let session: SessionInfo
    let isSelected: Bool

    private var device: DeviceSummary? {
        appState.deviceStore.devices[session.deviceId]
    }

    private var preview: SessionPreview? {
        appState.sessionStore.sessionPreviews[session.id]
    }

    private var machineName: String? {
        let name = session.deviceName.isEmpty ? device?.name : session.deviceName
        guard let name, !name.isEmpty else { return nil }
        return name
    }

    var body: some View {
        card
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
    }

    private var card: some View {
        HStack(alignment: .top, spacing: 10) {
            // Match the iOS card's top-weighted identity column: the avatar
            // aligns with the title region instead of the three-row block's
            // vertical midpoint. Coarse state stays in the preview slot.
            AgentAvatar(
                agent: session.agent,
                model: session.model,
                sessionId: session.id,
                size: .sm
            )
            .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                titleRow
                    .frame(height: 17)
                metadataRow
                    .frame(height: 15)
                previewRow
                    .frame(height: 17)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(rowBackground)
        )
    }

    private var rowBackground: Color {
        isSelected ? Color.krakiPrimary.opacity(0.15) : .clear
    }

    private var titleRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(session.displayTitle)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Color.textTitle)
                .lineLimit(1)

            if session.pinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(Color.krakiPrimary)
            }

            Spacer(minLength: 4)

            if appState.sessionStore.isUnread(session.id) {
                Circle()
                    .fill(Color.red)
                    .frame(width: 7, height: 7)
            }

            let ts = SessionTimeFormatter.format(displayTimestamp)
            if !ts.isEmpty {
                Text(ts)
                    .font(.system(size: 10))
                    .foregroundStyle(Color.textMuted)
            }
        }
    }

    private var metadataRow: some View {
        HStack(spacing: 6) {
            if let machineName {
                Text(machineName)
                    .font(.system(size: 10))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            if machineName != nil, let model = session.model, !model.isEmpty {
                Rectangle()
                    .fill(Color.borderPrimary)
                    .frame(width: 1, height: 9)
            }

            if let model = session.model, !model.isEmpty {
                Text(model)
                    .font(.system(size: 10))
                    .foregroundStyle(Color.textMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Last-activity timestamp, falling back to `createdAt` so fresh
    /// sessions still show a time after a cold relaunch (mirrors iOS).
    private var displayTimestamp: String {
        if let ts = preview?.timestamp, !ts.isEmpty { return ts }
        return ISO8601.withFractional.string(from: session.createdAt)
    }

    @ViewBuilder
    private var previewRow: some View {
        let draft = appState.sessionStore.drafts[session.id]
        let hasDraft = draft?.isEmpty == false

        HStack(spacing: 5) {
            MacSessionStatusGlyph(
                sessionState: session.state,
                previewType: preview?.type,
                deviceOnline: device?.online,
                hasDraft: hasDraft
            )

            if let draft, !draft.isEmpty {
                Text(draft.collapseWhitespace())
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else if let text = preview?.text, !text.isEmpty {
                Text(text.collapseWhitespace())
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else {
                Text("Session created")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
                    .italic()
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

enum MacSessionSidebarStatus: Equatable {
    case active, compacting, waiting, approval, error, offline
    case agentMessage, humanMessage, idle

    static func resolve(
        sessionState: SessionState,
        previewType: String?,
        deviceOnline: Bool?,
        hasDraft: Bool = false
    ) -> Self {
        if deviceOnline == false { return .offline }
        switch previewType {
        case "question": return .waiting
        case "permission": return .approval
        case "error": return .error
        default: break
        }
        switch sessionState {
        case .active: return .active
        case .compacting: return .compacting
        case .idle:
            if hasDraft { return .humanMessage }
            switch previewType {
            case "agent", "agent_message": return .agentMessage
            case "user", "user_message": return .humanMessage
            default: return .idle
            }
        }
    }

    var accessibilityLabel: String? {
        switch self {
        case .active: return "Running"
        case .compacting: return "Compacting"
        case .waiting: return "Waiting for an answer"
        case .approval: return "Waiting for approval"
        case .error: return "Failed"
        case .offline: return "Offline"
        case .agentMessage: return "Last message from agent"
        case .humanMessage: return "Last message from you"
        case .idle: return nil
        }
    }
}

/// A fixed 16pt leading slot that expresses coarse Session state without
/// using loading language. The animated dots mean "active work"; they do
/// not imply progress, network loading, or a specific tool call.
private struct MacSessionStatusGlyph: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let sessionState: SessionState
    let previewType: String?
    let deviceOnline: Bool?
    let hasDraft: Bool

    private var status: MacSessionSidebarStatus {
        .resolve(
            sessionState: sessionState,
            previewType: previewType,
            deviceOnline: deviceOnline,
            hasDraft: hasDraft
        )
    }

    var body: some View {
        Group {
            switch status {
            case .active, .compacting:
                activityDots
            case .waiting:
                LucideIcon(.messageCircleQuestion,
                           size: 14,
                           strokeWidth: 2.2,
                           color: Color(hex: 0xD97706))
            case .approval:
                LucideIcon(.shieldQuestion,
                           size: 14,
                           strokeWidth: 2.2,
                           color: Color(hex: 0xD97706))
            case .error:
                LucideIcon(.circleSlash,
                           size: 14,
                           strokeWidth: 2.2,
                           color: Color.red)
            case .offline:
                Image(systemName: "wifi.slash")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.textMuted)
            case .agentMessage:
                LucideIcon(.botMessageSquare,
                           size: 13,
                           strokeWidth: 1.9,
                           color: Color.krakiPrimary)
            case .humanMessage:
                LucideIcon(.circleUser,
                           size: 13,
                           strokeWidth: 1.9,
                           color: hasDraft ? Color.red : Color.textSecondary)
            case .idle:
                Color.clear
            }
        }
        .frame(width: 16, height: 16, alignment: .center)
        .accessibilityHidden(true)
    }

    private var activityColor: Color {
        status == .compacting ? Color(hex: 0x0891B2) : Color.krakiPrimary
    }

    private var activityDots: some View {
        MacSessionActivityDots(
            color: NSColor(activityColor),
            reduceMotion: reduceMotion
        )
        .frame(width: 14, height: 14)
    }
}

/// Core Animation owns the repeating frames so active rows do not invalidate
/// SwiftUI's Session list on every animation tick.
private struct MacSessionActivityDots: NSViewRepresentable {
    let color: NSColor
    let reduceMotion: Bool

    func makeNSView(context: Context) -> MacSessionActivityDotsView {
        MacSessionActivityDotsView()
    }

    func updateNSView(_ nsView: MacSessionActivityDotsView, context: Context) {
        nsView.configure(color: color, reduceMotion: reduceMotion)
    }
}

private final class MacSessionActivityDotsView: NSView {
    private let dotLayers: [CALayer] = (0..<3).map { _ in CALayer() }
    private var reduceMotion = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = false
        for dot in dotLayers {
            dot.cornerRadius = 1.5
            layer?.addSublayer(dot)
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 14, height: 14) }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (index, dot) in dotLayers.enumerated() {
            dot.frame = CGRect(x: CGFloat(index) * 5.5, y: 5.5, width: 3, height: 3)
        }
        CATransaction.commit()
    }

    func configure(color: NSColor, reduceMotion: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for dot in dotLayers {
            dot.backgroundColor = color.cgColor
        }
        CATransaction.commit()

        guard self.reduceMotion != reduceMotion || dotLayers[0].animation(forKey: "thinking") == nil else {
            return
        }
        self.reduceMotion = reduceMotion
        installAnimations()
    }

    private func installAnimations() {
        for (index, dot) in dotLayers.enumerated() {
            dot.removeAnimation(forKey: "thinking")
            if reduceMotion {
                dot.opacity = Float(0.48 + Double(index) * 0.2)
                dot.transform = CATransform3DIdentity
                continue
            }

            dot.opacity = 0.36
            let opacity = CAKeyframeAnimation(keyPath: "opacity")
            opacity.values = [0.36, 1.0, 0.36]
            opacity.keyTimes = [0, 0.5, 1]

            let scale = CAKeyframeAnimation(keyPath: "transform.scale")
            scale.values = [0.72, 1.0, 0.72]
            scale.keyTimes = [0, 0.5, 1]

            let group = CAAnimationGroup()
            group.animations = [opacity, scale]
            group.duration = 1.2
            group.repeatCount = .infinity
            group.beginTime = CACurrentMediaTime() + Double(index) * 0.16
            group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.add(group, forKey: "thinking")
        }
    }
}

#if DEBUG
struct MacSessionSpeakerGlyphRegressionView: View {
    private let rows: [(String, SessionState, String?, Bool?, Bool)] = [
        ("Human · user_message", .idle, "user_message", true, false),
        ("Agent · agent_message", .idle, "agent_message", true, false),
        ("Human · draft", .idle, "agent_message", true, true),
        ("Active", .active, "agent_message", true, false),
        ("Question", .idle, "question", true, false),
        ("Permission", .idle, "permission", true, false),
        ("Error", .idle, "error", true, false),
        ("Offline", .idle, "user_message", false, false),
        ("Legacy unknown", .idle, "message", true, false),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: 8) {
                    MacSessionStatusGlyph(
                        sessionState: row.1,
                        previewType: row.2,
                        deviceOnline: row.3,
                        hasDraft: row.4
                    )
                    Text(row.0)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.textSecondary)
                    Spacer(minLength: 0)
                }
                .frame(height: 26)
                if row.0 != rows.last?.0 {
                    Divider().opacity(0.35)
                }
            }
        }
        .padding(12)
        .frame(width: 240)
        .background(Color.surfacePrimary)
    }
}
#endif

#endif
