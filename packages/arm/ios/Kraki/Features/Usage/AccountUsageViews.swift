/// Account usage rings — shared by the iOS device detail page and the Mac
/// hold-to-peek panel. One ring per quota window (5-hour and weekly side by
/// side), the number inside is that window's remaining percent, and color
/// alone tells the state: green ≥ 50 %, orange ≥ 15 %, red below, gray stale.

import SwiftUI

enum UsageRingState {
    case ok, mid, low, out, stale, none

    init(_ remaining: Double?, stale: Bool) {
        guard let v = remaining else { self = .none; return }
        if stale { self = .stale }
        else if v <= 0.5 { self = .out }
        else if v < 15 { self = .low }
        else if v < 50 { self = .mid }
        else { self = .ok }
    }

    var colors: [Color] {
        switch self {
        case .ok: return [Color(red: 0.24, green: 0.86, blue: 0.52), Color(red: 0.09, green: 0.64, blue: 0.29)]
        case .mid: return [Color(red: 1, green: 0.75, blue: 0.30), Color(red: 1, green: 0.54, blue: 0)]
        case .low, .out: return [Color(red: 1, green: 0.48, blue: 0.43), Color(red: 1, green: 0.23, blue: 0.19)]
        case .stale, .none: return [Color(white: 0.78), Color(white: 0.6)]
        }
    }
}

enum UsageFormat {
    static func shortReset(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "—" }
        let remaining = max(0, date.timeIntervalSince(now))
        guard remaining > 60 else { return String(localized: "now") }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.day, .hour, .minute]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        return formatter.string(from: remaining) ?? "—"
    }

    static func windowName(_ w: AccountUsageWindow) -> String {
        switch w.kind {
        case "five_hour": return String(localized: "5h")
        case "weekly": return String(localized: "Weekly")
        default: return w.title ?? String(localized: "Limit")
        }
    }
}

private var reduceMotion: Bool {
    #if os(macOS)
    NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    #else
    UIAccessibility.isReduceMotionEnabled
    #endif
}

/// Counts smoothly when animated.
private struct UsageCountingNumber: View, Animatable {
    var value: Double
    var size: CGFloat
    var color: Color
    var animatableData: Double { get { value } set { value = newValue } }
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text(verbatim: "\(Int(value.rounded()))")
                .font(.system(size: size, weight: .bold, design: .rounded)).monospacedDigit()
                .tracking(-size * 0.03).foregroundStyle(color)
            Text(verbatim: "%").font(.system(size: size * 0.42, weight: .semibold, design: .rounded)).foregroundStyle(.secondary)
        }
    }
}

struct UsageWindowRing: View {
    let window: AccountUsageWindow?
    let stale: Bool
    let size: CGFloat
    let lineWidth: CGFloat
    var animateIn = true
    var delay: Double = 0
    @State private var progress: Double = 0

    var body: some View {
        let state = UsageRingState(window?.remainingPercent, stale: stale)
        let c = state.colors
        let value = (window?.remainingPercent ?? 0) * progress
        ZStack {
            Circle().stroke(state == .out ? Color.red.opacity(0.16) : Color.primary.opacity(0.09), lineWidth: lineWidth)
            if window != nil {
                Circle().trim(from: 0, to: max(0.0001, value / 100))
                    .stroke(LinearGradient(colors: c, startPoint: .topLeading, endPoint: .bottomTrailing),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .shadow(color: c[1].opacity(0.45), radius: lineWidth * 0.3)
                    .opacity(value < 0.6 ? 0 : 1)
                UsageCountingNumber(value: value, size: size * 0.3,
                                    color: state == .out ? .red : (stale ? .secondary : .primary))
            } else {
                Text(verbatim: "—").font(.system(size: size * 0.26, weight: .semibold, design: .rounded)).foregroundStyle(.tertiary)
            }
        }
        .padding(lineWidth / 2)
        .frame(width: size, height: size)
        .onAppear {
            if animateIn && !reduceMotion {
                progress = 0
                withAnimation(.easeOut(duration: 0.9).delay(delay)) { progress = 1 }
            } else { progress = 1 }
        }
    }
}

/// Every main window of an account side by side, each tagged with its name and reset time.
struct AccountUsageRings: View {
    let account: AccountUsage
    let size: CGFloat
    let lineWidth: CGFloat
    let spacing: CGFloat
    var now = Date()
    var animateIn = true
    var delay: Double = 0
    /// When set, each ring flies between layouts sharing this namespace.
    var geometry: Namespace.ID? = nil
    var geometryScope = ""

