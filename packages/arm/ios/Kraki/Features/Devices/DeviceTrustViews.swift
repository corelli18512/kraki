/// Device-trust UI shared by iOS and macOS: status badges, a computer's
/// security settings, the "needs pairing" banner and pairing feedback.
/// See App/AppState+DeviceTrust.swift for the state behind it.

import SwiftUI

extension Text {
    /// Copy that marks commands with backticks (`kraki connect`) renders them as code.
    init(trustCopy: String) {
        self.init((try? AttributedString(markdown: trustCopy)) ?? AttributedString(trustCopy))
    }
}

// MARK: - Status

extension ComputerTrustState {
    var title: String {
        switch self {
        case .paired: return "Paired"
        case .pairing: return "Pairing…"
        case .failed: return "Pairing failed"
        case .needsPairing: return "Needs pairing"
        case .notPaired: return "Not paired"
        case .unsupported: return "Update needed"
        case .stoppedSigning: return "Not signing"
        }
    }

    var symbol: String {
        switch self {
        case .paired: return "lock.shield.fill"
        case .pairing: return "hourglass"
        case .failed: return "exclamationmark.shield.fill"
        case .needsPairing: return "lock.open.fill"
        case .notPaired: return "shield.slash"
        case .unsupported: return "arrow.down.circle"
        case .stoppedSigning: return "exclamationmark.shield.fill"
        }
    }

    var tint: Color {
        switch self {
        case .paired: return Color(hex: 0x10B981)
        case .pairing: return .secondary
        case .failed: return Color(hex: 0xDC2626)
        case .needsPairing: return Color(hex: 0xD97706)
        case .notPaired, .unsupported: return .secondary
        case .stoppedSigning: return Color(hex: 0xD97706)
        }
    }

    /// One sentence for the security section.
    /// `enforced`: the computer confirmed "Only paired devices" (nil: unknown).
    func explanation(computer: String, online: Bool = true, enforced: Bool? = nil) -> String {
        switch self {
        case .paired where enforced == true:
            return "Messages with \(computer) are signed and end-to-end encrypted to keys exchanged when you scanned its code, and it only accepts paired devices. Kraki's servers can't read your sessions or send commands in your name."
        case .paired:
            return "This device's messages with \(computer) are signed and end-to-end encrypted to keys exchanged when you scanned its code. Until \"Only paired devices\" is on, other devices on your account — or a compromised Kraki server — can still connect to \(computer)."
        case .pairing:
            return online
                ? "Confirming the pairing with \(computer)…"
                : "\(computer) is offline. Pairing finishes automatically when it's back online."
        case .failed(let reason):
            return PairingFailureText.describe(reason)
        case .needsPairing:
            return "\(computer) only accepts devices paired with it. Run `kraki connect` on it and scan the code."
        case .notPaired:
            return "Not paired yet. Pairing makes this device's messages with \(computer) signed and end-to-end encrypted to keys you exchange in person: run `kraki connect` on it and scan the code."
        case .unsupported:
            return "Update Kraki on \(computer) to pair this device with it."
        case .stoppedSigning:
            return "\(computer) is sending messages without its signature, so Kraki ignores them. This happens when Kraki on \(computer) was downgraded to an older version: update it again, or forget the pairing to keep using it without device trust. If you didn't change anything there, keep the pairing."
        }
    }

    var needsAction: Bool {
        switch self {
        case .failed, .needsPairing, .notPaired, .stoppedSigning: return true
        default: return false
        }
    }
}

/// Small icon + label for device rows.
struct TrustStatusBadge: View {
    let state: ComputerTrustState
    var compact = false

    var body: some View {
        Label {
            if !compact { Text(state.title) }
        } icon: {
            Image(systemName: state.symbol)
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(state.tint)
        .labelStyle(.titleAndIcon)
        .help(state.title)
        .accessibilityLabel(state.title)
        .accessibilityIdentifier("trust.badge")
    }
}

// MARK: - Security section

/// A computer's security settings, as rows for a List/Form section.
/// `onPair` opens the platform's pairing flow (QR scanner / paste link).
struct ComputerSecurityRows: View {
    @Environment(AppState.self) private var appState
    let device: DeviceSummary
    var onPair: (() -> Void)?

