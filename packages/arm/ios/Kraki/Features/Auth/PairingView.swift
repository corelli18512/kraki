#if os(iOS)
import SwiftUI
import AVFoundation

/// QR code scanner for pairing with a coding machine.
///
/// Wraps AVCaptureMetadataOutput in a UIViewControllerRepresentable to scan
/// QR codes containing a pairing URL with a token query parameter.
struct PairingView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    @State private var scannedToken: String?
    @State private var showManualEntry = false
    @State private var manualURL = ""
    @State private var cameraPermission: AVAuthorizationStatus = .notDetermined
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ZStack {
                // Camera preview
                if cameraPermission == .authorized {
                    CodeScannerView { result in
                        handleScanResult(result)
                    }
                    .ignoresSafeArea()

                    // Scanning frame overlay
                    scanningOverlay
                } else if cameraPermission == .denied || cameraPermission == .restricted {
                    cameraPermissionDeniedView
                } else {
                    ProgressView("Requesting camera access…")
                }

                // Error toast
                if let error = errorMessage {
                    VStack {
                        Spacer()
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.red.opacity(0.85), in: Capsule())
                            .padding(.bottom, 100)
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .bottomBar) {
                    Button("Enter URL manually") {
                        showManualEntry = true
                    }
                    .font(.footnote)
                }
            }
            .sheet(isPresented: $showManualEntry) {
                manualEntrySheet
            }
            .onAppear {
                checkCameraPermission()
            }
        }
    }

    // MARK: - Subviews

    private var scanningOverlay: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height) * 0.65
            let rect = CGRect(
                x: (geo.size.width - size) / 2,
                y: (geo.size.height - size) / 2,
                width: size,
                height: size
            )

            ZStack {
                // Dimmed border outside scanning area
                Rectangle()
                    .fill(.black.opacity(0.4))
                    .reverseMask {
                        RoundedRectangle(cornerRadius: 16)
                            .frame(width: rect.width, height: rect.height)
                    }

                // Corner brackets
                RoundedRectangle(cornerRadius: 16)
                    .stroke(.white, lineWidth: 3)
                    .frame(width: rect.width, height: rect.height)

                VStack {
                    Spacer()
                    Text("Point at a Kraki QR code")
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .padding(.bottom, 60)
                }
            }
        }
    }

    private var cameraPermissionDeniedView: some View {
        VStack(spacing: 16) {
            Image(systemName: "camera.fill")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("Camera Access Required")
                .font(.headline)
            Text("Open Settings to allow camera access for QR code scanning.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(32)
    }

    private var manualEntrySheet: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Pairing URL", text: $manualURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("Paste the pairing URL from your terminal.")
                }
            }
            .navigationTitle("Manual Entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showManualEntry = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") {
                        if let token = extractPairingToken(from: manualURL) {
                            showManualEntry = false
                            completePairing(token: token)
                        } else {
                            errorMessage = "Invalid pairing URL"
                        }
                    }
                    .disabled(manualURL.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Logic

    private func checkCameraPermission() {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        cameraPermission = status
        if status == .notDetermined {
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    cameraPermission = granted ? .authorized : .denied
                }
            }
        }
    }

    private func handleScanResult(_ result: Result<String, CodeScannerError>) {
        switch result {
        case .success(let code):
            if let token = extractPairingToken(from: code) {
                completePairing(token: token)
            } else {
                withAnimation {
                    errorMessage = "Not a valid Kraki pairing code"
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    withAnimation { errorMessage = nil }
                }
            }
        case .failure:
            withAnimation {
                errorMessage = "Failed to read QR code"
            }
        }
    }

    private func extractPairingToken(from urlString: String) -> String? {
        guard let url = URL(string: urlString),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else {
            return nil
        }
        return token
    }

    private func completePairing(token: String) {
        scannedToken = token
        appState.authManager?.authenticateWithPairingToken(token)
        dismiss()
    }
}

// MARK: - Reverse Mask Modifier

private extension View {
    func reverseMask<Mask: View>(@ViewBuilder _ mask: () -> Mask) -> some View {
        self.mask {
            Rectangle()
                .overlay {
                    mask()
                        .blendMode(.destinationOut)
                }
        }
    }
}

// MARK: - Code Scanner

enum CodeScannerError: Error {
    case cameraUnavailable
    case scanFailed
}

/// UIViewControllerRepresentable wrapping AVCaptureMetadataOutput for QR scanning.
struct CodeScannerView: UIViewControllerRepresentable {
    let completion: (Result<String, CodeScannerError>) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onScan = completion
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerViewController, context: Context) {}
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((Result<String, CodeScannerError>) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasReported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        setupCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        if !captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.captureSession.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // `stopRunning()` is a synchronous, potentially blocking call —
        // doing it on the main thread can briefly freeze the UI when
        // the user dismisses the pairing sheet. Move it to the same
        // background queue we use for startRunning().
        if captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [captureSession] in
                captureSession.stopRunning()
            }
        }
    }

    private func setupCamera() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            onScan?(.failure(.cameraUnavailable))
            return
        }

        if captureSession.canAddInput(input) {
            captureSession.addInput(input)
        }

        let output = AVCaptureMetadataOutput()
        if captureSession.canAddOutput(output) {
            captureSession.addOutput(output)
            // Deliver metadata on a dedicated background queue so the
            // capture pipeline isn't stalled by main-thread work; we
            // hop back to main inside the delegate for UI callbacks.
            output.setMetadataObjectsDelegate(self, queue: DispatchQueue(label: "kraki.qr.metadata"))
            output.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: captureSession)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasReported,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else {
            return
        }
        hasReported = true
        // Stop the session off-main and hop back to main for haptics
        // and the SwiftUI callback. Otherwise the synchronous
        // stopRunning() blocks the UI for a frame on dismiss.
        DispatchQueue.global(qos: .userInitiated).async { [captureSession] in
            captureSession.stopRunning()
        }
        DispatchQueue.main.async { [weak self] in
            let generator = UINotificationFeedbackGenerator()
            generator.notificationOccurred(.success)
            self?.onScan?(.success(value))
        }
    }
}

#endif
