import SwiftUI

/// One allocation rule on both clients: device and effort keep their full
/// text; only the model gives up width, from its leading end. Very long device
/// names wrap above model/effort instead of pushing content outside the card.
struct SessionCardMetadataRow: View {
    let machineName: String?
    let model: String?
    let effort: String?
    let sessionId: String
    let font: Font
    let deviceColor: Color
    let modelColor: Color
    var statusColor: Color? = nil

    var body: some View {
        SessionMetadataLayout(hasDevice: machineName != nil, hasModel: model?.isEmpty == false,
                              hasEffort: effort != nil) {
            HStack(spacing: 6) {
                if let machineName {
                    if let statusColor { Circle().fill(statusColor).frame(width: 6, height: 6) }
                    Text(machineName)
                        .foregroundStyle(deviceColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("session-device-\(sessionId)")
                }
            }
            Rectangle().fill(Color.borderPrimary)
            Text(model ?? "")
                .foregroundStyle(modelColor)
                .lineLimit(1)
                .truncationMode(.head)
                .accessibilityIdentifier("session-model-\(sessionId)")
            Text(effort.map { "· \($0)" } ?? "")
                .foregroundStyle(modelColor)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(effort.map { "Reasoning effort: \($0)" } ?? "")
                .accessibilityIdentifier("session-effort-\(sessionId)")
        }
        .font(font)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SessionMetadataLayout: Layout {
    let hasDevice: Bool
    let hasModel: Bool
    let hasEffort: Bool
    static let spacing: CGFloat = 6
    static let rowSpacing: CGFloat = 2

    /// Keep enough model width for an ellipsis plus a useful suffix. This is
    /// only the wrap threshold, not a cap on model text or on device length.
    static func needsSecondRow(width: CGFloat, device: CGFloat, model: CGFloat, effort: CGFloat) -> Bool {
        device > 0 && model > 0 && device + 1 + min(model, 40) + effort
            + spacing * (effort > 0 ? 3 : 2) > width
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = frames(width: proposal.width, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = frames(width: bounds.width, subviews: subviews)
        for (view, frame) in zip(subviews, result.frames) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                       anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }

    private func frames(width proposedWidth: CGFloat?, subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let device = hasDevice ? subviews[0].sizeThatFits(.unspecified) : .zero
        let model = hasModel ? subviews[2].sizeThatFits(.unspecified) : .zero
        let effort = hasEffort ? subviews[3].sizeThatFits(.unspecified) : .zero
        let idealWidth = device.width + model.width + effort.width
            + (hasDevice && hasModel ? 1 + Self.spacing * 2 : 0)
            + (hasModel && hasEffort ? Self.spacing : 0)
        let width = max(0, proposedWidth ?? idealWidth)
        var frames = Array(repeating: CGRect.zero, count: 4)
        let stacked = Self.needsSecondRow(width: width, device: device.width, model: model.width, effort: effort.width)
        let deviceSize = hasDevice
            ? subviews[0].sizeThatFits(ProposedViewSize(width: min(width, device.width), height: nil)) : .zero
        var x: CGFloat = 0
        var y: CGFloat = 0
        if hasDevice {
            frames[0] = CGRect(origin: .zero, size: deviceSize)
            if stacked {
                y = deviceSize.height + Self.rowSpacing
            } else if hasModel {
                x = deviceSize.width + Self.spacing
                frames[1] = CGRect(x: x, y: 0, width: 1, height: 9)
                x += 1 + Self.spacing
            }
        }
        if hasModel {
            // An exceptionally narrow proposal can put effort on its own row;
            // no clipping/negative width, even at accessibility text sizes.
            let separateEffort = hasEffort && effort.width + Self.spacing + min(model.width, 16) > width - x
            let modelWidth = max(0, min(model.width, width - x - (hasEffort && !separateEffort ? effort.width + Self.spacing : 0)))
            let modelSize = subviews[2].sizeThatFits(ProposedViewSize(width: modelWidth, height: nil))
            frames[2] = CGRect(x: x, y: y, width: modelWidth, height: modelSize.height)
            if hasEffort {
                frames[3] = CGRect(x: separateEffort ? 0 : x + modelWidth + Self.spacing,
                                   y: separateEffort ? y + modelSize.height + Self.rowSpacing : y,
                                   width: min(width, effort.width),
                                   height: subviews[3].sizeThatFits(ProposedViewSize(width: min(width, effort.width), height: nil)).height)
            }
            let rowHeight = max(modelSize.height, separateEffort ? 0 : effort.height)
            if !stacked {
                let height = max(deviceSize.height, rowHeight)
                frames[0].origin.y = (height - deviceSize.height) / 2
                if frames[1].width > 0 { frames[1].origin.y = (height - 9) / 2 }
                frames[2].origin.y = (height - modelSize.height) / 2
                if hasEffort && !separateEffort { frames[3].origin.y = (height - effort.height) / 2 }
            }
        }
        return (CGSize(width: width, height: frames.map(\.maxY).max() ?? 0), frames)
    }
}