    @State private var revoking: TrustedDeviceEntry?
    @State private var confirmForget = false

    private var state: ComputerTrustState { appState.trustState(for: device.id) }
    private var info: ComputerTrustInfo? { appState.deviceTrust.info[device.id] }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Pairing").foregroundStyle(.secondary)
            Spacer()
            TrustStatusBadge(state: state)
        }
        Text(trustCopy: state.explanation(computer: device.name, online: device.online, enforced: info?.enforced))
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)

        if let code = appState.safetyCode(for: device.id) {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("Safety code").foregroundStyle(.secondary)
                    Spacer()
                    Text(code)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier("trust.safetyCode")
                }
                Text("Should match the code `kraki devices` shows on \(device.name).")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }

        if state == .paired, let info {
            Toggle(isOn: Binding(
                get: { info.pendingEnforce ?? info.enforced },
                set: { appState.setOnlyPairedDevices($0, on: device.id) }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("Only paired devices")
                        if info.pendingEnforce != nil {
                            ProgressView().controlSize(.mini)
                            Text("Applying…").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    // Describes what the computer confirmed, not the request.
                    Text(info.enforced
                         ? "Devices that haven't scanned this computer's code can't connect."
                         : "Any device signed in to your account can connect. Turn on once all your devices are paired.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if info.policyLocked {
                        Text("Set by the computer's configuration.").font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
            .disabled(info.policyLocked || info.pendingEnforce != nil)
            .accessibilityIdentifier("trust.enforceToggle")

            if !info.devices.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Devices that can control \(device.name)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(info.devices) { entry in
                        trustedRow(entry)
                    }
                }
                .padding(.vertical, 2)
            }
        }

        if state != .paired, state != .unsupported, state != .stoppedSigning, let onPair {
            Button(action: onPair) {
                Label(pairActionTitle, systemImage: pairActionSymbol)
            }
            .accessibilityIdentifier("trust.pairButton")
        }

        if TentacleTrustStore.shared.pin(device.id) != nil {
            Button(role: .destructive) { confirmForget = true } label: {
                Label("Forget Pairing", systemImage: "lock.open")
            }
            .foregroundStyle(Color(hex: 0xDC2626))
            .accessibilityIdentifier("trust.forgetButton")
            .confirmationDialog("Forget pairing with \(device.name)?", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("Forget Pairing", role: .destructive) { appState.forgetPairing(device.id) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This device goes back to an unpaired connection with \(device.name): its messages are no longer signed, and Kraki's servers are no longer kept out. You can pair again by scanning the computer's code.")
            }
        }
    }

    private var pairActionTitle: String {
        #if os(iOS)
        return "Scan Pairing Code"
        #else
        return device.id == AppState.localTentacleId ? "Pair Again" : "Paste Pairing Link…"
        #endif
    }

    private var pairActionSymbol: String {
        #if os(iOS)
        return "qrcode.viewfinder"
        #else
        return "link"
        #endif
    }

    private func trustedRow(_ entry: TrustedDeviceEntry) -> some View {
        HStack(spacing: 8) {
            Image(systemName: entry.via == "local" ? "desktopcomputer" : "qrcode")
                .foregroundStyle(.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(entry.name).lineLimit(1)
                    if entry.id == appState.deviceId {
                        Text("This device")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(Color.krakiPrimary)
                    }
                }
                Text(subtitle(entry))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Revoke", role: .destructive) { revoking = entry }
                .buttonStyle(.borderless)
                .foregroundStyle(Color(hex: 0xDC2626))
                .accessibilityIdentifier("trust.revoke.\(entry.id)")
        }
        .confirmationDialog(
            "Revoke \(revoking?.name ?? "device")?",
            isPresented: Binding(get: { revoking?.id == entry.id }, set: { if !$0 { revoking = nil } }),
            titleVisibility: .visible
        ) {
            Button("Revoke", role: .destructive) {
                appState.revokeTrustedDevice(entry.id, on: device.id)
                revoking = nil
            }
            Button("Cancel", role: .cancel) { revoking = nil }
        } message: {
            Text(revokeMessage(entry))
        }
    }

    private func revokeMessage(_ entry: TrustedDeviceEntry) -> String {
        let enforced = info?.enforced == true
        if entry.id == appState.deviceId {
            return enforced
                ? "This device will stop working with \(device.name) until you scan its code again."
                : "This device will no longer be paired with \(device.name). While \"Only paired devices\" is off, it can still connect unpaired."
        }
        return enforced
            ? "\(entry.name) will no longer see or control \(device.name). To use it again, scan the computer's code on it."
            : "\(entry.name) will no longer be paired. While \"Only paired devices\" is off, any device on your account — including it — can still connect. Turn that on to block it."
    }

    private func subtitle(_ entry: TrustedDeviceEntry) -> String {
        let via = entry.via == "local" ? "on this computer" : "by QR code"
        guard let date = DeviceDates.parse(entry.pairedAt) else { return "Paired \(via)" }
        return "Paired \(via), \(date.formatted(date: .abbreviated, time: .omitted))"
    }
}

// MARK: - Banner

/// "<computer> needs pairing" above the session list.
struct PairingNeededBanner: View {
    @Environment(AppState.self) private var appState
    var onPair: (DeviceSummary) -> Void
    @State private var confirmForget: DeviceSummary?

    private func bannerTitle(_ state: ComputerTrustState, _ device: DeviceSummary) -> String {
        switch state {
        case .needsPairing: return "Pair with \(device.name)"
        case .stoppedSigning: return "\(device.name) stopped signing its messages"
        default: return "Pairing with \(device.name) failed"
        }
    }

    var body: some View {
        if let device = appState.computersNeedingPairing.first {
            let state = appState.trustState(for: device.id)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: state.symbol)
                    .foregroundStyle(state.tint)
                    .font(.system(size: 15))
                VStack(alignment: .leading, spacing: 3) {
                    Text(bannerTitle(state, device))
                        .font(.system(size: 13, weight: .semibold))
                    Text(trustCopy: state == .needsPairing
                         ? "It only accepts devices paired with it. Run `kraki connect` there and scan the code."
                         : state.explanation(computer: device.name, online: device.online))
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if state == .stoppedSigning {
                        Button("Forget Pairing…") { confirmForget = device }
                            .font(.system(size: 12, weight: .semibold))
                            .buttonStyle(.borderless)
                            .padding(.top, 2)
                            .accessibilityIdentifier("trust.banner.forget")
                    } else {
                        Button(pairTitle) { onPair(device) }
                            .font(.system(size: 12, weight: .semibold))
                            .buttonStyle(.borderless)
                            .padding(.top, 2)
                            .accessibilityIdentifier("trust.banner.pair")
                    }
                }
                Spacer(minLength: 0)
                Button {
                    appState.deviceTrust.dismissedBanners.insert(device.id)
                } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .accessibilityLabel("Dismiss")
            }
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(state.tint.opacity(0.10))
            )
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .accessibilityIdentifier("trust.banner")
            .confirmationDialog("Forget pairing with \(confirmForget?.name ?? "")?",
                                isPresented: Binding(get: { confirmForget != nil }, set: { if !$0 { confirmForget = nil } }),
                                titleVisibility: .visible) {
                Button("Forget Pairing", role: .destructive) {
                    if let id = confirmForget?.id { appState.forgetPairing(id) }
                    confirmForget = nil
                }
                Button("Cancel", role: .cancel) { confirmForget = nil }
            } message: {
                Text("Only do this if you downgraded Kraki on that computer. This device then connects to it unpaired, and Kraki's servers are no longer kept out.")
            }
        }
    }

    private var pairTitle: String {
        #if os(iOS)
        return "Scan Code"
        #else
        return "Pair…"
        #endif
    }
}