    var body: some View {
        let windows = account.ringWindows
        let stale = account.isStale(now: now)
        let small = size < 70
        HStack(alignment: .top, spacing: spacing) {
            if windows.isEmpty {
                VStack(spacing: 5) {
                    UsageWindowRing(window: nil, stale: stale, size: size, lineWidth: lineWidth, animateIn: false)
                    Text(account.error == "auth" ? String(localized: "Sign-in needed") : String(localized: "Unavailable"))
                        .scaledFont(small ? 9.5 : 10.5).foregroundStyle(.secondary)
                }
            }
            ForEach(Array(windows.enumerated()), id: \.element.id) { index, w in
                VStack(spacing: 5) {
                    UsageWindowRing(window: w, stale: stale, size: size, lineWidth: lineWidth,
                                    animateIn: animateIn, delay: delay + Double(index) * 0.06)
                        .modifier(UsageMatchedRing(namespace: geometry, id: "\(geometryScope)|\(account.id)|\(w.id)"))
                    VStack(spacing: 2) {
                        Text(UsageFormat.windowName(w))
                            .scaledFont(small ? 9.5 : 10.5, weight: .semibold)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1.5)
                            .background(Color.primary.opacity(0.08), in: Capsule())
                        Text("↻ " + UsageFormat.shortReset(w.resetDate, now: now))
                            .scaledFont(small ? 9.5 : 10.5).foregroundStyle(.secondary).monospacedDigit()
                    }
                    .fixedSize()
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(UsageFormat.windowName(w)) \(Int(w.remainingPercent.rounded())) percent left, resets in \(UsageFormat.shortReset(w.resetDate))")
            }
        }
    }
}

private struct UsageMatchedRing: ViewModifier {
    let namespace: Namespace.ID?
    let id: String
    func body(content: Content) -> some View {
        if let namespace { content.matchedGeometryEffect(id: id, in: namespace) } else { content }
    }
}

struct UsageProviderChip: View {
    let provider: String
    var body: some View {
        Text(verbatim: provider == "codex" ? "GPT" : "Claude")
            .scaledFont(8.5, weight: .bold).tracking(0.3)
            .padding(.horizontal, 4.5).padding(.vertical, 2.5)
            .foregroundStyle(provider == "codex" ? AnyShapeStyle(.background) : AnyShapeStyle(Color.white))
            .background(provider == "codex" ? Color.primary : Color(red: 0.85, green: 0.47, blue: 0.34),
                        in: RoundedRectangle(cornerRadius: 4))
    }
}

/// One account as a compact card: name, provider, rings.
struct AccountUsageTile: View {
    let account: AccountUsage
    let ringSize: CGFloat
    let lineWidth: CGFloat
    var showsPlan = false
    /// Compact cards show only the masked local part of the address.
    var shortName = false
    var animateIn = true
    var delay: Double = 0
    var geometry: Namespace.ID? = nil
    var geometryScope = ""

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in content(now: context.date) }
    }

    private func content(now: Date) -> some View {
        VStack(spacing: ringSize > 70 ? 10 : 8) {
            HStack(alignment: .top, spacing: 5) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(shortName ? account.shortLabel : (account.label ?? account.providerTitle))
                        .scaledFont(ringSize > 70 ? 14 : 12, weight: .semibold)
                        .lineLimit(1).truncationMode(.middle)
                        .help(account.label ?? account.providerTitle)
                    if showsPlan, let plan = account.planTitle {
                        Text(plan).scaledFont(10.5).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 3) {
                    UsageProviderChip(provider: account.provider)
                    if account.isStale(now: now) && !account.windows.isEmpty {
                        Text("Stale").scaledFont(8.5, weight: .semibold).foregroundStyle(.white)
                            .padding(.horizontal, 4).padding(.vertical, 1.5)
                            .background(Color.gray, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
            }
            AccountUsageRings(account: account, size: ringSize, lineWidth: lineWidth,
                              spacing: ringSize > 70 ? 18 : 14, now: now, animateIn: animateIn, delay: delay,
                              geometry: geometry, geometryScope: geometryScope)
                .frame(maxWidth: .infinity)
        }
    }
}

/// One account as a list row: name and plan on the left, a ring per quota window
/// on the right, and the devices it is signed in on underneath.
struct AccountUsageRow: View {
    let merged: MergedAccountUsage
    var animateIn = true
    var delay: Double = 0

    /// Two names fit; beyond that, the first (online) device and a count.
    private var deviceText: String {
        let names = merged.devices.map(\.name)
        return names.count > 2 ? "\(names[0]) +\(names.count - 1)" : names.joined(separator: " · ")
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in content(now: context.date) }
    }

    private func content(now: Date) -> some View {
        let account = merged.account
        return HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(account.label ?? account.providerTitle)
                        .scaledFont(15, weight: .semibold)
                        .lineLimit(1).truncationMode(.middle)
                    UsageProviderChip(provider: account.provider)
                }
                HStack(spacing: 6) {
                    if let plan = account.planTitle {
                        Text(plan).scaledFont(13).foregroundStyle(.secondary)
                    }
                    if account.isStale(now: now) && !account.windows.isEmpty {
                        Text("Stale").scaledFont(10, weight: .semibold).foregroundStyle(.white)
                            .padding(.horizontal, 4).padding(.vertical, 1.5)
                            .background(Color.gray, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
                HStack(spacing: 5) {
                    Image(systemName: "laptopcomputer").scaledFont(11)
                    Text(deviceText).scaledFont(13)
                }
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .opacity(merged.allOffline ? 0.6 : 1)
                AccountUsageReadStatus(account: account, offline: merged.allOffline, fontSize: 13)
            }
            Spacer(minLength: 4)
            AccountUsageRings(account: account, size: 50, lineWidth: 5, spacing: 10, now: now, animateIn: animateIn, delay: delay)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

/// Last successful read, not the quota reset or the last failed attempt.
struct AccountUsageReadStatus: View {
    let account: AccountUsage
    var offline = false
    var fontSize: CGFloat = 10.5

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 2) {
                Text(account.lastUpdatedText(now: context.date))
                    .help(account.fetchedDate?.formatted(date: .abbreviated, time: .standard) ?? String(localized: "No successful reading"))
                if let status = offline ? String(localized: "Device offline") : account.readStatus(now: context.date) {
                    Text(status).foregroundStyle(.orange)
                }
            }
            .scaledFont(fontSize).foregroundStyle(.secondary)
            .lineLimit(2)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Shared request UI. All provider calls are owned/throttled by the Tentacle.
struct AccountUsageRefreshControls: View {
    @Environment(AppState.self) private var appState
    var deviceIds: Set<String>? = nil

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let model = AccountUsageRefreshModel(appState: appState, deviceIds: deviceIds, now: context.date)
            HStack(spacing: 8) {
                if model.busy { ProgressView().controlSize(.small) }
                Text(model.status)
                    .scaledFont(11).foregroundStyle(.secondary).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    appState.commandSender?.refreshAccountUsage(deviceIds: deviceIds)
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered).controlSize(.small)
                .disabled(!model.ready || model.busy)
                .help("Refresh readings without bypassing provider rate limits")
                .accessibilityIdentifier("account-usage-refresh")
            }
        }
    }
}

