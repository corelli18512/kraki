/// Theme — App-wide colors, fonts, and style constants.

import SwiftUI

// MARK: - Colors

extension Color {
    static let krakiPrimary = Color(red: 0.35, green: 0.56, blue: 0.96)   // kraki-500 blue
    static let krakiSecondary = Color(red: 0.22, green: 0.66, blue: 0.82) // ocean-500

    static func modeColor(_ mode: SessionMode) -> Color {
        switch mode {
        case .safe:     .green
        case .discuss:  .blue
        case .execute:  .orange
        case .delegate: .purple
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
