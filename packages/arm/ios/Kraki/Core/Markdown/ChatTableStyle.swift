/// Fonts, metrics, colors and paint for `ChatTable` (moved out of
/// ChatTable.swift; shared by iOS and macOS).
import CoreText
import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

extension NSAttributedString.Key {
    /// Marks an inline-code run inside a table cell (drawn with a chip).
    static let chatTableCode = NSAttributedString.Key("chat.kraki.tableCode")
}

enum ChatTableStyle {
    #if os(iOS)
    static let bodySize: CGFloat = 14
    #else
    static let bodySize: CGFloat = 13.5
    #endif
    static let headerSize: CGFloat = 12.5
    static let padH: CGFloat = 10
    static let padV: CGFloat = 7
    static let cornerRadius: CGFloat = 10
    static let footerHeight: CGFloat = 34
    static let previewRowLimit = 8
    static let cardFieldLimit = 4
    /// Below this bubble width a text-heavy table may become cards.
    static let compactWidth: CGFloat = 480
    static let minTokenCap: CGFloat = 200
    static let preferredCap: CGFloat = 420
    /// Column width cap when the grid scrolls sideways.
    static let scrollColumnCap: CGFloat = 260

    static func system(_ size: CGFloat, _ weight: ChatTableFont.Weight = .regular) -> ChatTableFont {
        .systemFont(ofSize: size, weight: weight)
    }
    static func digits(_ size: CGFloat, _ weight: ChatTableFont.Weight = .regular) -> ChatTableFont {
        .monospacedDigitSystemFont(ofSize: size, weight: weight)
    }
    static func mono(_ size: CGFloat) -> ChatTableFont {
        .monospacedSystemFont(ofSize: size - 1, weight: .regular)
    }
    static func italic(_ font: ChatTableFont) -> ChatTableFont {
        #if os(iOS)
        guard let descriptor = font.fontDescriptor.withSymbolicTraits(.traitItalic) else { return font }
        return UIFont(descriptor: descriptor, size: font.pointSize)
        #else
        let descriptor = font.fontDescriptor.withSymbolicTraits(.italic)
        return NSFont(descriptor: descriptor, size: font.pointSize) ?? font
        #endif
    }

    static var text: PlatformColor {
        #if os(iOS)
        .label
        #else
        .labelColor
        #endif
    }
    static var secondary: PlatformColor {
        #if os(iOS)
        .secondaryLabel
        #else
        .secondaryLabelColor
        #endif
    }
    static let link: PlatformColor = {
        #if os(iOS)
        return UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x8F / 255, green: 0xD5 / 255, blue: 1, alpha: 1)
                : UIColor(red: 0x00 / 255, green: 0x56 / 255, blue: 0xA8 / 255, alpha: 1)
        }
        #else
        return NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(red: 0x8F / 255, green: 0xD5 / 255, blue: 1, alpha: 1)
                : NSColor(red: 0x00 / 255, green: 0x56 / 255, blue: 0xA8 / 255, alpha: 1)
        }
        #endif
    }()
}

/// Colors resolved by the view for the current appearance, right before drawing.
struct ChatTablePaint {
    var hairline: CGColor
    var headerFill: CGColor
    var codeFill: CGColor
    /// Opaque fill under pinned/sticky cells (the surface behind the table).
    var surface: CGColor
    var highlight: CGColor
    var accent: CGColor
}