#if os(iOS)
/// iOS list header: the section title with a plain Refresh action on its
/// trailing edge (a spinner while refreshing), sized like the header text.
struct AccountUsageSectionHeader: View {
    @Environment(AppState.self) private var appState
    var deviceIds: Set<String>? = nil

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let model = AccountUsageRefreshModel(appState: appState, deviceIds: deviceIds, now: context.date)
            HStack(alignment: .center) {
                Text("Accounts")
                Spacer()
                UsageRefreshButton(busy: model.busy, ready: model.ready, available: model.available, failed: model.isNotice) {
                    appState.commandSender?.refreshAccountUsage(deviceIds: deviceIds)
                }
            }
            .textCase(nil)
        }
    }
}

/// Icon-only refresh for the Accounts header: a static arrow, the system
/// spinner while computers fetch, then a check drawn in green. The three are
/// separate views cross-faded, so only the spinner moves and the check always
/// appears upright. A failed refresh returns to the arrow with a wiggle (the
/// footer says why).
///
/// The page refreshes automatically when it appears, so the 60 s cool-down is
/// the usual state: during it the button looks normal and a tap only wiggles
/// (no request; the status already reads "Just updated"). It is shown disabled
/// only when nothing can refresh (disconnected, no capable computer), and even
/// then stays clearly visible.
struct UsageRefreshButton: View {
    let busy: Bool
    /// A request may be sent now.
    let ready: Bool
    /// Refresh is possible at all (cool-down included). Defaults to `ready`.
    var available: Bool? = nil
    var failed = false
    let action: () -> Void

