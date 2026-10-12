#if os(macOS)
import SwiftUI

/// Messages-style top edge: a long, eased fade whose strongest point is still
/// translucent, tinted neutral black (dark) / white (light).
struct MacChatTopEdgeFade: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let dark = colorScheme == .dark
        ZStack {
            Rectangle().fill(.ultraThinMaterial).opacity(0.85)
            (dark ? Color.black : Color.white).opacity(dark ? 0.55 : 0.5)
        }
        .mask(
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.9), location: 0.0),
                    .init(color: .black.opacity(0.78), location: 0.3),
                    .init(color: .black.opacity(0.5), location: 0.55),
                    .init(color: .black.opacity(0.22), location: 0.78),
                    .init(color: .clear, location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif
