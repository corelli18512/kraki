import Foundation
import SwiftUI

/// Shared voice-composer presentation rules. Audio capture and native drawing
/// remain platform-specific; the text and state semantics do not.
enum VoiceComposerPresentation {
    static let rawLookaheadCharacters = 56

    static func statusText(
        state: KrakiVoiceInputController.State,
        rawText: String,
        displayText: String
    ) -> String {
        switch state {
        case .idle:
            return ""
        case .requestingPermission:
            return "Requesting microphone access…"
        case .obtainingLease:
            return "Authorizing voice input…"
        case .recording:
            return displayText.isEmpty ? "Listening…" : displayText
        case .finishing:
            return displayText.isEmpty
                ? "Finishing transcription and correction…"
                : displayText
        case .failed(let message):
            return message
        }
    }

    /// Returns the stable prefix, corrected transcript, and raw look-ahead as
    /// separate pieces so UIKit and AppKit can render them natively.
    static func transcriptPieces(
        prefix: String,
        state: KrakiVoiceInputController.State,
        rawText: String,
        correctionSource: String,
        correctionText: String,
        correctionSourceOffset: Int
    ) -> [(text: String, opacity: Double)] {
        var pieces: [(text: String, opacity: Double)] = []
        if !prefix.isEmpty { pieces.append((prefix, 1)) }

        func appendVoice(_ text: String, opacity: Double) {
            guard !text.isEmpty else { return }
            if !prefix.isEmpty,
               pieces.count == 1,
               prefix.last?.isWhitespace != true,
               text.first?.isWhitespace != true {
                pieces.append((" ", 1))
            }
            pieces.append((text, opacity))
        }

        switch state {
        case .requestingPermission:
            appendVoice("Requesting microphone access…", opacity: 0.45)
        case .obtainingLease:
            appendVoice("Authorizing voice input…", opacity: 0.45)
        case .recording:
            appendVoice(
                rawText.isEmpty ? "Listening…" : rawText,
                opacity: rawText.isEmpty ? 0.45 : 1
            )
        case .finishing:
            let source = correctionSource.isEmpty ? rawText : correctionSource
            if correctionText.isEmpty {
                appendVoice(source.isEmpty ? "Correcting…" : source, opacity: 0.82)
            } else {
                let corrected = Array(correctionText)
                for (index, character) in corrected.enumerated() {
                    let distanceFromEnd = corrected.count - index - 1
                    let opacity: Double
                    switch distanceFromEnd {
                    case 0: opacity = 0.48
                    case 1: opacity = 0.64
                    case 2: opacity = 0.78
                    case 3: opacity = 0.90
                    default: opacity = 0.96
                    }
                    appendVoice(String(character), opacity: opacity)
                }

                let raw = Array(source)
                var remainder = Array(raw.dropFirst(min(correctionSourceOffset, raw.count)))
                let correctedEndsWithWhitespace = correctionText.last.map {
                    String($0).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                } ?? false
                while correctedEndsWithWhitespace,
                      let first = remainder.first,
                      String(first).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    remainder.removeFirst()
                }
                if !remainder.isEmpty {
                    let lookahead = String(remainder.prefix(rawLookaheadCharacters))
                    if let last = pieces.last,
                       last.text.last?.isWhitespace != true,
                       lookahead.first?.isWhitespace != true {
                        pieces.append((" ", 1))
                    }
                    appendVoice(lookahead, opacity: 0.30)
                }
            }
        case .idle, .failed:
            break
        }

        guard pieces.count > 1 else { return pieces }
        var merged: [(text: String, opacity: Double)] = []
        for piece in pieces {
            if let last = merged.last, last.opacity == piece.opacity {
                merged[merged.count - 1] = (last.text + piece.text, last.opacity)
            } else {
                merged.append(piece)
            }
        }
        return merged
    }

    static func transcriptRevision(
        _ pieces: [(text: String, opacity: Double)]
    ) -> Int {
        var hasher = Hasher()
        for piece in pieces {
            hasher.combine(piece.text)
            hasher.combine(piece.opacity)
        }
        return hasher.finalize()
    }

    static func attributedTranscript(
        prefix: String,
        state: KrakiVoiceInputController.State,
        rawText: String,
        correctionSource: String,
        correctionText: String,
        correctionSourceOffset: Int
    ) -> AttributedString {
        let pieces = transcriptPieces(
            prefix: prefix,
            state: state,
            rawText: rawText,
            correctionSource: correctionSource,
            correctionText: correctionText,
            correctionSourceOffset: correctionSourceOffset
        )
        var output = AttributedString()
        for piece in pieces {
            var value = AttributedString(piece.text)
            value.font = .system(size: 15)
            value.foregroundColor = Color.primary.opacity(piece.opacity)
            output.append(value)
        }
        return output
    }
}

