/// Column layout of the main window (MainWindowView): which side columns fit
/// beside a readable chat column, and growing the window to make room.

#if os(macOS)
import AppKit
import SwiftUI

/// Which side columns fit beside a readable chat column, in the window's
/// layout points (after UI zoom). The Inspector gives way first, then the
/// sidebar. Only the layout changes: the stored choices stay, so widening the
/// window or zooming out brings the columns back.
struct MacMainWindowColumns: Equatable {
    static let sidebarWidth: CGFloat = 280
    static let inspectorWidth: CGFloat = 320
    /// Each side column is drawn with a 1 pt seam.
    static let seamWidth: CGFloat = 1
    static let minimumChatWidth: CGFloat = 360

    var showsSidebar: Bool
    var showsInspector: Bool

    /// `width` 0 = not measured yet: show what was asked for.
    static func resolve(width: CGFloat, sidebarRequested: Bool, inspectorRequested: Bool) -> Self {
        guard width > 0 else {
            return Self(showsSidebar: sidebarRequested, showsInspector: inspectorRequested)
        }
        var chatWidth = width
        let showsSidebar = sidebarRequested
            && chatWidth - sidebarWidth - seamWidth >= minimumChatWidth
        if showsSidebar { chatWidth -= sidebarWidth + seamWidth }
        let showsInspector = inspectorRequested
            && chatWidth - inspectorWidth - seamWidth >= minimumChatWidth
        return Self(showsSidebar: showsSidebar, showsInspector: showsInspector)
    }

    /// Layout width the requested columns need beside a readable chat column.
    static func requiredWidth(sidebarRequested: Bool, inspectorRequested: Bool) -> CGFloat {
        minimumChatWidth
            + (sidebarRequested ? sidebarWidth + seamWidth : 0)
            + (inspectorRequested ? inspectorWidth + seamWidth : 0)
    }
}

/// Grows the window when showing a column or zooming in leaves too little room
/// (as far as the screen allows). A narrower window the person sizes by hand
/// is left alone: MacMainWindowColumns then folds the side columns away.
struct MacWindowWidthFitter: NSViewRepresentable {
    let requiredWidth: CGFloat
    let layoutWidth: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ nsView: NSView, context: Context) {
        let coordinator = context.coordinator
        let (requiredWidth, layoutWidth) = (requiredWidth, layoutWidth)
        guard nsView.window == nil else {
            coordinator.update(window: nsView.window, requiredWidth: requiredWidth, layoutWidth: layoutWidth)
            return
        }
        // Not in the window yet on the first pass: record the starting point
        // once it is, so the next column request is compared against it.
        DispatchQueue.main.async { [weak nsView] in
            coordinator.update(window: nsView?.window, requiredWidth: requiredWidth, layoutWidth: layoutWidth)
        }
    }

    @MainActor
    final class Coordinator {
        private var lastRequiredWidth: CGFloat?
        private var lastScale: CGFloat?
        private var lastFrameWidth: CGFloat?

        func update(window: NSWindow?, requiredWidth: CGFloat, layoutWidth: CGFloat) {
            guard let window, layoutWidth > 0, !window.styleMask.contains(.fullScreen),
                  !window.inLiveResize else { return }
            // Real points per layout point: the UI zoom step (WindowZoomModifier).
            // Snapped, so a layout pass lagging a resize is not taken for a zoom.
            let scale = CGFloat(WindowZoom.snap(Double(window.frame.width / layoutWidth)))
            defer {
                lastRequiredWidth = requiredWidth
                lastScale = scale
                lastFrameWidth = window.frame.width
            }
            // Only react to a column being asked for or to a zoom change,
            // never to the window being resized (by hand, tiling or the zoom
            // button). A zoom changes the layout width at a fixed frame width;
            // a resize changes the frame width, and a lagging layout width
            // must not be read as a zoom step.
            guard let lastRequiredWidth, let lastScale, let lastFrameWidth else { return }
            let zoomChanged = abs(scale - lastScale) > 0.001 && abs(window.frame.width - lastFrameWidth) < 0.5
            guard requiredWidth > lastRequiredWidth || zoomChanged else { return }
            let needed = (requiredWidth * scale).rounded(.up)
            guard window.frame.width + 0.5 < needed else { return }
            var frame = window.frame
            if let visible = (window.screen ?? NSScreen.main)?.visibleFrame {
                frame.size.width = min(needed, visible.width)
                if frame.maxX > visible.maxX {
                    frame.origin.x = max(visible.minX, visible.maxX - frame.width)
                }
            } else {
                frame.size.width = needed
            }
            guard frame.width > window.frame.width + 0.5 else { return }
            // Outside SwiftUI's update pass: resizing re-lays out this view.
            DispatchQueue.main.async { [weak window] in
                window?.setFrame(frame, display: true, animate: false)
            }
        }
    }
}

#endif
