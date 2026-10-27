#if os(iOS)
/// SessionListView — The main sessions list screen.
///
/// Mirrors SessionList.tsx + Sidebar brand header.

import SwiftUI

struct SessionListView: View {
    @Environment(AppState.self) private var appState

    /// Opens a Session: a push on iPhone, the detail column in two-column layout.
    private let openSession: (String) -> Void
    /// The Session shown beside the list (two-column layout), highlighted.
    private let selectedSessionId: String?
    @State private var showNewSession = false
    @State private var selectedDeviceFilter: String? = nil
    @State private var isSearching = false
    @State private var searchQuery = ""
    @State private var headerHeight: CGFloat = 0
    #if DEBUG
    @State private var showToolIconGallery = false
    #endif

    init(selectedSessionId: String? = nil, startsSearching: Bool = false, openSession: @escaping (String) -> Void) {
        self.openSession = openSession
        self.selectedSessionId = selectedSessionId
        _isSearching = State(initialValue: startsSearching)
    }

    init(navigationPath: Binding<NavigationPath>, startsSearching: Bool = false) {
        self.init(startsSearching: startsSearching) { navigationPath.wrappedValue.append(SessionNavID(id: $0)) }
    }

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var sorted: [SessionInfo] { sessionStore.sortedSessions }

    private var filteredSessions: [SessionInfo] {
        sessionStore.filteredSessions(sorted, deviceId: selectedDeviceFilter, matching: searchQuery)
    }

    private var isQuerying: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Archived Sessions aren't searched; their group is hidden meanwhile.
    private var archivedCount: Int {
        isQuerying ? 0 : sessionStore.archivedCount(deviceId: selectedDeviceFilter)
    }

    private var tentacleDevices: [DeviceSummary] {
        deviceStore.tentacleDevices.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        // ZStack, not Group: Group would apply the header modifier to each
        // branch, so switching between results and "no results" rebuilt the
        // header and its search field mid-typing (breaking IME composition).
        ZStack {
            if filteredSessions.isEmpty && archivedCount == 0 {
                emptyState
            } else {
                sessionList
            }
        }
        .navigationBarHidden(true)
        .background(Color.surfacePrimary)
        .onAppear {
            KLog.chat("📂 [session-list] onAppear store=\(sessionStore.sessions.count) sorted=\(sorted.count) filtered=\(filteredSessions.count)")
        }
        .onChange(of: filteredSessions.count) { old, new in
            KLog.d("📂 [snapshot] SessionListView count change: \(old) → \(new)")
        }
        .modifier(FloatingSessionListHeader { header })
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet()
                .environment(appState)
        }
        #if DEBUG
        .sheet(isPresented: $showToolIconGallery) {
            NavigationStack {
                ScrollView { ToolStatusIconGallery() }
                    .navigationTitle("Tool Status Icons")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Close") { showToolIconGallery = false }
                        }
                    }
            }
        }
        #endif
    }

    // MARK: - Header (floats over the list; Liquid Glass controls)

    private var header: some View {
        VStack(spacing: 0) {
            SessionListHeader(
                isSearching: $isSearching,
                query: $searchQuery,
                deviceFilter: $selectedDeviceFilter,
                devices: tentacleDevices,
                sessionCount: { id in id.map { id in sorted.filter { $0.deviceId == id }.count } ?? sorted.count },
                onWordmarkLongPress: wordmarkLongPress
            )
            AccountAccessUpgradeBanner()
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
    }

    private var wordmarkLongPress: (() -> Void)? {
        #if DEBUG
        return { showToolIconGallery = true }
        #else
        return nil
        #endif
    }

    // MARK: - Session List (UIKit-backed for smooth row reorder)

    private var sessionList: some View {
        // Extend the scroll view's frame underneath the floating tab
        // bar so the iOS 26 glass material has live content to layer
        // over. The system still applies `additionalSafeAreaInsets`
        // for the tab bar height, which propagates to the UITableView
        // as `contentInset.bottom` so the last row is still
        // scroll-reachable. On iOS 26 rows also scroll beneath the
        // floating header (the top scroll-edge effect keeps it legible).
        SessionTable(
            appState: appState,
            deviceFilter: selectedDeviceFilter,
            searchQuery: searchQuery,
            topContentInset: FloatingSessionListHeader<EmptyView>.floats ? headerHeight : 0,
            archivedCount: archivedCount,
            archivedIds: archivedCount == 0 ? [] : sessionStore.archivedSessionInfos(deviceId: selectedDeviceFilter).map(\.id),
            selectedSessionId: selectedSessionId
        ) { sessionId in
            openSession(sessionId)
        }
        .background(Color.surfacePrimary)
        .ignoresSafeArea(.container, edges: FloatingSessionListHeader<EmptyView>.floats ? [.top, .bottom] : .bottom)
    }

    // MARK: - Empty State

    @ViewBuilder
    private var emptyState: some View {
        if isQuerying {
            ContentUnavailableView.search(text: searchQuery.trimmingCharacters(in: .whitespacesAndNewlines))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.surfacePrimary)
        } else if selectedDeviceFilter != nil {
            // A device filter is active but matches no sessions — the
            // user almost certainly has other sessions on other
            // devices. Different copy + an explicit "clear filter"
            // action so we don't mislead them into creating a fresh
            // session on the wrong device.
            VStack(spacing: 16) {
                Spacer()
                Image(systemName: "line.3.horizontal.decrease.circle")
                    .font(.system(size: 56))
                    .foregroundStyle(.secondary)
                Text("No sessions on this computer")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text("Choose another computer, clear the filter, or start a new session on this one.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button {
                    withAnimation { selectedDeviceFilter = nil }
                } label: {
                    Text("Show All Computers")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.surfacePrimary)
        } else {
            VStack(spacing: 16) {
                Spacer()
                ZStack(alignment: .topTrailing) {
                    Image("KrakiLogo")
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 160, height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                        .opacity(0.9)
                    Image(systemName: "ellipsis.bubble.fill")
                        .font(.system(size: 36))
                        .foregroundStyle(Color(.tertiarySystemBackground), .secondary.opacity(0.55))
                        .symbolRenderingMode(.palette)
                        .offset(x: -2, y: -6)
                }
                Spacer()
            }
            .padding(.horizontal, 32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(alignment: .bottomTrailing) {
                DottedCurvedArrow()
                    .frame(width: 240, height: 240)
                    .padding(.trailing, 44)
                    .allowsHitTesting(false)
            }
            .background(Color.surfacePrimary)
        }
    }
}

// MARK: - Floating header

/// iOS 26: the header floats over the list in a safe-area bar, so rows scroll
/// beneath it with the system's soft scroll-edge effect (no opaque band that
/// fights the Liquid Glass tab bar). Earlier systems keep an inset header.
private struct FloatingSessionListHeader<Bar: View>: ViewModifier {
    @ViewBuilder var bar: () -> Bar

    static var floats: Bool {
        if #available(iOS 26.0, *) { return true }
        return false
    }

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
                .safeAreaBar(edge: .top, spacing: 0) { bar() }
                .scrollEdgeEffectStyle(.soft, for: .top)
        } else {
            content.safeAreaInset(edge: .top, spacing: 0) {
                bar().background(Color.surfacePrimary)
            }
        }
    }
}

