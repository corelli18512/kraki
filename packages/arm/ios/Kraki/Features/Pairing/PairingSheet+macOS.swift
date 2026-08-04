/// PairingSheet — Mac pairing sheet driven by `kraki connect --json`.
///
/// Flow:
///   1. User taps "Pair a device" (sidebar, welcome card, or menu).
///   2. Sheet calls TentacleCLIManager.requestPairingPayload().
///   3. Sheet renders the resulting URL + QR code + countdown timer.
///   4. User scans on the other device OR clicks "Copy URL" + paste.

#if os(macOS)
import SwiftUI
import CoreImage.CIFilterBuiltins
import AppKit

struct PairingSheet: View {
    @Environment(TentacleCLIManager.self) private var tentacleCLI
    @Environment(\.dismiss) private var dismiss

    @State private var payload: TentacleCLIManager.PairingPayload?
    @State private var error: String?
    @State private var loading: Bool = false
    @State private var now: Date = Date()

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()
                .overlay(Color.borderPrimary)

            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 24)
                .padding(.vertical, 20)

            Divider()
                .overlay(Color.borderPrimary)

            footer
        }
        .frame(width: 440, height: 540)
        .background(Color.surfacePrimary)
        .task { await load() }
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: "qrcode")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.krakiPrimary)
            Text("Pair a Device")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.textPrimary)
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(Color.surfaceSecondary)
    }

    private var footer: some View {
        HStack {
            Button("Refresh") {
                Task { await load() }
            }
            .disabled(loading)
            Spacer()
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(Color.surfaceSecondary)
    }

    @ViewBuilder
    private var content: some View {
        if let error {
            VStack(spacing: 12) {
                Image(systemName: "xmark.octagon.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(Color(hex: 0xF4836E))
                Text(error)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.krakiPrimary)
            }
        } else if loading || payload == nil {
            VStack(spacing: 10) {
                ProgressView()
                    .controlSize(.regular)
                Text("Requesting pairing code…")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
            }
        } else if let p = payload {
            VStack(spacing: 16) {
                if let img = qrImage(for: p.url) {
                    Image(nsImage: img)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: 220, height: 220)
                        .padding(12)
                        .background(Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(Color.borderPrimary, lineWidth: 1)
                        )
                }

                Text("Scan with Kraki on another device, or copy the URL below.")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.textSecondary)
                    .multilineTextAlignment(.center)

                HStack(spacing: 8) {
                    Text(p.url)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.textPrimary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        KrakiPasteboard.setString(p.url)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .foregroundStyle(Color.krakiPrimary)
                    }
                    .buttonStyle(.borderless)
                    .help("Copy URL")
                }
                .padding(10)
                .background(Color.surfaceSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Color.borderPrimary, lineWidth: 1)
                )

                HStack(spacing: 6) {
                    Image(systemName: "clock.fill")
                        .font(.system(size: 10, weight: .semibold))
                    Text(expiryString(for: p))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                }
                .foregroundStyle(p.expiresAt.timeIntervalSince(now) < 60 ? Color(hex: 0xFBBF24) : Color.textMuted)
            }
        }
    }

    private func load() async {
        loading = true
        error = nil
        payload = nil
        do {
            payload = try await tentacleCLI.requestPairingPayload()
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func expiryString(for p: TentacleCLIManager.PairingPayload) -> String {
        let remaining = max(0, Int(p.expiresAt.timeIntervalSince(now)))
        let m = remaining / 60
        let s = remaining % 60
        return remaining > 0 ? String(format: "Expires in %d:%02d", m, s) : "Expired"
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
