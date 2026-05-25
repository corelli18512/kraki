#if os(iOS)
/// LazyImageView — renders a `ContentRef` image from the
/// `AttachmentStore`. Subscribes to the store's per-id state and:
///
///   - awaiting/fetching → placeholder box (sized via `width`/`height`
///                          when present, else 192-pt tall square) with
///                          a small spinner
///   - ready             → the decoded `UIImage`
///   - error             → a small error chip
///
/// Triggers `requestIfNeeded` on first appear so cold-replayed sessions
/// hydrate the image when the bubble enters the viewport. Matches the
/// web client's `useAttachment` lifecycle.

import SwiftUI

struct LazyImageView: View {
    @Environment(AppState.self) private var appState

    let ref: ContentRef
    let sessionId: String

    private var attachmentStore: AttachmentStore { appState.attachmentStore }

    /// Estimated aspect ratio from the tentacle's `width`/`height` hints.
    /// Fallback to square if neither is present.
    private var aspectRatio: CGFloat {
        if let w = ref.width, let h = ref.height, h > 0 {
            return CGFloat(w) / CGFloat(h)
        }
        return 1.0
    }

    /// Render at most ~192pt tall, scaled by the known aspect ratio.
    private var renderedHeight: CGFloat { 192 }
    private var renderedWidth: CGFloat { renderedHeight * aspectRatio }

    var body: some View {
        Group {
            switch attachmentStore.state(for: ref.id) {
            case .ready(_, let data):
                if let img = UIImage(data: data) {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFit()
                        .frame(maxHeight: renderedHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    errorPlaceholder(label: "Invalid image")
                }
            case .error(let reason):
                errorPlaceholder(label: reason.isEmpty ? "Couldn't load image" : reason)
            case .awaitingChunks, .fetching, .none:
                loadingPlaceholder()
            }
        }
        .onAppear {
            attachmentStore.requestIfNeeded(id: ref.id, sessionId: sessionId)
        }
    }

    @ViewBuilder
    private func loadingPlaceholder() -> some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(.quaternary)
            ProgressView().controlSize(.small)
        }
        .frame(width: renderedWidth, height: renderedHeight)
    }

    /// Distinct error styling so a permanently failed image doesn't
    /// masquerade as "still loading" forever. Uses a warning glyph
    /// and a "Tap to retry" action that re-triggers the request.
    @ViewBuilder
    private func errorPlaceholder(label: String) -> some View {
        Button {
            attachmentStore.requestIfNeeded(id: ref.id, sessionId: sessionId)
        } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.red.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(Color.red.opacity(0.25), lineWidth: 1)
                    )
                VStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.red.opacity(0.8))
                    Text(label)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                    Text("Tap to retry")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 4)
            }
            .frame(width: renderedWidth, height: renderedHeight)
        }
        .buttonStyle(.plain)
    }
}
#endif
