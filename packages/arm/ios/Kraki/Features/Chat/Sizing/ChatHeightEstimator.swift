#if os(iOS)
import UIKit

/// Cheap, structure-aware first-pass bubble height for rows that have not been
/// measured by TextKit yet.
///
/// The list must answer `sizeForItemAt` for every loaded row during layout, so
/// this path never touches Markdown parsing, TextKit, CoreText or images. It
/// still understands the shapes that dominate real agent output — hard line
/// breaks, fenced code, tables, lists, headings and CJK text — because a
/// structure-blind "bytes ÷ line width" estimate was off by 40–60% for code,
/// lists and tables and by +15–40% for Chinese, and every such error becomes a
/// visible jump when the exact height replaces it.
enum ChatHeightEstimator {
    struct Metrics {
        let bodyFont: UIFont
        let bodyLine: CGFloat
        let codeLine: CGFloat
        let codeCharWidth: CGFloat
        let latinWidth: CGFloat
        let wideWidth: CGFloat

        static func current() -> Metrics {
            let body = UIFont.preferredFont(forTextStyle: .subheadline)
            let code = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
            let codeChar = ("0" as NSString).size(withAttributes: [.font: code]).width
            let latin = ("abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ,." as NSString)
                .size(withAttributes: [.font: body]).width / 40
            let wide = ("中" as NSString).size(withAttributes: [.font: body]).width
            return Metrics(
                bodyFont: body,
                bodyLine: ceil(body.lineHeight),
                codeLine: ceil(code.lineHeight) + 2,
                codeCharWidth: codeChar,
                latinWidth: latin,
                wideWidth: wide
            )
        }
    }

    nonisolated(unsafe) private static var cachedMetrics: (category: UIContentSizeCategory, metrics: Metrics)?

    static var metrics: Metrics {
        let category = UIApplication.shared.preferredContentSizeCategory
        if let cachedMetrics, cachedMetrics.category == category { return cachedMetrics.metrics }
        let metrics = Metrics.current()
        cachedMetrics = (category, metrics)
        return metrics
    }

    /// Estimated height of the rendered body text at `bodyWidth`.
    static func bodyHeight(_ text: String, bodyWidth: CGFloat, metrics m: Metrics = metrics) -> CGFloat {
        guard !text.isEmpty, bodyWidth > 20 else { return 0 }
        var height: CGFloat = 0
        var inCode = false
        var segments = 0
        var previousKind = 0 // 0 none, 1 prose, 2 code, 3 table
        let codeColumns = max(8, Int((bodyWidth - 24) / max(m.codeCharWidth, 1)))
        var budget = 12_000

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            guard budget > 0 else {
                height += m.bodyLine
                continue
            }
            budget -= rawLine.utf8.count + 1
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") {
                if inCode {
                    inCode = false
                    height += 8
                } else {
                    inCode = true
                    if previousKind != 0 { height += 6 }
                    segments += 1
                    previousKind = 2
                    height += line.count > 3 ? 20 : 8
                }
                continue
            }
            if inCode {
                let columns = max(1, rawLine.count)
                height += CGFloat((columns + codeColumns - 1) / codeColumns) * m.codeLine
                continue
            }
            if line.hasPrefix("|") {
                if previousKind != 3 {
                    if previousKind != 0 { height += 6 }
                    segments += 1
                    previousKind = 3
                    height += 10
                }
                let isSeparator = line.allSatisfy { "|-: ".contains($0) }
                if !isSeparator { height += m.bodyLine + 12 }
                continue
            }
            if previousKind == 2 || previousKind == 3 { height += 6 }
            previousKind = 1
            if line.isEmpty {
                height += m.bodyLine
                continue
            }
            var font = m.bodyFont.pointSize
            var extra: CGFloat = 0
            var content = Substring(line)
            if line.hasPrefix("#") {
                let level = line.prefix { $0 == "#" }.count
                content = line.dropFirst(level).drop { $0 == " " }
                font = level <= 1 ? font * 1.47 : level == 2 ? font * 1.33 : font * 1.13
                extra = level <= 2 ? 6 : 4
            } else if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
                content = line.dropFirst(2)
                extra = 3
            } else if let dot = line.firstIndex(of: "."), dot != line.startIndex,
                      line[..<dot].allSatisfy(\.isNumber), line[line.index(after: dot)...].hasPrefix(" ") {
                content = line[line.index(after: dot)...].dropFirst()
                extra = 3
            } else if line.hasPrefix(">") {
                content = line.dropFirst().drop { $0 == " " }
            }
            let indent: CGFloat = extra == 3 ? 25 : line.hasPrefix(">") ? 22 : 0
            let scale = font / m.bodyFont.pointSize
            var width: CGFloat = 0
            for scalar in content.unicodeScalars {
                if scalar.value == 0x2A || scalar.value == 0x60 { continue } // * and ` markers
                width += (isWide(scalar) ? m.wideWidth : m.latinWidth) * scale
            }
            let usable = max(40, bodyWidth - indent)
            let lines = max(1, Int(ceil(width / usable * 1.04)))
            height += CGFloat(lines) * ceil(m.bodyLine * scale) + extra
        }
        if inCode { height += 8 }
        return ceil(height)
    }

    private static func isWide(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF,
             0xFE30...0xFE4F, 0xFF00...0xFF60, 0xFFE0...0xFFE6, 0x1F300...0x1FAFF, 0x20000...0x3FFFD:
            return true
        default:
            return false
        }
    }
}
#endif
