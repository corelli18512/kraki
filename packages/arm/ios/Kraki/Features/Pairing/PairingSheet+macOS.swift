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
        .task {
            baseline = Set(onlineApps.map(\.id))
            if previewPayload == nil { await renewLoop() }
        }
        .onChange(of: onlineApps.map(\.id).sorted()) { _, ids in
            guard connected == nil, previewPayload == nil,
                  let newId = ids.first(where: { !baseline.contains($0) }),
                  let device = appState.deviceStore.devices[newId] else { return }
            connected = device
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { dismiss() }
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
                        Button("Try again") { Task { await load() } }
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

    private func success(_ device: DeviceSummary) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundStyle(Color(hex: 0x34D399))
                .symbolEffect(.bounce, value: device.id)
            Text("Connected")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Text("\(device.name) can now see and run your sessions.")
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
            payload = try await tentacleCLI.requestPairingPayload()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
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
