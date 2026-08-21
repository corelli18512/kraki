#if os(iOS)
import Observation
import SwiftUI
import UIKit

/// Process-scoped iOS launch routing. Returning users first mount the Sessions
/// shell underneath a branded gate; the gate leaves only after UIKit has
/// attached and laid out the real surface. Login/logout transitions remain
/// immediate and do not replay the cold-launch screen.
@Observable
@MainActor
final class IOSLaunchCoordinator {
    enum Phase: Equatable {
        case launching
        case preparingAuthenticated
        case authenticated
        case signedOut
    }

    private(set) var phase: Phase = .launching

    var isLaunchGateVisible: Bool {
        phase == .launching || phase == .preparingAuthenticated
    }

    @ObservationIgnored private var hasStarted = false
    @ObservationIgnored private var launchStartedAt: Date?
    @ObservationIgnored private var isFinishingAuthenticatedSurface = false
    @ObservationIgnored private var presentationWatchdogTask: Task<Void, Never>?
    @ObservationIgnored private let minimumVisibleSecondsOverride: TimeInterval?
    @ObservationIgnored private let presentationWatchdogSecondsOverride: TimeInterval?

    init(
        minimumVisibleSecondsOverride: TimeInterval? = nil,
        presentationWatchdogSecondsOverride: TimeInterval? = nil
    ) {
        self.minimumVisibleSecondsOverride = minimumVisibleSecondsOverride
        self.presentationWatchdogSecondsOverride = presentationWatchdogSecondsOverride
    }

    func bootstrap(appState: AppState) async {
        guard !hasStarted else { return }
        hasStarted = true
        launchStartedAt = Date()
        KLog.diag("[IOSLaunch] gate presented")

        // Start auth/network work while the gate owns the screen. Stored
        // credentials determine routing; network availability never blocks the
        // gate because the authenticated shell can continue offline from cache.
        if appState.connectionStatus == .awaitingLogin {
            appState.connect()
        }

        if appState.hasStoredCredentials {
            beginPreparingAuthenticatedSurface()
        } else {
            await waitForMinimumLaunchVisibility()
            guard !Task.isCancelled else {
                hasStarted = false
                return
            }
            phase = .signedOut
            logDestination("signedOut")
        }
    }

    func authenticatedSurfaceDidPresent() async {
        presentationWatchdogTask?.cancel()
        presentationWatchdogTask = nil
        await finishAuthenticatedSurface(source: "probe")
    }

    private func beginPreparingAuthenticatedSurface() {
        phase = .preparingAuthenticated
        presentationWatchdogTask?.cancel()
        let watchdogSeconds = presentationWatchdogSecondsOverride ?? 2
        presentationWatchdogTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(watchdogSeconds))
            guard !Task.isCancelled, let self,
                  self.phase == .preparingAuthenticated else { return }
            self.presentationWatchdogTask = nil
            KLog.diag("[IOSLaunch] presentation watchdog fired")
            await self.finishAuthenticatedSurface(source: "watchdog")
        }
    }

    private func finishAuthenticatedSurface(source: String) async {
        guard phase == .preparingAuthenticated,
              !isFinishingAuthenticatedSurface else { return }
        isFinishingAuthenticatedSurface = true
        defer { isFinishingAuthenticatedSurface = false }

        await waitForMinimumLaunchVisibility()
        guard !Task.isCancelled, phase == .preparingAuthenticated else { return }
        phase = .authenticated
        logDestination("authenticated source=\(source)")
    }

    func reconcileAuthentication(
        hasStoredCredentials: Bool,
        connectionStatus: ConnectionStatus
    ) {
        guard phase != .launching else { return }
        if hasStoredCredentials {
            if phase == .signedOut {
                launchStartedAt = Date()
                beginPreparingAuthenticatedSurface()
            }
        } else if connectionStatus == .awaitingLogin,
                  phase == .authenticated || phase == .preparingAuthenticated {
            presentationWatchdogTask?.cancel()
            presentationWatchdogTask = nil
            phase = .signedOut
        }
    }

    private func waitForMinimumLaunchVisibility() async {
        let startedAt = launchStartedAt ?? Date()
        #if DEBUG
        let minimumVisibleSeconds = minimumVisibleSecondsOverride
            ?? ProcessInfo.processInfo.environment["KRAKI_IOS_LAUNCH_MIN_MS"]
                .flatMap(Double.init)
                .map { max(0, $0 / 1_000) }
            ?? 0.35
        #else
        let minimumVisibleSeconds = minimumVisibleSecondsOverride ?? 0.35
        #endif
        let remaining = minimumVisibleSeconds - Date().timeIntervalSince(startedAt)
        if remaining > 0 {
            try? await Task.sleep(for: .seconds(remaining))
        }
    }

    private func logDestination(_ destination: String) {
        let elapsedMs = launchStartedAt.map { Date().timeIntervalSince($0) * 1_000 } ?? 0
        KLog.diag(
            "[IOSLaunch] destination=\(destination) "
                + String(format: "elapsedMs=%.1f", elapsedMs)
        )
    }
}

/// Root coordinator: shows the cold-launch gate, login, or main tab bar.
struct RootView: View {
    @Environment(AppState.self) private var appState
    let launchCoordinator: IOSLaunchCoordinator

