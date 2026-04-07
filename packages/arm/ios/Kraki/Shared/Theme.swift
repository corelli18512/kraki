#if os(iOS)
/// Theme — App-wide colors, fonts, and style constants.
///
/// Brand palette sourced from web CSS variables.

import SwiftUI
import UIKit

// MARK: - Adaptive Color Helper

extension Color {
    init(light: UIColor, dark: UIColor) {
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? dark : light })
    }
}

// MARK: - Brand Palette: Kraki

extension Color {
    static let kraki50  = Color(red: 0xFE / 255, green: 0xF3 / 255, blue: 0xF1 / 255)
    static let kraki100 = Color(red: 0xFD / 255, green: 0xE5 / 255, blue: 0xE0 / 255)
    static let kraki200 = Color(red: 0xFC / 255, green: 0xCE / 255, blue: 0xC6 / 255)
    static let kraki300 = Color(red: 0xF9 / 255, green: 0xAD / 255, blue: 0x9F / 255)
    static let kraki400 = Color(red: 0xF4 / 255, green: 0x83 / 255, blue: 0x6E / 255)
    static let kraki500 = Color(red: 0xEA / 255, green: 0x60 / 255, blue: 0x46 / 255)
    static let kraki600 = Color(red: 0xD7 / 255, green: 0x44 / 255, blue: 0x28 / 255)
    static let kraki700 = Color(red: 0xB5 / 255, green: 0x36 / 255, blue: 0x1E / 255)
    static let kraki800 = Color(red: 0x96 / 255, green: 0x30 / 255, blue: 0x1D / 255)
    static let kraki900 = Color(red: 0x7D / 255, green: 0x2D / 255, blue: 0x1E / 255)
    static let kraki950 = Color(red: 0x44 / 255, green: 0x13 / 255, blue: 0x0B / 255)
}

// MARK: - Brand Palette: Ocean

extension Color {
    static let ocean50  = Color(red: 0xEC / 255, green: 0xFE / 255, blue: 0xFF / 255)
    static let ocean100 = Color(red: 0xCF / 255, green: 0xFA / 255, blue: 0xFE / 255)
    static let ocean200 = Color(red: 0xA5 / 255, green: 0xF3 / 255, blue: 0xFC / 255)
    static let ocean300 = Color(red: 0x67 / 255, green: 0xE8 / 255, blue: 0xF9 / 255)
    static let ocean400 = Color(red: 0x22 / 255, green: 0xD3 / 255, blue: 0xEE / 255)
    static let ocean500 = Color(red: 0x06 / 255, green: 0xB6 / 255, blue: 0xD4 / 255)
    static let ocean600 = Color(red: 0x08 / 255, green: 0x91 / 255, blue: 0xB2 / 255)
    static let ocean700 = Color(red: 0x0E / 255, green: 0x74 / 255, blue: 0x90 / 255)
    static let ocean800 = Color(red: 0x15 / 255, green: 0x5E / 255, blue: 0x75 / 255)
    static let ocean900 = Color(red: 0x16 / 255, green: 0x4E / 255, blue: 0x63 / 255)
    static let ocean950 = Color(red: 0x08 / 255, green: 0x33 / 255, blue: 0x44 / 255)
}

// MARK: - Semantic Colors (adaptive light/dark)

extension Color {
    static let surfacePrimary = Color(
        light: UIColor(red: 1, green: 1, blue: 1, alpha: 1),          // #ffffff
        dark: UIColor(red: 0x02/255, green: 0x06/255, blue: 0x17/255, alpha: 1) // slate-950
    )
    static let surfaceSecondary = Color(
        light: UIColor(red: 0xF8/255, green: 0xFA/255, blue: 0xFC/255, alpha: 1), // slate-50
        dark: UIColor(red: 0x1E/255, green: 0x29/255, blue: 0x3B/255, alpha: 1)  // slate-800
    )
    static let surfaceTertiary = Color(
        light: UIColor(red: 0xF1/255, green: 0xF5/255, blue: 0xF9/255, alpha: 1), // slate-100
        dark: UIColor(red: 0x33/255, green: 0x41/255, blue: 0x55/255, alpha: 1)  // slate-700
    )
    static let borderPrimary = Color(
        light: UIColor(red: 0xE2/255, green: 0xE8/255, blue: 0xF0/255, alpha: 1), // slate-200
        dark: UIColor(red: 0x47/255, green: 0x55/255, blue: 0x69/255, alpha: 1)  // slate-600
    )
    static let textPrimary = Color(
        light: UIColor(red: 0x0F/255, green: 0x17/255, blue: 0x2A/255, alpha: 1), // slate-900
        dark: UIColor(red: 0xF1/255, green: 0xF5/255, blue: 0xF9/255, alpha: 1)  // slate-100
    )
    static let textSecondary = Color(
        light: UIColor(red: 0x64/255, green: 0x74/255, blue: 0x8B/255, alpha: 1), // slate-500
        dark: UIColor(red: 0x94/255, green: 0xA3/255, blue: 0xB8/255, alpha: 1)  // slate-400
    )
    static let textMuted = Color(
        light: UIColor(red: 0x94/255, green: 0xA3/255, blue: 0xB8/255, alpha: 1), // slate-400
        dark: UIColor(red: 0x64/255, green: 0x74/255, blue: 0x8B/255, alpha: 1)  // slate-500
    )
}

// MARK: - Legacy Aliases

extension Color {
    static let krakiPrimary = Color.kraki500
    static let krakiSecondary = Color.ocean500
}

// MARK: - Mode Colors

extension Color {
    static func modeColor(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     return .green
        case .discuss:  return .ocean500
        case .execute:  return .orange
        case .delegate: return .kraki500
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
    /// Standard card background with rounded corners and subtle border.
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

#endif
