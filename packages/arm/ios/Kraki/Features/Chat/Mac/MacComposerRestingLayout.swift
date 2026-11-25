#if os(macOS)
import SwiftUI

// MARK: - Resting layout

/// The resting Composer: [image] text [clear] [mic] on one row, or — once
/// the draft wraps — the text across the box with the controls in a row
/// below (the iOS Composer's shape, and dictation's: text over controls).
/// Subviews: image, text, clear, mic (always present; hidden ones invisible).
struct MacComposerRestingLayout: Layout {
    var stacked: Bool
    var showsClear: Bool
    var showsMic: Bool
    var rowHeight: CGFloat = MacComposerMetrics.capsuleHeight
    static let stackedLeading: CGFloat = 12
    /// The text's bottom padding and the row's top inset overlap by this.
    static let rowOverlap: CGFloat = 6

    /// The editor's width in the one-row arrangement of a layout `width`
    /// wide: the text column beside the attach slot, clear and mic, less the
    /// editor's trailing inset (the same widths `frames` places).
    static func oneRowEditorWidth(width: CGFloat, showsClear: Bool, showsMic: Bool) -> CGFloat {
        width - MacComposerMetrics.attachSlotWidth
            - (showsClear ? MacComposerMetrics.clearButtonWidth : 0)
            - (showsMic ? MacComposerMetrics.micButtonWidth : 0)
            - MacComposerMetrics.textTrailingInset
    }

    private func frames(width: CGFloat, _ s: Subviews) -> (frames: [CGRect], height: CGFloat) {
        let image = s[0].sizeThatFits(.unspecified)
        let clear = s[2].sizeThatFits(.unspecified)
        let mic = s[3].sizeThatFits(.unspecified)
        let clearW = showsClear ? clear.width : 0, micW = showsMic ? mic.width : 0
        if stacked {
            let textW = max(1, width - Self.stackedLeading)
            let textH = s[1].sizeThatFits(ProposedViewSize(width: textW, height: nil)).height
            let rowTop = max(0, textH - Self.rowOverlap)
            return ([CGRect(x: 0, y: rowTop, width: image.width, height: rowHeight),
                     CGRect(x: Self.stackedLeading, y: 0, width: textW, height: textH),
                     CGRect(x: width - micW - clear.width, y: rowTop + (rowHeight - clear.height) / 2,
                            width: clear.width, height: clear.height),
                     CGRect(x: width - mic.width, y: rowTop + (rowHeight - mic.height) / 2,
                            width: mic.width, height: mic.height)], rowTop + rowHeight)
        }
        let textW = max(1, width - image.width - clearW - micW)
        let textH = s[1].sizeThatFits(ProposedViewSize(width: textW, height: nil)).height
        let height = max(rowHeight, textH)
        return ([CGRect(x: 0, y: (height - image.height) / 2, width: image.width, height: image.height),
                 CGRect(x: image.width, y: 0, width: textW, height: height),
                 CGRect(x: image.width + textW, y: height - clear.height, width: clear.width, height: clear.height),
                 CGRect(x: width - mic.width, y: height - mic.height, width: mic.width, height: mic.height)], height)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 600
        return CGSize(width: width, height: frames(width: width, subviews).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 4 else { return }
        for (view, f) in zip(subviews, frames(width: bounds.width, subviews).frames) {
            view.place(at: CGPoint(x: bounds.minX + f.minX, y: bounds.minY + f.minY), anchor: .topLeading,
                       proposal: ProposedViewSize(f.size))
        }
    }
}

#endif
