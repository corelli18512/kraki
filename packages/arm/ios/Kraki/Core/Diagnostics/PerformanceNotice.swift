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
    /// The app's notification permission prompt is on screen right now.
    @ObservationIgnored var permissionPending: () async -> Bool = { NotificationPermissionPrompt.isOpen }

    var hasBeenSeen: Bool { defaults.bool(forKey: Self.seenKey) }

    /// Called on every successful authentication; shows at most once.
    func authenticated() {
        guard !scheduled, !hasBeenSeen, !(skipsAutomatedRuns && Self.isAutomatedRun) else { return }
        scheduled = true
        Task { @MainActor in
            try? await Task.sleep(for: settleDelay)
            // Never stack on the notification permission alert: wait for its
            // answer; if it stays open, give up for now and try again on the
            // next authentication or return to the foreground. (The settle
            // delay covers the first-sign-in prompt being scheduled.)
            var waited = 0
            while await permissionPending() {
                waited += 1
                if waited > 60 { scheduled = false; return }
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

enum PerformanceNoticeCopy {
    static let title = String(localized: "Help Improve Kraki")
    static let explanation = String(localized: "Kraki sends timings like how fast messages are delivered and replies start, plus connection drops and crashes, so we can find problems and make Kraki better. Never message text, voice or attachments.")
    static let settingsHint = String(localized: "You can change this anytime in Settings › Privacy.")
}

/// Non-modal desktop card; the phone uses a system alert instead.
struct PerformanceNoticeCard: View {
    let notice: PerformanceNotice

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                Text(PerformanceNoticeCopy.title)
                    .font(.headline)
            }
            Text(PerformanceNoticeCopy.explanation)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(PerformanceNoticeCopy.settingsHint)
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
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("performance-notice")
    }
}

extension View {
    /// Desktop: bottom-right, non-modal. Phone: centered, modal system alert.
    func performanceNotice() -> some View {
        modifier(PerformanceNoticePresentation())
    }
}

struct PerformanceNoticePresentation: ViewModifier {
    @State var notice = PerformanceNotice.shared

    func body(content: Content) -> some View {
        #if os(macOS)
        content.overlay(alignment: .bottomTrailing) {
            if notice.isVisible {
                PerformanceNoticeCard(notice: notice)
                    .padding(16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        #else
        // A native alert blocks touch and accessibility focus behind it, stays
        // centered, and handles Dynamic Type. Only an explicit choice marks
        // it seen; a system presentation dismissal must not imply consent.
        content.alert(PerformanceNoticeCopy.title, isPresented: Binding(
            get: { notice.isVisible },
            set: { _ in }
        )) {
            Button("Don't Share") { notice.choose(share: false) }
                .accessibilityIdentifier("performance-notice-decline")
            Button("OK") { notice.choose(share: true) }
                .accessibilityIdentifier("performance-notice-ok")
        } message: {
            Text(verbatim: "\(PerformanceNoticeCopy.explanation)\n\n\(PerformanceNoticeCopy.settingsHint)")
        }
        #endif
    }
}

/// Whether the app's own notification permission request is on screen
/// (PushManager on iOS, MacNotifications on Mac). Main thread.
enum NotificationPermissionPrompt {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var open = 0
    static var isOpen: Bool { lock.withLock { open > 0 } }
    static func began() { lock.withLock { open += 1 } }
    static func ended() { lock.withLock { open = max(0, open - 1) } }
}