// MARK: - Empty state pointer arrow

/// Dotted S-curve that descends, sweeps right, then descends again,
/// ending with an arrowhead pointing straight down at the bottom-right
/// "+" tab button.
private struct DottedCurvedArrow: View {
    var body: some View {
        Canvas { ctx, size in
            // Cubic Bezier where both control handles are vertical
            // (same x as their endpoint), so the tangent at both
            // start and end is pure downward — giving the "down →
            // right → down" S-curve.
            // Inset the rightmost x by a few pt so the stroke and
            // arrowhead aren't clipped by Canvas bounds.
            let rightInset: CGFloat = 10
            let start = CGPoint(x: size.width * 0.28, y: 0)
            let control1 = CGPoint(x: size.width * 0.28, y: size.height * 0.55)
            let control2 = CGPoint(x: size.width - rightInset, y: size.height * 0.45)
            let end = CGPoint(x: size.width - rightInset, y: size.height - 8)

            var curve = Path()
            curve.move(to: start)
            curve.addCurve(to: end, control1: control1, control2: control2)
            ctx.stroke(
                curve,
                with: .color(.secondary.opacity(0.55)),
                style: StrokeStyle(
                    lineWidth: 1.8,
                    lineCap: .round,
                    dash: [2, 6]
                )
            )

            // Arrowhead — tangent at the curve end is (end - control2).
            let dx = end.x - control2.x
            let dy = end.y - control2.y
            let angle = atan2(dy, dx)
            let headLen: CGFloat = 12
            let spread = CGFloat.pi / 6
            let p1 = CGPoint(
                x: end.x - headLen * cos(angle - spread),
                y: end.y - headLen * sin(angle - spread)
            )
            let p2 = CGPoint(
                x: end.x - headLen * cos(angle + spread),
                y: end.y - headLen * sin(angle + spread)
            )
            var head = Path()
            head.move(to: p1)
            head.addLine(to: end)
            head.addLine(to: p2)
            ctx.stroke(
                head,
                with: .color(.secondary.opacity(0.7)),
                style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
            )
        }
    }
}

// MARK: - Color hex helper

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - Glass button helper

extension View {
    @ViewBuilder
    func if_available_glass() -> some View {
        if #available(iOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

#endif
