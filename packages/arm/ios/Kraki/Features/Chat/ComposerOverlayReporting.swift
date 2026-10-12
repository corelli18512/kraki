import SwiftUI

extension View {
    /// Reports how far this floating composer rises above its `resting`
    /// footprint (ChatBottomObstruction.composerOverlay). The Chat lets the
    /// reader scroll that much further but never follows it.
    func reportsComposerOverlay(resting: CGFloat, into overlay: Binding<CGFloat>) -> some View {
        onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            overlay.wrappedValue = ChatBottomObstruction.composerOverlay(measuredHeight: height, restingHeight: resting)
        }
    }
}
