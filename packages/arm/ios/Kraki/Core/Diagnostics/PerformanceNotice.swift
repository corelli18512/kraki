import Observation
import SwiftUI
import UserNotifications

/// One-time notice that the app shares performance data (on by default).
///
/// Shown once per install after a sign-in — for new users after the first
/// sign-in, for existing users on the first launch of the version that turns
/// it on — and never on top of the notification permission prompt: it waits
/// until the system has an answer (or a minute has passed). "Don't Share" turns
/// it off; either button marks it seen. Afterwards it lives in Settings only.
/// The logic is always compiled (unit-tested in Debug); it is only wired into
/// the app in production builds (`KRAKI_DIAG && !KRAKI_DIAG_TEST_BUILD`).
@Observable
@MainActor
final class PerformanceNotice {
    static let shared = PerformanceNotice()
    init() {}
    static let seenKey = "kraki.diag.noticeSeen"

    private(set) var isVisible = false
    @ObservationIgnored private var scheduled = false
    @ObservationIgnored var defaults: UserDefaults = .standard
    /// Turns sharing off ("Don't Share").
    @ObservationIgnored var onDecline: () -> Void = {
        #if KRAKI_DIAG
        KrakiDiag.setEnabled(false)
        #endif
    }
    /// Skip in UI tests / local-relay runs; tests of this type turn it off.
    @ObservationIgnored var skipsAutomatedRuns = true
    /// Seconds to wait after sign-in before showing (lets the main screen settle).
    @ObservationIgnored var settleDelay: Duration = .seconds(1.5)
    /// The notification permission question is still open (prompt up or due).
    @ObservationIgnored var permissionPending: () async -> Bool = {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .notDetermined
    }

    var hasBeenSeen: Bool { defaults.bool(forKey: Self.seenKey) }

    /// Called on every successful authentication; shows at most once.
    func authenticated() {
        guard !scheduled, !hasBeenSeen, !(skipsAutomatedRuns && Self.isAutomatedRun) else { return }
        scheduled = true
        Task { @MainActor in
            try? await Task.sleep(for: settleDelay)
            // Never stack on the notification permission alert.
            for _ in 0..<60 where await permissionPending() {
                try? await Task.sleep(for: .seconds(1))
            }
            guard !hasBeenSeen else { return }
            withAnimation(.spring(duration: 0.35)) { isVisible = true }
        }
    }

    func choose(share: Bool) {
        defaults.set(true, forKey: Self.seenKey)
        if !share { onDecline() }
        withAnimation(.easeOut(duration: 0.2)) { isVisible = false }
    }

    #if DEBUG
    /// Screenshot/test hook.
    func showForTesting() { isVisible = true }
    #endif

    private static var isAutomatedRun: Bool {
        #if DEBUG
        if ProcessInfo.processInfo.environment["KRAKI_SHOW_PERFORMANCE_NOTICE"] == "1" { return false }
        #endif
        return SessionNotifications.isTestHost
            || ProcessInfo.processInfo.environment["KRAKI_LOCAL_RELAY_PORT"] != nil
    }
}

/// The notice card. Floats above the content near the bottom edge.
struct PerformanceNoticeCard: View {
    let notice: PerformanceNotice

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "gauge.with.dots.needle.67percent")
                    .foregroundStyle(Color.accentColor)
                Text("Help Make Kraki Faster")
                    .font(.headline)
            }
            Text("Kraki sends timings like how fast messages are delivered and replies start, plus connection drops and crashes, so we can fix slow spots. Never message text, voice or attachments.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("You can change this anytime in Settings › Privacy.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
            HStack(spacing: 10) {
                Button("Don't Share") { notice.choose(share: false) }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("performance-notice-decline")
                Spacer(minLength: 0)
                Button("OK") { notice.choose(share: true) }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("performance-notice-ok")
            }
            .controlSize(.large)
        }
        .padding(18)
        .frame(maxWidth: 440, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.18), radius: 24, y: 8)
        .padding(.horizontal, 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("performance-notice")
    }
}

extension View {
    /// Shows the performance data notice over this view when it is due.
    func performanceNotice(bottomPadding: CGFloat) -> some View {
        modifier(PerformanceNoticeOverlay(bottomPadding: bottomPadding))
    }
}

private struct PerformanceNoticeOverlay: ViewModifier {
    let bottomPadding: CGFloat
    @State private var notice = PerformanceNotice.shared

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if notice.isVisible {
                PerformanceNoticeCard(notice: notice)
                    .padding(.bottom, bottomPadding)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }
}
