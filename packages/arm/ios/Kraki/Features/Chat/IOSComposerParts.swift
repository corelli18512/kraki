#if os(iOS)
import SwiftUI

/// Pieces of the chat composer (MessageInputView) that the New Session sheet's
/// composer uses too, so the two always look the same.

/// The composer box: one capsule of plain Liquid Glass.
struct IOSComposerGlassBackground: View {
    static let shape = RoundedRectangle(cornerRadius: IOSComposerMetrics.height / 2, style: .continuous)

    var body: some View {
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: Self.shape)
        } else {
            Self.shape.fill(.ultraThinMaterial)
        }
    }
}

/// The staged image's thumbnail (composer and dictation header), decoded once
/// per attachment rather than on every composer update.
enum IOSComposerImages {
    private static let previews = NSCache<NSUUID, UIImage>()

    static func preview(_ image: StagedComposerImage) -> UIImage? {
        if let cached = previews.object(forKey: image.id as NSUUID) { return cached }
        guard let decoded = UIImage(data: image.data) else { return nil }
        previews.setObject(decoded, forKey: image.id as NSUUID)
        return decoded
    }
}

/// What has been heard so far, or the listening status before any speech.
struct IOSVoiceLiveTranscript: View {
    let preview: (prefix: String, spoken: String, suffix: String)
    let state: KrakiVoiceInputController.State

    var body: some View {
        Group {
            if preview.prefix.isEmpty && preview.suffix.isEmpty && preview.spoken.isEmpty {
                HStack(spacing: 7) {
                    if state == .waitingForConnection {
                        ProgressView().controlSize(.mini)
                    } else {
                        Circle().fill(.red).frame(width: 7, height: 7)
                    }
                    Text(Self.status(state)).foregroundStyle(.secondary)
                }
            } else {
                Text(verbatim: preview.prefix + preview.spoken + preview.suffix).foregroundStyle(.primary)
            }
        }
        .font(.body)
        .accessibilityIdentifier("voice-transcript")
    }

    static func status(_ state: KrakiVoiceInputController.State) -> String {
        switch state {
        case .waitingForConnection: return String(localized: "Connecting…")
        case .requestingPermission: return String(localized: "Allow microphone access…")
        case .recording: return String(localized: "Listening…")
        default: return String(localized: "Starting…")
        }
    }
}

/// The bottom row while dictating: Cancel, the level bars and time, Edit.
struct IOSVoiceRecordingControls: View {
    let levels: [Float]
    let startedAt: Date?
    let onCancel: () -> Void
    let onEdit: () -> Void

    /// Cancel and Edit are never cut off (iPhone SE, larger text): the level
    /// bars, then the timer, then the button titles give way first.
    var body: some View {
        ViewThatFits(in: .horizontal) {
            row(meter: true, timer: true, titles: true)
            row(meter: false, timer: true, titles: true)
            row(meter: false, timer: false, titles: true)
            row(meter: false, timer: false, titles: false)
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .frame(height: IOSComposerMetrics.height)
    }

    private func row(meter: Bool, timer: Bool, titles: Bool) -> some View {
        HStack(spacing: 6) {
            Button(action: onCancel) {
                controlLabel("Cancel", systemImage: "xmark", titles: titles)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .accessibilityIdentifier("voice-cancel")
            .accessibilityHint("Discards what you just said")
            if meter {
                VoiceLevelBars(levels: levels)
                    .padding(.leading, 6)
            }
            if timer, let startedAt {
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    Text(MessageInputView.elapsed(from: startedAt, to: context.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
            }
            Spacer(minLength: 4)
            Button(action: onEdit) {
                controlLabel("Edit", systemImage: "text.cursor", titles: titles)
                    .background(Color.krakiPrimary.opacity(0.12), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.krakiPrimary)
            .accessibilityIdentifier("voice-to-text")
            .accessibilityHint("Stops listening and puts the text in the field to edit")
        }
    }

    @ViewBuilder
    private func controlLabel(_ title: LocalizedStringKey, systemImage: String, titles: Bool) -> some View {
        Group {
            if titles {
                Label(title, systemImage: systemImage)
            } else {
                Label(title, systemImage: systemImage).labelStyle(.iconOnly)
            }
        }
        .font(.subheadline.weight(.medium))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 12)
        .frame(minWidth: 36, minHeight: 36)
    }
}

/// A voice failure note above the composer. It wraps to as many lines as it
/// needs (it used to stop at three, cutting off the end on an iPhone SE).
struct IOSVoiceFailureRow: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.caption)
                .foregroundStyle(.red)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Dismiss", action: onDismiss)
                .buttonStyle(.plain)
                .font(.caption.weight(.medium))
                .fixedSize()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

/// "<computer> is offline — …" above the composer. It is part of the bottom
/// footprint the chat reserves (`ChatBottomObstruction.height`), so it never
/// covers the newest bubble or the ↓ control, and it wraps instead of
/// cutting off the word "offline".
struct IOSComposerOfflineNotice: View {
    let text: String

    /// A long computer name is shortened so "offline" stays in view.
    static let maxNameLength = 28

    static func text(deviceName: String?) -> String {
        guard var name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return String(localized: "Device is offline — message will deliver when it reconnects.")
        }
        if name.count > maxNameLength { name = String(name.prefix(maxNameLength - 1)) + "…" }
        return String(localized: "\(name) is offline — message will deliver when it reconnects.")
    }

    /// Before the first sign-in the cached devices carry no live presence (all
    /// restored offline): the computer is not known to be offline, the relay
    /// may be what is unreachable, and the title says "Signing in…" — so
    /// nothing is blamed (`presenceKnown`).
    static func text(deviceOnline: Bool?, deviceName: String?, presenceKnown: Bool) -> String? {
        guard presenceKnown, deviceOnline != true else { return nil }
        return text(deviceName: deviceName)
    }

    var body: some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.ultraThinMaterial))
            .padding(.horizontal, 16)
            .accessibilityIdentifier("chat-offline-notice")
    }
}

/// The round send button: tinted glass when there is something to send.
struct IOSComposerSendCircle: View {
    let active: Bool

    var body: some View {
        ZStack {
            PrimaryGlassCircle(tint: active ? Color.krakiPrimary : nil,
                               fallback: active ? Color.krakiPrimary : Color(.systemGray4))
            Image(systemName: "arrow.up")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(active ? Color.white : Color.secondary)
        }
        .frame(width: IOSComposerMetrics.control, height: IOSComposerMetrics.control)
        .contentShape(Circle())
    }
}
#endif