    var body: some View {
        ZStack {
            Color.surfacePrimary
                .ignoresSafeArea()

            #if DEBUG
            if ProcessInfo.processInfo.environment["KRAKI_AVATAR_TEST"] == "1" {
                AvatarTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_BUBBLE_CATALOG"] == "1" {
                BubbleCatalogTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_FLATBUBBLE"] == "1" {
                FlatBubbleTestView()
            } else if ProcessInfo.processInfo.environment["KRAKI_LIVEBUBBLE"] == "1" {
                NavigationStack { LiveBubbleTestView() }
            } else if ProcessInfo.processInfo.environment["KRAKI_IOS_ENTRY_GATE_PAGE"] == "1" {
                IOSEntryGateView()
            } else {
                productionRoot
            }
            #else
            productionRoot
            #endif
        }
        .animation(.easeInOut(duration: 0.16), value: launchCoordinator.isLaunchGateVisible)
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["KRAKI_IOS_ENTRY_GATE_PAGE"] == "1" {
                return
            }
            #endif
            await launchCoordinator.bootstrap(appState: appState)
        }
        .onChange(of: appState.hasStoredCredentials) { _, hasStoredCredentials in
            launchCoordinator.reconcileAuthentication(
                hasStoredCredentials: hasStoredCredentials,
                connectionStatus: appState.connectionStatus
            )
        }
        .onChange(of: appState.connectionStatus) { _, connectionStatus in
            launchCoordinator.reconcileAuthentication(
                hasStoredCredentials: appState.hasStoredCredentials,
                connectionStatus: connectionStatus
            )
        }
    }

    @ViewBuilder
    private var productionRoot: some View {
        switch launchCoordinator.phase {
        case .launching, .preparingAuthenticated, .authenticated:
            ZStack {
                if launchCoordinator.phase != .launching {
                    MainTabView(
                        allowsInitialNavigation: launchCoordinator.phase == .authenticated
                    )
                    .allowsHitTesting(launchCoordinator.phase == .authenticated)
                    .accessibilityHidden(launchCoordinator.phase != .authenticated)
                    .background(
                        IOSLaunchPresentationReadyProbe {
                            Task {
                                await launchCoordinator.authenticatedSurfaceDidPresent()
                            }
                        }
                    )
                }

                if launchCoordinator.isLaunchGateVisible {
                    IOSEntryGateView()
                        .transition(.opacity)
                        .zIndex(10)
                }
            }
        case .signedOut:
            LoginView()
                .transition(.opacity)
        }
    }
}

/// In-app continuation of the system launch screen. It intentionally matches
/// the Mac brand shell while adapting spacing and scale for an iPhone viewport.
struct IOSEntryGateView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var showDelayedLaunchStatus = false

    var body: some View {
        ZStack {
            Color.surfacePrimary
                .ignoresSafeArea()

            ZStack {
                Circle()
                    .fill(Color.krakiPrimary.opacity(0.10))
                    .frame(width: 360, height: 360)
                    .blur(radius: 68)
                    .offset(x: 150, y: -240)

                Circle()
                    .fill(Color.cyan.opacity(0.06))
                    .frame(width: 320, height: 320)
                    .blur(radius: 76)
                    .offset(x: -170, y: 260)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)

            VStack(spacing: 0) {
                Spacer(minLength: 72)

                VStack(spacing: 16) {
                    Image("KrakiLogo")
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 108, height: 108)
                        .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
                        .shadow(color: Color.black.opacity(0.22), radius: 24, y: 12)
                        .scaleEffect(appeared ? 1 : 0.97)
                        .opacity(appeared ? 1 : 0)

                    VStack(spacing: 6) {
                        Text("KRAKI")
                            .font(.system(size: 23, weight: .heavy, design: .monospaced))
                            .tracking(4.0)
                            .foregroundStyle(Color.textTitle)

                        Text("Your coding sessions, ready when you are.")
                            .font(.system(size: 12.5, weight: .medium))
                            .foregroundStyle(Color.textSecondary)
                            .multilineTextAlignment(.center)
                    }
                    .opacity(appeared ? 1 : 0)
                    .offset(y: appeared ? 0 : 5)
                }

                Group {
                    if showDelayedLaunchStatus {
                        HStack(spacing: 9) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Opening Kraki…")
                                .font(.system(size: 11.5, weight: .medium))
                                .foregroundStyle(Color.textMuted)
                        }
                        .transition(.opacity)
                        .accessibilityLabel("Opening Kraki")
                    } else {
                        Color.clear
                    }
                }
                .frame(height: 54)
                .padding(.top, 20)

                Spacer(minLength: 48)
            }
            .padding(.horizontal, 36)
        }
        .accessibilityIdentifier("ios.entry.launching")
        .accessibilityElement(children: .contain)
        .task {
            if reduceMotion {
                appeared = true
            } else {
                withAnimation(.easeOut(duration: 0.24)) {
                    appeared = true
                }
            }

            showDelayedLaunchStatus = false
            try? await Task.sleep(for: .milliseconds(550))
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.16)) {
                showDelayedLaunchStatus = true
            }
        }
    }
}

/// Reports readiness only after the real UIKit hierarchy is attached and has
/// completed a window-backed layout pass. The launch overlay stays painted
/// while that synchronous first materialization runs underneath it.
private struct IOSLaunchPresentationReadyProbe: UIViewRepresentable {
    let onReady: () -> Void

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.onReady = onReady
        return view
    }

    func updateUIView(_ uiView: ProbeView, context: Context) {
        uiView.onReady = onReady
        uiView.signalWhenReady()
    }

    final class ProbeView: UIView {
        var onReady: (() -> Void)?
        private var didSignal = false

        override func didMoveToWindow() {
            super.didMoveToWindow()
            signalWhenReady()
        }

        func signalWhenReady() {
            guard window != nil, !didSignal else { return }
            didSignal = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.window?.layoutIfNeeded()
                DispatchQueue.main.async { [weak self] in
                    self?.onReady?()
                }
            }
        }
    }
}

#endif
