#if os(iOS)
/// SessionListView — The main sessions list screen.
///
/// Mirrors SessionList.tsx + Sidebar brand header.

import SwiftUI

struct SessionListView: View {
    @Environment(AppState.self) private var appState

    @Binding var navigationPath: NavigationPath
    @State private var showNewSession = false
    @State private var selectedDeviceFilter: String? = nil
    @State private var showFilterRow = false
    #if DEBUG
    @State private var showToolIconGallery = false
    #endif

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var sorted: [SessionInfo] { sessionStore.sortedSessions }

    private var filteredSessions: [SessionInfo] {
        guard let id = selectedDeviceFilter else { return sorted }
        return sorted.filter { $0.deviceId == id }
    }

    private var tentacleDevices: [DeviceSummary] {
        deviceStore.tentacleDevices.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    var body: some View {
        Group {
            if filteredSessions.isEmpty {
                emptyState
            } else {
                sessionList
            }
        }
        .navigationBarHidden(true)
        .background(Color.surfacePrimary)
        .onAppear {
            KLog.chat("📂 [snapshot] SessionListView.onAppear render: store=\(sessionStore.sessions.count) sorted=\(sorted.count) filtered=\(filteredSessions.count)")
        }
        .onChange(of: filteredSessions.count) { old, new in
            KLog.chat("📂 [snapshot] SessionListView count change: \(old) → \(new)")
        }
        .safeAreaInset(edge: .top) {
            VStack(spacing: 0) {
                brandHeader
                if showFilterRow {
                    deviceFilterRow
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.25), value: showFilterRow)
        }
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

    // MARK: - Brand Header (custom, not toolbar)

    private var brandHeader: some View {
        HStack(spacing: 6) {
            Text("KRAKI")
                .font(.system(size: 22, weight: .heavy, design: .monospaced))
                .tracking(2.5)
                .foregroundColor(.krakiPrimary)
                #if DEBUG
                .onLongPressGesture(minimumDuration: 0.6) {
                    showToolIconGallery = true
                }
                #endif

            Text("Preview")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(Color.krakiPrimary)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.krakiPrimary.opacity(0.15), in: Capsule())

            // Ambient connection status — only visible while we're
            // away from `.connected`. Mirrors the WhatsApp / Telegram
            // pattern: small inline pill, not a blocking dialog.
            ConnectionStatusChip()

            Spacer()

            // Filter toggle button — hidden when only one device
            if tentacleDevices.count > 1 {
                Button {
                    withAnimation { showFilterRow.toggle() }
                } label: {
                    Image(systemName: showFilterRow
                          ? "line.3.horizontal.decrease.circle.fill"
                          : "line.3.horizontal.decrease.circle")
                        .font(.system(size: 20, weight: .regular))
                        .foregroundColor(selectedDeviceFilter != nil || showFilterRow ? .krakiPrimary : Color(.tertiaryLabel))
                }
            }
        }
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .padding(.vertical, 10)
        .background(Color.surfaceSecondary)
    }

    // MARK: - Device Filter Row (toggleable, floating glass pills)

    private var deviceFilterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterPill(label: "All", isSelected: selectedDeviceFilter == nil, isEnabled: true) {
                    selectedDeviceFilter = nil
                }

                ForEach(tentacleDevices) { device in
                    filterPill(
                        label: device.name,
                        isSelected: selectedDeviceFilter == device.id,
                        isEnabled: tentacleDevices.count > 1
                    ) {
                        if tentacleDevices.count > 1 {
                            selectedDeviceFilter = device.id
                        }
                    }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
        }
        .background(Color.surfaceSecondary.opacity(0.85))
    }

    @ViewBuilder
    private func filterPill(label: String, isSelected: Bool, isEnabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isSelected ? Color.white : (isEnabled ? Color.primary : Color.secondary))
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
        }
        .background {
            if #available(iOS 26.0, *) {
                Capsule()
                    .fill(isSelected ? Color.krakiPrimary : Color.clear)
                    .overlay {
                        if !isSelected {
                            Capsule().fill(.regularMaterial)
                        }
                    }
            } else {
                Capsule()
                    .fill(isSelected ? Color.krakiPrimary : Color(.tertiarySystemBackground))
            }
        }
        .clipShape(Capsule())
        .disabled(!isEnabled)
        .opacity(isEnabled || isSelected ? 1 : 0.5)
    }

    // MARK: - Session List (UIKit-backed for smooth row reorder)

    private var sessionList: some View {
        // Extend the scroll view's frame underneath the floating tab
        // bar so the iOS 26 glass material has live content to layer
        // over. The system still applies `additionalSafeAreaInsets`
        // for the tab bar height, which propagates to the UITableView
        // as `contentInset.bottom` so the last row is still
        // scroll-reachable.
        SessionTable(appState: appState, deviceFilter: selectedDeviceFilter) { sessionId in
            navigationPath.append(SessionNavID(id: sessionId))
        }
        .equatable()
        .background(Color.surfacePrimary)
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // MARK: - Empty State

    @ViewBuilder
    private var emptyState: some View {
        if selectedDeviceFilter != nil {
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
                Text("No sessions for this device")
                    .font(.headline)
                    .foregroundStyle(.primary)
                Text("Switch to another device, clear the filter, or start a new session on this one.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button {
                    withAnimation { selectedDeviceFilter = nil }
                } label: {
                    Text("Show all devices")
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