// MARK: - Feedback

/// Transient "Pairing… / Paired / Failed" capsule after a scan or paste.
struct PairingFeedbackToast: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            if let feedback = appState.deviceTrust.feedback {
                content(feedback)
                    .id(feedback.id)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: feedback.id) {
                        let seconds: Double
                        switch feedback {
                        case .pairing: seconds = 20
                        case .paired: seconds = 2.5
                        case .failed: seconds = 8
                        }
                        try? await Task.sleep(for: .seconds(seconds))
                        if appState.deviceTrust.feedback == feedback {
                            withAnimation { appState.deviceTrust.feedback = nil }
                        }
                    }
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.85), value: appState.deviceTrust.feedback)
    }

    @ViewBuilder
    private func content(_ feedback: PairingFeedback) -> some View {
        HStack(spacing: 8) {
            switch feedback {
            case .pairing(let name):
                ProgressView().controlSize(.small)
                Text("Pairing with \(name)…")
            case .paired(let name):
                Image(systemName: "lock.shield.fill").foregroundStyle(Color(hex: 0x10B981))
                Text("Paired with \(name)")
            case .failed(let name, let reason):
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(Color(hex: 0xDC2626))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Couldn't pair with \(name)")
                    Text(trustCopy: PairingFailureText.describe(reason))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .font(.system(size: 13, weight: .medium))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .frame(maxWidth: 420)
        .padding(.top, 8)
        .padding(.horizontal, 16)
        .onTapGesture { appState.deviceTrust.feedback = nil }
        .accessibilityIdentifier("trust.feedback")
    }
}

// MARK: - Paste a pairing link (macOS, or any device without a camera)

/// Pair with a computer by pasting the link `kraki connect` prints/copies.
struct PastePairingLinkSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    var computer: DeviceSummary?

    @State private var text = ""
    @State private var error: String?
    @State private var confirmKeyChange: PairingLink?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(computer.map { "Pair with \($0.name)" } ?? "Pair with a computer")
                .font(.system(size: 17, weight: .semibold))
            Text(trustCopy: "On the computer, run `kraki connect --url-only` and paste the link it prints here.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://app.kraki.chat/?…", text: $text, axis: .vertical)
                .lineLimit(2...4)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced))
                .accessibilityIdentifier("trust.pasteField")
            if let error {
                Text(trustCopy: error).font(.system(size: 11.5)).foregroundStyle(Color(hex: 0xDC2626))
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Pair") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("trust.pasteSubmit")
            }
        }
        .padding(22)
        .frame(width: 440)
        .confirmationDialog(
            "Different key for this computer",
            isPresented: Binding(get: { confirmKeyChange != nil }, set: { if !$0 { confirmKeyChange = nil } }),
            titleVisibility: .visible
        ) {
            Button("Pair Anyway", role: .destructive) {
                if let link = confirmKeyChange { finish(link) }
            }
            Button("Cancel", role: .cancel) { confirmKeyChange = nil }
        } message: {
            Text("This link has a different key than the one you paired with. Continue only if you reinstalled Kraki on that computer.")
        }
    }

    private func submit() {
        guard let link = PairingLink(string: text) else {
            error = "That isn't a Kraki pairing link."
            return
        }
        guard let trust = link.trust else {
            error = "This link is from an older Kraki. Update Kraki on the computer, then run `kraki connect` again."
            return
        }
        if let computer, computer.id != trust.tentacleId {
            error = "This link is for a different computer."
            return
        }
        guard appState.deviceStore.devices[trust.tentacleId] != nil else {
            error = "That computer isn't on your account. Sign in to the same account on both."
            return
        }
        if appState.pairingLinkChangesKey(link) {
            confirmKeyChange = link
            return
        }
        finish(link)
    }

    private func finish(_ link: PairingLink) {
        appState.pairWithComputer(link)
        dismiss()
    }
}

extension AppState {
    /// The link names a computer this app already pinned (paired, pairing or
    /// refused) under other keys.
    func pairingLinkChangesKey(_ link: PairingLink) -> Bool {
        guard let trust = link.trust, let pin = TentacleTrustStore.shared.pin(trust.tentacleId) else { return false }
        return pin.identityKey != trust.identityKey || pin.encryptionKey != trust.encryptionKey
    }
}
