/// MacSetupIntro — the first-open entrance before setup, matching the web
/// (index.css `animate-logo-reveal`) and iOS LoginView: the Kraki logo
/// surfaces through a circle-clip reveal (0→75%, 4 s, cubic-bezier(0.16,1,0.3,1))
/// while blurring to clear (3 s); the wordmark and tagline fade up after 1 s
/// and 1.3 s. Then it hands over to the setup card.
///
/// Shown once per Mac (UserDefaults `setup.introShown`): not again after the
/// Quit & Reopen that Full Disk Access forces. A click skips it; Reduce
/// Motion skips it entirely.

#if os(macOS)
import SwiftUI

struct MacSetupIntro: View {
    static let shownKey = "setup.introShown"

    let onFinished: () -> Void

    @State private var clip: CGFloat = 0
    @State private var blur: CGFloat = 12
    @State private var logoOpacity: Double = 0
    @State private var showTitle = false
    @State private var showTagline = false
    @State private var leaving = false

    var body: some View {
        VStack(spacing: 0) {
            Image("KrakiLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 160, height: 160)
                .blur(radius: blur)
                .opacity(logoOpacity)
                .clipShape(Circle().scale(clip))
                .padding(.bottom, 18)

            Text("KRAKI")
                .font(.system(size: 26, weight: .heavy, design: .monospaced))
                .tracking(4.6)
                .foregroundStyle(Color.textTitle)
                .opacity(showTitle ? 1 : 0)
                .offset(y: showTitle ? 0 : 8)

            Text("Your coding agents, on every device")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Color.textSecondary)
                .padding(.top, 6)
                .opacity(showTagline ? 1 : 0)
                .offset(y: showTagline ? 0 : 8)
        }
        .scaleEffect(leaving ? 0.96 : 1)
        .opacity(leaving ? 0 : 1)
        .offset(y: leaving ? -24 : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { finish() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Kraki")
        .task { await run() }
    }

    @MainActor
    private func run() async {
        withAnimation(.timingCurve(0.16, 1, 0.3, 1, duration: 4)) { clip = 1.5 }
        withAnimation(.easeOut(duration: 3)) { blur = 0; logoOpacity = 1 }
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 1)) { showTitle = true }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        withAnimation(.easeOut(duration: 1)) { showTagline = true }
        // Let the logo settle, then hand over to setup.
        try? await Task.sleep(for: .milliseconds(1900))
        guard !Task.isCancelled else { return }
        finish()
    }

    private func finish() {
        guard !leaving else { return }
        UserDefaults.standard.set(true, forKey: Self.shownKey)
        withAnimation(.easeInOut(duration: 0.45)) { leaving = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { onFinished() }
    }
}

#endif
