#if os(iOS)
import SwiftUI

/// Floating Session list header: the KRAKI wordmark over the list, with
/// Liquid Glass Search and Filter controls. Search replaces the header row
/// with a field; Filter opens a native menu of computers. An active computer
/// filter tints the Filter control and shows a removable chip.
struct SessionListHeader: View {
    @Environment(AppState.self) private var appState

    @Binding var isSearching: Bool
    @Binding var query: String
    @Binding var deviceFilter: String?
    /// Computers that can own Sessions, in display order.
    let devices: [DeviceSummary]
    /// Session count for a computer (`nil` = all computers).
    let sessionCount: (String?) -> Int
    /// DEBUG-only developer gallery.
    var onWordmarkLongPress: (() -> Void)?

    @FocusState private var fieldFocused: Bool

    static let controlSize: CGFloat = 44
    static let wordmarkSize: CGFloat = 28

    private var activeDevice: DeviceSummary? {
        deviceFilter.flatMap { id in devices.first { $0.id == id } }
    }
    private var showsFilter: Bool { devices.count > 1 || deviceFilter != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isSearching { searchRow } else { titleRow }
            if let activeDevice { filterChip(activeDevice) }
        }
        .padding(.horizontal, 16)
        .padding(.top, 2)
        .padding(.bottom, 6)
        .animation(.snappy(duration: 0.25), value: isSearching)
        .animation(.snappy(duration: 0.25), value: deviceFilter)
        // A filter that no longer matches a known computer is cleared.
        .onChange(of: devices.map(\.id)) { _, ids in
            if let deviceFilter, !ids.contains(deviceFilter) { self.deviceFilter = nil }
        }
    }

    // MARK: Title row

    private var titleRow: some View {
        HStack(spacing: 8) {
            wordmark
            Spacer(minLength: 8)
            Button { beginSearch() } label: {
                controlIcon("magnifyingglass")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Search Sessions")
            .accessibilityIdentifier("session-list-search")
            if showsFilter { filterMenu }
        }
        .frame(minHeight: Self.controlSize)
        .transition(.opacity)
    }

    private var wordmark: some View {
        // While the relay link has been down for a moment the product name
        // reads "Connecting…"; it returns to the name once connected.
        let reconnecting = appState.showsReconnecting
        return Text(reconnecting ? "Connecting…" : "KRAKI")
            .font(.system(size: reconnecting ? 17 : Self.wordmarkSize,
                          weight: reconnecting ? .semibold : .heavy,
                          design: reconnecting ? .default : .monospaced))
            .tracking(reconnecting ? 0 : Self.wordmarkSize * 2.5 / 22)
            .foregroundColor(reconnecting ? Color.textSecondary : .krakiPrimary)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.leading, 4)
            .animation(.easeInOut(duration: 0.2), value: reconnecting)
            .accessibilityAddTraits(.isHeader)
            .onLongPressGesture(minimumDuration: 0.6) { onWordmarkLongPress?() }
            .allowsHitTesting(onWordmarkLongPress != nil)
    }

    private func controlIcon(_ symbol: String, active: Bool = false) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(active ? Color.white : Color.primary)
            .frame(width: Self.controlSize, height: Self.controlSize)
            .sessionListGlass(Circle(), tint: active ? .krakiPrimary : nil)
            .contentShape(Circle())
    }

    // MARK: Search

    private var searchRow: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                TextField("Search Sessions", text: $query)
                    .focused($fieldFocused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .accessibilityIdentifier("session-list-search-field")
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear Search")
                }
            }
            .font(.system(size: 17))
            .padding(.horizontal, 14)
            .frame(height: Self.controlSize)
            .sessionListGlass(Capsule())
            Button { endSearch() } label: {
                controlIcon("xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close Search")
            .accessibilityIdentifier("session-list-search-close")
        }
        .transition(.opacity)
        .onAppear { fieldFocused = true }
    }

    private func beginSearch() {
        isSearching = true
    }

    private func endSearch() {
        fieldFocused = false
        query = ""
        isSearching = false
    }

    // MARK: Filter

    private var filterMenu: some View {
        Menu {
            Section("Filter by Computer") {
                menuItem(nil, "All Computers", detail: sessions(sessionCount(nil)), symbol: "square.stack")
                ForEach(devices) { device in
                    let count = sessions(sessionCount(device.id))
                    menuItem(device.id, device.name, detail: device.online ? count : "Offline · \(count)",
                             symbol: Self.symbol(for: device))
                }
            }
        } label: {
            controlIcon("line.3.horizontal.decrease", active: deviceFilter != nil)
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel(activeDevice.map { "Filter, showing \($0.name)" } ?? "Filter by Computer")
        .accessibilityIdentifier("session-list-filter")
    }

    /// A checkmarked choice with a session-count subtitle (native menu row).
    private func menuItem(_ id: String?, _ title: String, detail: String, symbol: String) -> some View {
        Toggle(isOn: Binding(get: { deviceFilter == id }, set: { if $0 { deviceFilter = id } })) {
            Label {
                Text(title)
                Text(detail)
            } icon: {
                Image(systemName: symbol)
            }
        }
    }

    private func sessions(_ count: Int) -> String {
        count == 1 ? "1 session" : "\(count) sessions"
    }

    static func symbol(for device: DeviceSummary) -> String {
        switch device.kind {
        case .server, .vm: return "server.rack"
        case .web: return "globe"
        case .ios, .android: return "iphone"
        case .desktop, nil: return "desktopcomputer"
        }
    }

    private func filterChip(_ device: DeviceSummary) -> some View {
        Button { deviceFilter = nil } label: {
            HStack(spacing: 6) {
                Image(systemName: Self.symbol(for: device)).font(.system(size: 13, weight: .medium))
                Text(device.name).font(.system(size: 15, weight: .medium)).lineLimit(1)
                Image(systemName: "xmark").font(.system(size: 11, weight: .bold))
            }
            .foregroundStyle(Color.primary)
            .padding(.horizontal, 14)
            .frame(height: 36)
            .sessionListGlass(Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Showing \(device.name)")
        .accessibilityHint("Shows sessions from all computers")
        .accessibilityIdentifier("session-list-filter-chip")
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

extension View {
    /// Liquid Glass on iOS 26; a thin material elsewhere.
    @ViewBuilder
    func sessionListGlass<S: Shape>(_ shape: S, tint: Color? = nil) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(tint.map { Glass.regular.tint($0).interactive() } ?? .regular.interactive(), in: shape)
        } else if let tint {
            background(tint, in: shape)
        } else {
            background(.ultraThinMaterial, in: shape)
        }
    }
}
#endif