    enum Phase { case idle, busy, done }
    @State private var showsDone = false
    @State private var failures = 0
    @State private var nudges = 0

    static let size: CGFloat = 30
    static let doneDuration: Duration = .seconds(1.4)

    private var phase: Phase { busy ? .busy : (showsDone ? .done : .idle) }
    private var enabled: Bool { (available ?? ready) && !busy }
    private var tint: Color {
        switch phase {
        case .done: return .green
        case .busy, .idle: return .krakiPrimary
        }
    }
    static let disabledOpacity: Double = 0.62

    var body: some View {
        Button {
            if ready { action() } else { nudges += 1 }
        } label: {
            ZStack {
                Image(systemName: "arrow.clockwise")
                    .symbolEffect(.wiggle, value: failures + nudges)
                    .opacity(phase == .idle ? 1 : 0)
                    .scaleEffect(phase == .idle ? 1 : 0.5)
                ProgressView()
                    .controlSize(.small)
                    .tint(.krakiPrimary)
                    .opacity(phase == .busy ? 1 : 0)
                check
            }
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(tint)
            .frame(width: Self.size, height: Self.size)
            .background(tint.opacity(0.13), in: Circle())
            .opacity(phase == .idle && !enabled ? Self.disabledOpacity : 1)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(UsageRefreshPressStyle())
        .disabled(!enabled)
        .animation(.snappy(duration: 0.28), value: phase)
        .animation(.easeInOut(duration: 0.2), value: enabled)
        .onChange(of: busy) { was, now in
            if now { showsDone = false; return }
            guard was else { return }
            if failed {
                failures += 1
            } else {
                showsDone = true
                Task { @MainActor in
                    try? await Task.sleep(for: Self.doneDuration)
                    showsDone = false
                }
            }
        }
        .padding(.trailing, -10) // align the disc with the row edge, keep the 44 pt hit area
        .accessibilityLabel(busy ? String(localized: "Refreshing accounts") : String(localized: "Refresh accounts"))
        .accessibilityHint("Refreshes readings without bypassing provider rate limits")
        .accessibilityIdentifier("account-usage-refresh")
    }

    /// Drawn on when it appears; hidden (not animated out) otherwise, so it is
    /// fully gone before the arrow returns.
    @ViewBuilder private var check: some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            Image(systemName: "checkmark")
                .symbolEffect(.drawOn, isActive: phase != .done)
                .opacity(phase == .done ? 1 : 0)
                .animation(phase == .done ? nil : .easeOut(duration: 0.12), value: phase)
        } else {
            Image(systemName: "checkmark").opacity(phase == .done ? 1 : 0)
        }
    }
}

