/// ScaledFont — a system font of a given point size that still follows the
/// iPhone's text size setting (Dynamic Type).
///
/// Use `.scaledFont(13, weight: .medium)` instead of
/// `.font(.system(size: 13, weight: .medium))`. At the default text size it
/// is exactly `size`; larger settings scale it the way the matching text
/// style scales. On the Mac (no Dynamic Type) it is always `size`.

import SwiftUI
#if os(iOS)
import UIKit
#endif

enum ScaledFont {
    /// The text style whose scaling a fixed size follows.
    static func style(for size: CGFloat) -> Font.TextStyle {
        switch size {
        case 20...: return .title3
        case 17..<20: return .body
        case 15..<17: return .subheadline
        case 13..<15: return .footnote
        case 12..<13: return .caption
        default: return .caption2
        }
    }

    #if os(iOS)
    /// The UIKit font for the same size, scaled the same way, for code that
    /// measures text with UIFont.
    static func uiFont(_ size: CGFloat, weight: UIFont.Weight = .regular) -> UIFont {
        let style: UIFont.TextStyle
        switch self.style(for: size) {
        case .title3: style = .title3
        case .body: style = .body
        case .subheadline: style = .subheadline
        case .footnote: style = .footnote
        case .caption: style = .caption1
        default: style = .caption2
        }
        return UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
    }
    #endif
}

private struct ScaledSystemFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: ScaledFont.style(for: size))
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}

extension View {
    func scaledFont(_ size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(ScaledSystemFont(size: size, weight: weight, design: design))
    }
}
