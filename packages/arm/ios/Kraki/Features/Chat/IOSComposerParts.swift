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
                Text(preview.prefix + preview.spoken + preview.suffix).foregroundStyle(.primary)
            }
        }
        .font(.body)
        .accessibilityIdentifier("voice-transcript")
    }

    static func status(_ state: KrakiVoiceInputController.State) -> String {
        switch state {
        case .waitingForConnection: return "Connecting…"
        case .requestingPermission: return "Allow microphone access…"
        case .recording: return "Listening…"
        default: return "Starting…"
        }
    }
}

/// The bottom row while dictating: Cancel, the level bars and time, Edit.
struct IOSVoiceRecordingControls: View {
    let levels: [Float]
    let startedAt: Date?
    let onCancel: () -> Void
    let onEdit: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: onCancel) {
                Label("Cancel", systemImage: "xmark")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(Color.secondary.opacity(0.12), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.primary)
            .accessibilityIdentifier("voice-cancel")
            .accessibilityHint("Discards what you just said")
            VoiceLevelBars(levels: levels)
                .padding(.leading, 6)
            if let startedAt {
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    Text(MessageInputView.elapsed(from: startedAt, to: context.date))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 4)
            Button(action: onEdit) {
                Label("Edit", systemImage: "text.cursor")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 12)
                    .frame(height: 36)
                    .background(Color.krakiPrimary.opacity(0.12), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.krakiPrimary)
            .accessibilityIdentifier("voice-to-text")
            .accessibilityHint("Stops listening and puts the text in the field to edit")
        }
        .padding(.leading, 8)
        .padding(.trailing, 6)
        .frame(height: IOSComposerMetrics.height)
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