private struct UsageRefreshPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.86 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.6), value: configuration.isPressed)
    }
}

/// Refresh problems worth reading (not routine "rate limits apply").
struct AccountUsageRefreshNotice: View {
    @Environment(AppState.self) private var appState
    var deviceIds: Set<String>? = nil

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let model = AccountUsageRefreshModel(appState: appState, deviceIds: deviceIds, now: context.date)
            if model.isNotice {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "exclamationmark.circle")
                    Text(model.status)
                }
            }
        }
    }
}
#endif

/// Refresh state shared by the Mac controls and the iOS header.
struct AccountUsageRefreshModel {
    let busy: Bool
    /// A request may be sent now (not cooling down).
    let ready: Bool
    /// Connected with at least one computer able to refresh; cooling down
    /// still counts. Only an unavailable control is shown disabled.
    let available: Bool
    let status: String
    /// Something the user should act on (error, offline, update needed).
    let isNotice: Bool

    @MainActor
    init(appState: AppState, deviceIds: Set<String>?, now: Date) {
        let store = appState.deviceStore
        let ids = store.usageRefreshTargets(deviceIds: deviceIds)
        let connected = appState.connectionStatus == .connected
        busy = connected && ids.contains { store.usageRefreshes[$0]?.finished == false }
        ready = connected && ids.contains { store.canRefreshUsage($0, now: now) }
        available = connected && !ids.isEmpty
        status = Self.status(store: store, ids: ids, deviceIds: deviceIds, connected: connected, busy: busy, ready: ready)
        // Per-account failures already show on their rows.
        isNotice = !busy && ![String(localized: "Provider rate limits apply"), String(localized: "Just updated"), String(localized: "Some accounts couldn't be updated")].contains(status)
    }

    @MainActor
    private static func status(store: DeviceStore, ids: [String], deviceIds: Set<String>?,
                               connected: Bool, busy: Bool, ready: Bool) -> String {
        if !connected { return String(localized: "Connect to refresh") }
        if busy { return String(localized: "Refreshing…") }
        if ids.isEmpty {
            let online = store.devices.values.contains {
                $0.role == .tentacle && $0.online && (deviceIds?.contains($0.id) ?? true)
            }
            return online ? String(localized: "Update or enable account usage on your device to refresh") : String(localized: "No device online")
        }
        if let error = ids.compactMap({ store.usageRefreshes[$0]?.error }).first {
            switch error {
            case "timeout": return String(localized: "Refresh timed out. Try again.")
            case "offline", "connection": return String(localized: "Connection lost. Try again.")
            case "disabled": return String(localized: "Enable account usage on the device.")
            case "busy": return String(localized: "Device is already refreshing. Try again shortly.")
            default: return String(localized: "Couldn't refresh. Try again.")
            }
        }
        if ids.contains(where: { store.deviceUsage[$0]?.accounts.contains(where: { $0.error != nil }) == true }) {
            return String(localized: "Some accounts couldn't be updated")
        }
        return ready ? String(localized: "Provider rate limits apply") : String(localized: "Just updated")
    }
}

/// Names online devices running a Kraki too old to report account usage.
enum UsageUpdateHint {
    static func text(_ devices: [DeviceSummary]) -> String {
        let names = devices.map(\.name)
        let list = names.count > 2
            ? String(localized: "\(names[0]) and \(names.count - 1) more")
            : names.formatted(.list(type: .and))
        return devices.count == 1
            ? String(localized: "Update Kraki on \(list) to see its accounts")
            : String(localized: "Update Kraki on \(list) to see their accounts")
    }
}
