/// ThemePlatform — Cross-platform theme palette.
///
/// This is the platform-neutral copy of Theme.swift. It lives alongside
/// the iOS-only original so the Mac target can compile without dragging
/// in UIKit. The iOS target continues to use Theme.swift verbatim; this
/// file's contents are gated `#if os(macOS)` so we don't get duplicate
/// symbol errors on iOS.

#if os(macOS)
import SwiftUI
import AppKit

// MARK: - Brand Palette: Kraki (navy, derived from logo)

extension Color {
    static let kraki50  = Color(red: 0xEB / 255, green: 0xF3 / 255, blue: 0xFB / 255)
    static let kraki100 = Color(red: 0xD2 / 255, green: 0xE4 / 255, blue: 0xF6 / 255)
    static let kraki200 = Color(red: 0xA5 / 255, green: 0xC9 / 255, blue: 0xED / 255)
    static let kraki300 = Color(red: 0x5E / 255, green: 0xA0 / 255, blue: 0xD7 / 255)
    static let kraki400 = Color(red: 0x2F / 255, green: 0x80 / 255, blue: 0xC0 / 255)
    static let kraki500 = Color(red: 0x0B / 255, green: 0x5B / 255, blue: 0x9C / 255)
    static let kraki600 = Color(red: 0x09 / 255, green: 0x4A / 255, blue: 0x80 / 255)
    static let kraki700 = Color(red: 0x07 / 255, green: 0x3A / 255, blue: 0x65 / 255)
    static let kraki800 = Color(red: 0x05 / 255, green: 0x28 / 255, blue: 0x47 / 255)
    static let kraki900 = Color(red: 0x03 / 255, green: 0x1A / 255, blue: 0x30 / 255)
    static let kraki950 = Color(red: 0x01 / 255, green: 0x0E / 255, blue: 0x1E / 255)
}

// MARK: - Semantic Colors (adaptive light/dark)

extension Color {
    static let surfacePrimary = Color(
        light: NSColor(red: 1, green: 1, blue: 1, alpha: 1),
        dark: NSColor(red: 0x02/255, green: 0x06/255, blue: 0x17/255, alpha: 1)
    )
    static let surfaceSecondary = Color(
        light: NSColor(red: 0xF8/255, green: 0xFA/255, blue: 0xFC/255, alpha: 1),
        dark: NSColor(red: 0x1E/255, green: 0x29/255, blue: 0x3B/255, alpha: 1)
    )
    static let surfaceTertiary = Color(
        light: NSColor(red: 0xF1/255, green: 0xF5/255, blue: 0xF9/255, alpha: 1),
        dark: NSColor(red: 0x33/255, green: 0x41/255, blue: 0x55/255, alpha: 1)
    )
    static let borderPrimary = Color(
        light: NSColor(red: 0xE2/255, green: 0xE8/255, blue: 0xF0/255, alpha: 1),
        dark: NSColor(red: 0x47/255, green: 0x55/255, blue: 0x69/255, alpha: 1)
    )
    static let textPrimary = Color(
        light: NSColor(red: 0x0F/255, green: 0x17/255, blue: 0x2A/255, alpha: 1),
        dark: NSColor(red: 0xF1/255, green: 0xF5/255, blue: 0xF9/255, alpha: 1)
    )
    static let textSecondary = Color(
        light: NSColor(red: 0x64/255, green: 0x74/255, blue: 0x8B/255, alpha: 1),
        dark: NSColor(red: 0x94/255, green: 0xA3/255, blue: 0xB8/255, alpha: 1)
    )
    static let textMuted = Color(
        light: NSColor(red: 0x94/255, green: 0xA3/255, blue: 0xB8/255, alpha: 1),
        dark: NSColor(red: 0x64/255, green: 0x74/255, blue: 0x8B/255, alpha: 1)
    )
    static let textTitle = Color(
        light: NSColor(red: 0x05/255, green: 0x28/255, blue: 0x47/255, alpha: 1),
        dark: NSColor(red: 0xDB/255, green: 0xE8/255, blue: 0xF4/255, alpha: 1)
    )
}

// MARK: - Legacy Aliases

extension Color {
    static let krakiPrimary = Color(
        light: NSColor(red: 0x0B/255, green: 0x5B/255, blue: 0x9C/255, alpha: 1),
        dark: NSColor(red: 0x5E/255, green: 0xA0/255, blue: 0xD7/255, alpha: 1)
    )
    static let krakiSecondary = Color.kraki300
}

// MARK: - Mode Colors

extension Color {
    static func modeColor(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return Color(red: 0x34/255, green: 0xD3/255, blue: 0x99/255)
        case .discuss:  return Color(red: 0x22/255, green: 0xD3/255, blue: 0xEE/255)
        case .execute:  return Color(red: 0xFB/255, green: 0xBF/255, blue: 0x24/255)
        case .delegate: return Color(red: 0xF4/255, green: 0x83/255, blue: 0x6E/255)
        }
    }
}

// MARK: - Fonts

extension Font {
    static let monoSmall = Font.system(size: 12, design: .monospaced)
    static let monoBody = Font.system(size: 14, design: .monospaced)
}

// MARK: - View Helpers

extension View {
    func cardStyle() -> some View {
        self
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(.quaternary, lineWidth: 0.5)
            )
    }
}

// MARK: - Color hex helper (mirrors the iOS-side helper in SessionListView)

extension Color {
    init(hex: UInt, opacity: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

#endif
