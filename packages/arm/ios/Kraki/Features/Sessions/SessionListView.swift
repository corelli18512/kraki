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

    private var sessionStore: SessionStore { appState.sessionStore }
    private var deviceStore: DeviceStore { appState.deviceStore }

    private var sorted: [SessionInfo] { sessionStore.sortedSessions }

    private var filteredSessions: [SessionInfo] {
        guard let id = selectedDeviceFilter else { return sorted }
        return sorted.filter { $0.deviceId == id }
    }

    private var hasTentacle: Bool {
        deviceStore.tentacleDevices.contains { $0.online }
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
    }

    // MARK: - Brand Header (custom, not toolbar)

    private var brandHeader: some View {
        HStack(spacing: 6) {
            Text("KRAKI")
                .font(.system(size: 22, weight: .heavy, design: .monospaced))
                .tracking(2.5)
                .foregroundColor(.krakiPrimary)

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
        .background(Color.surfacePrimary)
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
        .background(Color.surfacePrimary.opacity(0.85))
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
        SessionTable(appState: appState, deviceFilter: selectedDeviceFilter) { sessionId in
            navigationPath.append(SessionNavID(id: sessionId))
        }
        .background(Color.surfacePrimary)
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()

            Image("KrakiLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 96, height: 96)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .opacity(0.85)

            Text("Create a session to begin")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if !hasTentacle {
                Text("npx @kraki/tentacle")
                    .font(.system(size: 13, design: .monospaced))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.top, 4)
            }

            Spacer()
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.surfacePrimary)
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
