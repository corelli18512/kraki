/// Content of the account usage panel. Quota belongs to an account, not a
/// device, so each subscription account is one card however many machines
/// share it; the account the open Session spends comes first, highlighted.
/// Compact while the shortcut is held, detail on hover or from the menu bar.

#if os(macOS)
import SwiftUI

struct UsagePeekView: View {
    @ObservedObject var controller: UsagePeekController
    @Environment(AppState.self) private var appState
    @Environment(\.colorScheme) private var scheme
    @Namespace private var ns
    @State private var shown = true

    private var detailed: Bool { controller.displayedPresentation == .detailed }

    var body: some View {
        // Reading deviceStore here keeps the view observing usage updates.
        let _ = appState.deviceStore.deviceUsage
        let accounts = controller.orderedAccounts()
        let currentKey = controller.currentAccountKey
        let layoutKey = accounts.map(\.id).joined(separator: ",")
        GeometryReader { geometry in
            ZStack(alignment: .topTrailing) {
                if detailed {
                    UsagePeekDetail(accounts: accounts, currentKey: currentKey, ns: ns,
                                    entering: Date() < controller.entranceUntil)
                        .frame(width: controller.detailedSize.width, height: controller.detailedSize.height)
                        .transition(.opacity.animation(.easeOut(duration: 0.2).delay(0.05)))
                } else {
                    UsagePeekCompact(accounts: accounts, currentKey: currentKey, ns: ns,
                                     entering: Date() < controller.entranceUntil)
                        .frame(width: controller.compactSize.width, height: controller.compactSize.height)
                        .transition(.opacity.animation(.easeOut(duration: 0.12)))
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topTrailing)
            .clipped()
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: detailed ? 24 : 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: detailed ? 24 : 22, style: .continuous)
                .strokeBorder(Color.white.opacity(scheme == .dark ? 0.12 : 0.6), lineWidth: 0.5))
            // Open: grow out of the menu bar and come into focus. Close: shrink and blur while fading.
            .scaleEffect(controller.closing ? 0.975 : (shown ? 1 : 0.94), anchor: .topTrailing)
            .blur(radius: controller.closing ? 3 : (shown ? 0 : 6))
            .offset(y: shown || controller.closing ? 0 : -8)
            .animation(.easeIn(duration: 0.18), value: controller.closing)
        }
        .onChange(of: controller.entranceSerial) { _, _ in
            guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { shown = false }
            DispatchQueue.main.async { withAnimation(.spring(response: 0.38, dampingFraction: 0.78)) { shown = true } }
        }
        .onChange(of: layoutKey) { _, _ in controller.contentDidChange() }
    }
}

private struct UsagePeekEmpty: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.33percent").font(.system(size: 20)).foregroundStyle(.tertiary)
            Text("No account usage reported yet").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "Current session" badge for the account the open Session is spending.
private struct UsageCurrentBadge: View {
    let size: CGFloat
    var body: some View {
        Text("Current session")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(Color.krakiPrimary)
            .padding(.horizontal, 6).padding(.vertical, 1.5)
            .background(Color.krakiPrimary.opacity(0.14), in: Capsule())
    }
}

/// Where the account is signed in: "MacBook Pro · build-server". Offline devices dimmed.
private struct UsageDeviceLine: View {
    let devices: [DeviceSummary]

    /// Two names fit; beyond that, the first (online) device and a count.
    private var names: Text {
        let shown: [DeviceSummary] = devices.count > 2 ? Array(devices.prefix(1)) : devices
        var text = Text("")
        for (i, device) in shown.enumerated() {
            if i > 0 { text = text + Text(" · ").foregroundColor(.secondary) }
            let color: Color = device.online ? .secondary : Color.secondary.opacity(0.5)
            text = text + Text(device.name).foregroundColor(color)
        }
        if devices.count > 2 { text = text + Text(" +\(devices.count - 1)").foregroundColor(.secondary) }
        return text
    }
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: devices.count > 1 ? "laptopcomputer.and.arrow.down" : "laptopcomputer")
                .font(.system(size: 9.5)).foregroundStyle(.tertiary)
            names
            .font(.system(size: 10.5))
            .lineLimit(1).truncationMode(.tail)
        }
        .help(devices.map { $0.name + ($0.online ? "" : " (offline)") }.joined(separator: "\n"))
    }
}

// MARK: - Compact

struct UsagePeekCompact: View {
    let accounts: [MergedAccountUsage]
    let currentKey: String?
    let ns: Namespace.ID
    let entering: Bool

    var body: some View {
        if accounts.isEmpty {
            UsagePeekEmpty()
        } else {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: UsagePeekLayout.compactGap),
                                     count: UsagePeekLayout.columns),
                      spacing: UsagePeekLayout.compactGap) {
                ForEach(Array(accounts.prefix(UsagePeekLayout.compactLimit).enumerated()), id: \.element.id) { i, merged in
                    let isCurrent = merged.id == currentKey
                    AccountUsageTile(account: merged.account, ringSize: 48, lineWidth: 5, animateIn: entering,
                                     delay: 0.14 + Double(i) * 0.035, geometry: ns)
                        .padding(.horizontal, 10).padding(.top, 9).padding(.bottom, 8)
                        .frame(maxWidth: .infinity, minHeight: UsagePeekLayout.compactTile,
                               maxHeight: UsagePeekLayout.compactTile, alignment: .top)
                        .background(isCurrent ? Color.krakiPrimary.opacity(0.08) : Color.primary.opacity(0.05),
                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(isCurrent ? Color.krakiPrimary.opacity(0.55) : Color.primary.opacity(0.06),
                                          lineWidth: isCurrent ? 1.2 : 0.5))
                        .help(isCurrent ? "Spent by the current session" : "")
                        .modifier(UsageStaggerIn(index: i, active: entering))
                }
            }
            .padding(9)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }
}

/// Items rise and fade in one after another.
private struct UsageStaggerIn: ViewModifier {
    let index: Int
    let active: Bool
    @State private var shown = false
    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown ? 0 : 8)
            .scaleEffect(shown ? 1 : 0.97)
            .onAppear {
                guard active, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { shown = true; return }
                withAnimation(.spring(response: 0.42, dampingFraction: 0.82).delay(0.06 + Double(index) * 0.035)) { shown = true }
            }
    }
}

// MARK: - Detail

struct UsagePeekDetail: View {
    let accounts: [MergedAccountUsage]
    let currentKey: String?
    let ns: Namespace.ID
    let entering: Bool

    var body: some View {
        if accounts.isEmpty {
            UsagePeekEmpty()
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: UsagePeekLayout.detailGap),
                                         count: UsagePeekLayout.columns),
                          spacing: UsagePeekLayout.detailGap) {
                    ForEach(Array(accounts.enumerated()), id: \.element.id) { i, merged in
                        UsagePeekCard(merged: merged, isCurrent: merged.id == currentKey, index: i,
                                      entering: entering, ns: ns)
                            .frame(height: UsagePeekLayout.detailCard)
                    }
                }
                .padding(UsagePeekLayout.detailPadding)
            }
        }
    }
}

/// Detail card with a pointer-following highlight and a slight tilt.
private struct UsagePeekCard: View {
    let merged: MergedAccountUsage
    let isCurrent: Bool
    let index: Int
    let entering: Bool
    let ns: Namespace.ID
    @Environment(\.colorScheme) private var scheme
    @State private var hover: CGPoint?
    @State private var size: CGSize = .zero

    var body: some View {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let rx = hover.map { (0.5 - $0.y / max(size.height, 1)) * 6 } ?? 0
        let ry = hover.map { ($0.x / max(size.width, 1) - 0.5) * 6 } ?? 0
        VStack(spacing: 0) {
            AccountUsageTile(account: merged.account, ringSize: 88, lineWidth: 8, showsPlan: true, animateIn: entering,
                             delay: 0.14 + Double(index) * 0.035, geometry: ns)
            Spacer(minLength: 6)
            HStack(spacing: 6) {
                UsageDeviceLine(devices: merged.devices)
                Spacer(minLength: 0)
                if isCurrent { UsageCurrentBadge(size: 9.5) }
            }
        }
        .padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 11)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(isCurrent ? Color.krakiPrimary.opacity(hover == nil ? 0.07 : 0.11) : Color.primary.opacity(hover == nil ? 0.05 : 0.09))
            if let p = hover {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(RadialGradient(colors: [Color.white.opacity(scheme == .dark ? 0.10 : 0.7), .clear],
                                         center: UnitPoint(x: p.x / max(size.width, 1), y: p.y / max(size.height, 1)),
                                         startRadius: 0, endRadius: 220))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
            .strokeBorder(isCurrent ? Color.krakiPrimary.opacity(0.55) : Color.primary.opacity(0.06),
                          lineWidth: isCurrent ? 1.2 : 0.5))
        .shadow(color: .black.opacity(hover == nil ? 0.03 : 0.16), radius: hover == nil ? 1 : 14, y: hover == nil ? 1 : 8)
        .rotation3DEffect(.degrees(reduce ? 0 : rx), axis: (1, 0, 0), perspective: 0.6)
        .rotation3DEffect(.degrees(reduce ? 0 : ry), axis: (0, 1, 0), perspective: 0.6)
        .offset(y: hover == nil ? 0 : -2)
        .background(GeometryReader { g in Color.clear.onAppear { size = g.size }.onChange(of: g.size) { _, s in size = s } })
        .onContinuousHover { phase in
            switch phase {
            case .active(let p): withAnimation(.interactiveSpring(response: 0.25, dampingFraction: 0.8)) { hover = p }
            case .ended: withAnimation(.spring(response: 0.5, dampingFraction: 0.75)) { hover = nil }
            }
        }
        .modifier(UsageStaggerIn(index: index, active: true))
    }
}
#endif