struct VoiceComposerStatusModule: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: KrakiVoiceInputController.State

    var body: some View {
        Group {
            switch state {
            case .requestingPermission, .obtainingLease:
                ProgressView().controlSize(.small)
            case .recording:
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.14))
                        .frame(width: 30, height: 30)
                    Image(systemName: "mic.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
            case .finishing:
                VoiceComposerArmillary(reduceMotion: reduceMotion)
            case .idle, .failed:
                Color.clear
            }
        }
        .frame(width: 30, height: 30)
    }
}

private struct VoiceComposerArmillary: View {
    let reduceMotion: Bool

    var body: some View {
        if reduceMotion {
            ZStack {
                Circle().stroke(Color.accentColor.opacity(0.45), lineWidth: 1)
                Circle().fill(Color.primary).frame(width: 4, height: 4)
            }
            .frame(width: 24, height: 24)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                let time = timeline.date.timeIntervalSinceReferenceDate
                ZStack {
                    Circle()
                        .fill(Color.primary)
                        .frame(width: 4, height: 4)
                        .shadow(color: Color.primary.opacity(0.6), radius: 3)
                    orbit(time: time, period: 0.8, reverse: false, size: 24,
                          color: Color(red: 0.42, green: 0.66, blue: 1.0))
                    orbit(time: time, period: 0.6, reverse: true, size: 17,
                          color: Color(red: 0.62, green: 0.52, blue: 1.0))
                    orbit(time: time, period: 1.1, reverse: false, size: 10,
                          color: Color(red: 0.52, green: 0.86, blue: 1.0))
                }
            }
            .frame(width: 28, height: 28)
        }
    }

    private func orbit(
        time: TimeInterval,
        period: Double,
        reverse: Bool,
        size: CGFloat,
        color: Color
    ) -> some View {
        let direction = reverse ? -1.0 : 1.0
        let angle = time.truncatingRemainder(dividingBy: period) / period * 360 * direction
        return Circle()
            .trim(from: 0, to: 0.42)
            .stroke(
                AngularGradient(
                    colors: [color.opacity(0), color],
                    center: .center,
                    startAngle: .degrees(0),
                    endAngle: .degrees(151.2)
                ),
                style: StrokeStyle(lineWidth: 1, lineCap: .round)
            )
            .frame(width: size, height: size)
            .rotationEffect(.degrees(angle))
    }
}

#if os(iOS)
struct IOSVoiceComposerSurface: View {
    let pieces: [(text: String, opacity: Double)]
    let state: KrakiVoiceInputController.State
    let statusText: String
    let onFinish: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 30, height: 30)
                    .background(Color.primary.opacity(0.08), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice input")
            .accessibilityHint("Keeps the current draft and returns to the keyboard")

            IOSVoiceTranscriptText(
                pieces: pieces,
                revision: VoiceComposerPresentation.transcriptRevision(pieces)
            )
            .layoutPriority(1)

            Button {
                if state == .recording { onFinish() }
            } label: {
                VoiceComposerStatusModule(state: state)
                    .frame(width: 38, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(state != .recording)
            .accessibilityLabel(state == .recording ? "Finish voice input" : statusText)
            .accessibilityHint(
                state == .recording
                    ? "Stops recording and starts transcription correction"
                    : ""
            )
        }
        .padding(.leading, 8)
        .padding(.trailing, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
    }
}

struct IOSVoiceTranscriptText: View {
    private static let lineHeight: CGFloat = 18
    private static let maxVisibleLines: CGFloat = 2
    private static let tailID = "voice-transcript-tail"

    let pieces: [(text: String, opacity: Double)]
    let revision: Int

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    Text(attributed)
                        .font(.system(size: 15))
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear
                        .frame(height: 1)
                        .id(Self.tailID)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: Self.lineHeight * Self.maxVisibleLines)
            .clipped()
            .onAppear {
                scrollToTail(proxy)
            }
            .onChange(of: revision) { _, _ in
                scrollToTail(proxy)
            }
        }
        .accessibilityLabel("Voice transcript")
    }

    private func scrollToTail(_ proxy: ScrollViewProxy) {
        // The transcript changes on every partial recognition packet. Defer
        // until SwiftUI has committed the new text height, otherwise the
        // proxy can target the previous content extent and leave the newest
        // words below the viewport.
        DispatchQueue.main.async {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                proxy.scrollTo(Self.tailID, anchor: .bottom)
            }
        }
    }

    private var attributed: AttributedString {
        var output = AttributedString()
        for piece in pieces {
            var value = AttributedString(piece.text)
            value.foregroundColor = Color.primary.opacity(piece.opacity)
            output.append(value)
        }
        return output
    }
}
#endif
