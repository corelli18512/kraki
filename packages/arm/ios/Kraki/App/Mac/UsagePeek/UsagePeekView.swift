/// Content of the account usage panel: one section per online tentacle,
/// the current Session's device first and highlighted. Compact while the
/// shortcut is held, detail on hover or when opened from the menu bar.

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
        let currentId = controller.currentDeviceId
        let sections = appState.deviceStore.onlineUsageDevices(preferredDeviceId: currentId)
        let layoutKey = sections.map { "\($0.device.id):\($0.usage.accounts.count)" }.joined(separator: ",")
        GeometryReader { geometry in
            ZStack(alignment: .topTrailing) {
                if detailed {
                    UsagePeekDetail(sections: sections, currentId: currentId, ns: ns,
                                    entering: Date() < controller.entranceUntil)
                        .frame(width: controller.detailedSize.width, height: controller.detailedSize.height)
                        .transition(.opacity.animation(.easeOut(duration: 0.2).delay(0.05)))
                } else {
                    UsagePeekCompact(sections: sections, currentId: currentId, ns: ns,
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

/// Device name; the current Session's device gets an accent dot and a tag.
private struct UsageDeviceHeader: View {
    let device: DeviceSummary
    let isCurrent: Bool
    let size: CGFloat
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: device.kind == .server || device.kind == .vm ? "server.rack" : "laptopcomputer")
                .font(.system(size: size - 1, weight: .medium))
                .foregroundStyle(isCurrent ? Color.krakiPrimary : .secondary)
            Text(device.name).font(.system(size: size, weight: .semibold)).lineLimit(1)
            if isCurrent {
                Text("Current session")
                    .font(.system(size: size - 3, weight: .semibold))
                    .foregroundStyle(Color.krakiPrimary)
                    .padding(.horizontal, 6).padding(.vertical, 1.5)
                    .background(Color.krakiPrimary.opacity(0.14), in: Capsule())
            }
            Spacer(minLength: 0)
        }
    }
}

private struct UsagePeekEmpty: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "gauge.with.dots.needle.33percent").font(.system(size: 20)).foregroundStyle(.tertiary)
            Text("No account usage from online devices yet").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Compact

struct UsagePeekCompact: View {
    let sections: [(device: DeviceSummary, usage: DeviceUsageSnapshot)]
    let currentId: String?
    let ns: Namespace.ID
    let entering: Bool

    var body: some View {
        if sections.isEmpty {
            UsagePeekEmpty()
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: UsagePeekLayout.compactSectionGap) {
                    ForEach(Array(sections.enumerated()), id: \.element.device.id) { s, section in
                        let isCurrent = section.device.id == currentId
                        VStack(alignment: .leading, spacing: 0) {
                            UsageDeviceHeader(device: section.device, isCurrent: isCurrent, size: 11.5)
                                .padding(.horizontal, 4)
                                .frame(height: UsagePeekLayout.compactHeader)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: UsagePeekLayout.compactGap),
                                                     count: UsagePeekLayout.columns),
                                      spacing: UsagePeekLayout.compactGap) {
                                ForEach(Array(section.usage.accounts.prefix(6).enumerated()), id: \.element.id) { i, account in
                                    AccountUsageTile(account: account, ringSize: 48, lineWidth: 5, animateIn: entering,
                                                     delay: 0.14 + Double(s * 3 + i) * 0.035,
                                                     geometry: ns, geometryScope: section.device.id)
                                        .padding(.horizontal, 10).padding(.top, 9).padding(.bottom, 8)
                                        .frame(maxWidth: .infinity, minHeight: UsagePeekLayout.compactTile,
                                               maxHeight: UsagePeekLayout.compactTile, alignment: .top)
                                        .background(Color.primary.opacity(0.05),
                                                    in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                                            .strokeBorder(isCurrent ? Color.krakiPrimary.opacity(0.45) : Color.primary.opacity(0.06),
                                                          lineWidth: isCurrent ? 1 : 0.5))
                                        .modifier(UsageStaggerIn(index: s * 3 + i, active: entering))
                                }
                            }
                        }
                    }
                }
                .padding(9)
            }
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
    let sections: [(device: DeviceSummary, usage: DeviceUsageSnapshot)]
    let currentId: String?
    let ns: Namespace.ID
    let entering: Bool

    var body: some View {
        if sections.isEmpty {
            UsagePeekEmpty()
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: UsagePeekLayout.detailSectionGap) {
                    ForEach(Array(sections.enumerated()), id: \.element.device.id) { s, section in
                        let isCurrent = section.device.id == currentId
                        VStack(alignment: .leading, spacing: 0) {
                            UsageDeviceHeader(device: section.device, isCurrent: isCurrent, size: 13.5)
                                .padding(.horizontal, 2)
                                .frame(height: UsagePeekLayout.detailHeader, alignment: .top)
                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: UsagePeekLayout.detailGap),
                                                     count: UsagePeekLayout.columns),
                                      spacing: UsagePeekLayout.detailGap) {
                                ForEach(Array(section.usage.accounts.enumerated()), id: \.element.id) { i, account in
                                    UsagePeekCard(account: account, isCurrent: isCurrent, index: s * 3 + i,
                                                  entering: entering, ns: ns, scope: section.device.id)
                                        .frame(height: UsagePeekLayout.detailCard)
                                }
                            }
                        }
                    }
                }
                .padding(UsagePeekLayout.detailPadding)
            }
        }
    }
}

/// Detail card with a pointer-following highlight and a slight tilt.
private struct UsagePeekCard: View {
    let account: AccountUsage
    let isCurrent: Bool
    let index: Int
    let entering: Bool
    let ns: Namespace.ID
    let scope: String
    @Environment(\.colorScheme) private var scheme
    @State private var hover: CGPoint?
    @State private var size: CGSize = .zero

    var body: some View {
        let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let rx = hover.map { (0.5 - $0.y / max(size.height, 1)) * 6 } ?? 0
        let ry = hover.map { ($0.x / max(size.width, 1) - 0.5) * 6 } ?? 0
        AccountUsageTile(account: account, ringSize: 88, lineWidth: 8, showsPlan: true, animateIn: entering,
                         delay: 0.14 + Double(index) * 0.035, geometry: ns, geometryScope: scope)
            .padding(.horizontal, 15).padding(.top, 13).padding(.bottom, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.primary.opacity(hover == nil ? 0.05 : 0.09))
                if let p = hover {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(RadialGradient(colors: [Color.white.opacity(scheme == .dark ? 0.10 : 0.7), .clear],
                                             center: UnitPoint(x: p.x / max(size.width, 1), y: p.y / max(size.height, 1)),
                                             startRadius: 0, endRadius: 220))
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(isCurrent ? Color.krakiPrimary.opacity(0.45) : Color.primary.opacity(0.06),
                              lineWidth: isCurrent ? 1 : 0.5))
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
