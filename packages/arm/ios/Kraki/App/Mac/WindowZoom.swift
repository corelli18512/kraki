/// WindowZoom — app-wide UI zoom for the mac target.
///
/// macOS native apps don't ship with a browser-style ⌘+/⌘- zoom out
/// of the box. We add one ourselves by wrapping the window's content
/// in a `.scaleEffect()` and giving the inner content the *inverse*
/// frame so layout still computes against the full window size.
///
/// Pattern:
///
///     GeometryReader { geo in
///         content
///             .frame(
///                 width:  geo.size.width  / zoom,
///                 height: geo.size.height / zoom
///             )
///             .scaleEffect(zoom, anchor: .topLeading)
///     }
///
/// This makes SwiftUI lay the content out as if the window were
/// `1/zoom` of its real size, then visually scales it back up. Hit
/// testing is mapped through the scale by SwiftUI automatically, so
/// clicks land on the right spot.
///
/// Zoom level is persisted via `@AppStorage("mac.uiZoom")` and
/// driven by ⌘+ / ⌘- / ⌘0 from the View menu (see `MacCommands`).

#if os(macOS)
import SwiftUI

enum WindowZoom {
    /// Allowed zoom steps. Symmetric around 1.0, biased toward
    /// finer-grained adjustments near the default.
    static let steps: [Double] = [
        0.75, 0.85, 0.90, 0.95, 1.00, 1.05, 1.10, 1.20, 1.30, 1.45, 1.60
    ]

    static let minZoom: Double = steps.first!
    static let maxZoom: Double = steps.last!
    static let defaultZoom: Double = 1.0

    /// Round `value` to the closest entry in `steps`.
    static func snap(_ value: Double) -> Double {
        steps.min(by: { abs($0 - value) < abs($1 - value) }) ?? defaultZoom
    }

    /// Next step strictly larger than `current`, clamped to maxZoom.
    static func stepUp(from current: Double) -> Double {
        let snapped = snap(current)
        if let next = steps.first(where: { $0 > snapped + 0.001 }) {
            return next
        }
        return maxZoom
    }

    /// Next step strictly smaller than `current`, clamped to minZoom.
    static func stepDown(from current: Double) -> Double {
        let snapped = snap(current)
        if let prev = steps.last(where: { $0 < snapped - 0.001 }) {
            return prev
        }
        return minZoom
    }
}

extension Notification.Name {
    static let macZoomIn    = Notification.Name("mac.zoomIn")
    static let macZoomOut   = Notification.Name("mac.zoomOut")
    static let macZoomReset = Notification.Name("mac.zoomReset")
}

/// A view modifier that applies a window-wide zoom by wrapping the
/// content in a GeometryReader + inverse-frame + scaleEffect. Attach
/// this to the root content view in MainWindowView (and any other
/// top-level scene that should obey the zoom).
struct WindowZoomModifier: ViewModifier {
    @AppStorage("mac.uiZoom") private var zoom: Double = WindowZoom.defaultZoom

    func body(content: Content) -> some View {
        GeometryReader { geo in
            content
                .frame(
                    width:  max(1, geo.size.width  / zoom),
                    height: max(1, geo.size.height / zoom)
                )
                .scaleEffect(zoom, anchor: .topLeading)
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomIn)) { _ in
            zoom = WindowZoom.stepUp(from: zoom)
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomOut)) { _ in
            zoom = WindowZoom.stepDown(from: zoom)
        }
        .onReceive(NotificationCenter.default.publisher(for: .macZoomReset)) { _ in
            zoom = WindowZoom.defaultZoom
        }
    }
}

extension View {
    /// Apply the persistent mac UI zoom. Use exactly once per window
    /// content root.
    func windowZoom() -> some View {
        modifier(WindowZoomModifier())
    }
}

#endif
