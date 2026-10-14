/// PairingSheet — "Connect your phone", driven by `kraki connect --json`.
///
/// One glass card: the QR code, one line of instructions, a quiet "copy link".
/// The code renews itself before it expires, and when a phone (or browser)
/// joins the account while the card is open it turns into a check mark and
/// closes on its own.

#if os(macOS)
import SwiftUI
import CoreImage.CIFilterBuiltins
import AppKit

struct PairingSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.dismiss) private var dismiss

    @State private var payload: TentacleCLIManager.PairingPayload?
    @State private var error: String?
    @State private var loading = false
    @State private var copied = false
    @State private var connected: DeviceSummary?
    /// App devices already online when the card opened; anything new is "the phone".
    @State private var baseline: Set<String> = []
    /// Signed pairing state captured before exposing a code, never from a
    /// late list that might already include the phone that just scanned it.
    @State private var trustedBaseline: [TrustedDeviceEntry]?
    @State private var loadAttempt = 0
    private var previewPayload: TentacleCLIManager.PairingPayload?
    private var previewConnected: DeviceSummary?

    init() {}
    #if DEBUG
    init(preview: TentacleCLIManager.PairingPayload, connected: DeviceSummary? = nil) {
        previewPayload = preview
        previewConnected = connected
        _payload = State(initialValue: preview)
        _connected = State(initialValue: connected)
    }
    #endif

    private static let width: CGFloat = 340

    private var onlineApps: [DeviceSummary] {
        appState.deviceStore.devices.values.filter { $0.role == .app && $0.online && $0.id != appState.deviceId }
    }

    /// Apps this Mac's computer reports as paired (when this app is paired with it).
    private var trustedApps: [TrustedDeviceEntry]? {
        guard let local = AppState.localTentacleId, let info = appState.deviceTrust.info[local] else { return nil }
        return info.devices.filter { $0.id != appState.deviceId }
    }

    private var requiresTrustedBaseline: Bool {
        guard let local = AppState.localTentacleId else { return false }
        return appState.trustState(for: local) == .paired || !presenceMeansConnected
    }

    /// An existing account phone may keep its id; an already-trusted phone
    /// that pairs again changes pairedAt. Neither depends on wall-clock slack.
    static func newlyPaired(_ entries: [TrustedDeviceEntry], baseline: [TrustedDeviceEntry]) -> String? {
        entries.first { entry in
            !baseline.contains { $0.id == entry.id && $0.pairedAt == entry.pairedAt }
        }?.id
    }

    /// A newly online app counts as "connected" only when the computer is
    /// known not to require pairing.
    private var presenceMeansConnected: Bool {
        guard let local = AppState.localTentacleId else { return true }
        if let info = appState.deviceTrust.info[local] { return !info.enforced }
        switch appState.trustState(for: local) {
        case .unsupported, .notPaired: return true
        default: return false
        }
    }

    /// The computer only serves paired apps: "connected" means "paired".
    private var waitsForPairing: Bool {
        guard let local = AppState.localTentacleId else { return false }
        return appState.deviceTrust.info[local]?.enforced == true
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            VStack(spacing: 0) {
                if let connected {
                    success(connected)
                } else {
                    content
                }
            }
            .padding(.horizontal, 28)
            .padding(.top, 30)
            .padding(.bottom, 24)
            .frame(width: Self.width)

            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.textMuted)
                    .frame(width: 22, height: 22)
                    .background(Circle().fill(Color.textPrimary.opacity(0.08)))
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .padding(12)
            .help("Close (Esc)")
        }
        .background { cardBackground }
        .presentationBackground(.clear)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: connected?.id)
        .task(id: loadAttempt) {
            baseline = Set(onlineApps.map(\.id))
            if let local = AppState.localTentacleId { appState.requestTrustedDevices(local) }
            if previewPayload == nil { await renewLoop() }
        }
        .onChange(of: onlineApps.map(\.id).sorted()) { _, ids in
            guard payload != nil else { return }
            if let entries = trustedApps, let known = trustedBaseline,
               let newId = Self.newlyPaired(entries, baseline: known) {
                markConnected(newId)
            }
            guard presenceMeansConnected else { return }
            guard let newId = ids.first(where: { !baseline.contains($0) }) else { return }
            markConnected(newId)
        }
        .onChange(of: trustedApps) { _, entries in
            guard payload != nil, let entries, let known = trustedBaseline,
                  let newId = Self.newlyPaired(entries, baseline: known) else { return }
            markConnected(newId)
        }
    }

    @ViewBuilder
    private var cardBackground: some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        if #available(macOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(.regularMaterial)
        }
    }

    // MARK: States

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 18) {
            VStack(spacing: 5) {
                Text("Connect your phone")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.textPrimary)
                Text("Scan with your phone’s camera. Your sessions show up there — no sign-in needed.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(Color.white)
                    .frame(width: 212, height: 212)
                if let p = payload, let img = qrImage(for: p.url) {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: 184, height: 184)
                        .opacity(loading ? 0.15 : 1)
                        .transition(.opacity)
                }
                if loading {
                    ProgressView().controlSize(.small).tint(.black)
                } else if error != nil {
                    VStack(spacing: 10) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 20))
                            .foregroundStyle(Color(hex: 0xC2410C))
                        Button("Try again") { loadAttempt += 1 }
                            .controlSize(.small)
                    }
                }
            }
            .animation(.easeInOut(duration: 0.25), value: payload?.token)
            .shadow(color: .black.opacity(0.12), radius: 10, y: 3)

            if let error {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.textMuted)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            } else {
                HStack(spacing: 14) {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text("Waiting for your phone")
                    }
                    .foregroundStyle(Color.textMuted)
                    Button {
                        if let p = payload { KrakiPasteboard.setString(p.url); copied = true }
                    } label: {
                        Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "link")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.krakiPrimary)
                    .disabled(payload == nil)
                    .help(payload?.url ?? "")
                }
                .font(.system(size: 11.5))
            }
        }
    }

    private func markConnected(_ id: String) {
        guard connected == nil, previewPayload == nil,
              let device = appState.deviceStore.devices[id] else { return }
        connected = device
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { dismiss() }
    }

    private func success(_ device: DeviceSummary) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(Color(hex: 0x34D399))
                .symbolEffect(.bounce, value: device.id)
            Text("Connected")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Text(waitsForPairing
                 ? "\(device.name) is paired with this Mac and can now see and run your sessions."
                 : "\(device.name) can now see and run your sessions.")
                .font(.system(size: 12))
                .foregroundStyle(Color.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(height: 300)
        .transition(.scale(scale: 0.9).combined(with: .opacity))
    }

    // MARK: Code lifecycle

    /// Fetch a code, and fetch a fresh one shortly before each expires, for
    /// as long as the card is open and nothing has connected.
    private func renewLoop() async {
        while !Task.isCancelled, connected == nil {
            await load()
            guard let p = payload else { return } // error: wait for "Try again"
            let wait = max(5, p.expiresAt.timeIntervalSinceNow - 10)
            try? await Task.sleep(for: .seconds(wait))
        }
    }

    private func load() async {
        loading = true
        error = nil
        copied = false
        do {
            if requiresTrustedBaseline && trustedBaseline == nil {
                payload = nil
                payload = try await Self.withTrustedBaseline(read: { trustedApps }, pause: {
                    try await Task.sleep(for: .milliseconds(100))
                }) { entries in
                    trustedBaseline = entries
                    return try await tentacleCLI.requestPairingPayload()
                }
            } else {
                if trustedBaseline == nil { trustedBaseline = trustedApps }
                payload = try await tentacleCLI.requestPairingPayload()
            }
        } catch is CancellationError {
            // Dismissal/retry cancels the task; do not turn it into a UI error.
        } catch {
            payload = nil
            self.error = error.localizedDescription
        }
        loading = false
    }

    /// No code (including a copyable link) is created on timeout. Retry uses
    /// this same gate; the baseline is installed before code generation.
    static func withTrustedBaseline<T>(
        read: () -> [TrustedDeviceEntry]?,
        pause: () async throws -> Void,
        create: ([TrustedDeviceEntry]) async throws -> T
    ) async throws -> T {
        for attempt in 0...30 {
            try Task.checkCancellation()
            if let entries = read() { return try await create(entries) }
            if attempt < 30 { try await pause() }
        }
        throw BaselineError.unavailable
    }

    enum BaselineError: LocalizedError {
        case unavailable
        var errorDescription: String? {
            "Could not load this Mac’s trusted devices. Check the connection and try again."
        }
    }

    private func qrImage(for string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.setValue(Data(string.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let rep = NSCIImageRep(ciImage: scaled)
        let nsImage = NSImage(size: rep.size)
        nsImage.addRepresentation(rep)
        return nsImage
    }
}

#endif
