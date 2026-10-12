/// Code block highlighting for iOS bubbles (Highlightr, with a lexical fallback) and its palette and cache.

import UIKit
import Highlightr

/// Fixed palette for the neutral code editor surface. Highlightr themes can
/// emit light-mode or low-contrast token colors even when the surrounding
/// bubble is dark; MacCodePalette applies this same readability contract.
enum IOSCodePalette {
    static let background = UIColor(red: 0x18/255, green: 0x18/255, blue: 0x1B/255, alpha: 1)
    static let foreground = UIColor(red: 0xF4/255, green: 0xF4/255, blue: 0xF5/255, alpha: 1)

    static func ensuringReadableForeground(in string: NSMutableAttributedString) {
        guard string.length > 0 else { return }
        var unreadableRanges: [NSRange] = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, range, _ in
            guard let color = value as? UIColor,
                  contrastRatio(foreground: color, background: background) >= 4.5 else {
                unreadableRanges.append(range)
                return
            }
        }
        for range in unreadableRanges {
            string.addAttribute(.foregroundColor, value: foreground, range: range)
        }
    }

    static func contrastRatio(foreground: UIColor, background: UIColor) -> CGFloat {
        let resolvedForeground = foreground.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        let resolvedBackground = background.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
        var fr: CGFloat = 0, fg: CGFloat = 0, fb: CGFloat = 0, fa: CGFloat = 0
        var br: CGFloat = 0, bg: CGFloat = 0, bb: CGFloat = 0, ba: CGFloat = 0
        guard resolvedForeground.getRed(&fr, green: &fg, blue: &fb, alpha: &fa),
              resolvedBackground.getRed(&br, green: &bg, blue: &bb, alpha: &ba) else { return 1 }

        func luminance(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGFloat {
            func linear(_ value: CGFloat) -> CGFloat {
                value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
        }

        // Blend translucent token colors over the actual code surface before
        // measuring, matching what the user sees rather than raw RGBA values.
        let blendedR = fr * fa + br * (1 - fa)
        let blendedG = fg * fa + bg * (1 - fa)
        let blendedB = fb * fa + bb * (1 - fa)
        let foregroundLuminance = luminance(blendedR, blendedG, blendedB)
        let backgroundLuminance = luminance(br, bg, bb)
        return (max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (min(foregroundLuminance, backgroundLuminance) + 0.05)
    }
}

// MARK: - TextKit2 bubble render path
//
// Landed pure-spine messages have one renderer and one identity: a TextKit
// bubble for the persisted message. TRACE steps are presented separately.

// MARK: - Metrics (mirror the SwiftUI bubble so cached heights line up)

private let tkCodeHighlightCache: NSCache<NSString, NSAttributedString> = {
    let cache = NSCache<NSString, NSAttributedString>()
    cache.countLimit = 256
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
}()

enum TKCodeHighlighter {
    private static let queue = DispatchQueue(label: "chat.kraki.code-highlight", qos: .utility)
    nonisolated(unsafe) private static var engine: Highlightr?

    static func prewarm() {
        queue.async { _ = makeEngine() }
    }

    private static func makeEngine() -> Highlightr? {
        if let engine { return engine }
        let created = Highlightr()
        created?.ignoreIllegals = true
        _ = created?.setTheme(to: "github-dark")
        engine = created
        return created
    }

    private static func normalizedLanguage(_ language: String?) -> String? {
        MarkdownCodeSyntax.normalizedLanguage(language)
    }

    static func attributed(
        code: String,
        language: String?,
        allowHighlighting: Bool
    ) -> NSAttributedString {
        guard allowHighlighting else { return NSAttributedString(string: code) }
        if MarkdownCodeSyntax.isIntentionallyPlain(language) {
            return NSAttributedString(string: code, attributes: [.foregroundColor: IOSCodePalette.foreground])
        }
        let normalized = normalizedLanguage(language)
        let key = tkContentCacheKey(prefix: normalized ?? "auto", content: code)
        if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }

        if Thread.isMainThread {
            queue.async {
                if tkCodeHighlightCache.object(forKey: key) != nil { return }
                let result = finalHighlight(code: code, language: language)
                tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: .tkCodeHighlightReady, object: nil)
                }
            }
            return NSAttributedString(
                string: code,
                attributes: [.tkCodeHighlightProvisional: true]
            )
        }

        return queue.sync {
            if let cached = tkCodeHighlightCache.object(forKey: key) { return cached }
            let result = finalHighlight(code: code, language: language)
            tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
            return result
        }
    }

    #if DEBUG
    static func cacheFinalForTesting(code: String, language: String?) {
        queue.sync {
            let normalized = normalizedLanguage(language)
            let key = tkContentCacheKey(prefix: normalized ?? "auto", content: code)
            let result = finalHighlight(code: code, language: language)
            tkCodeHighlightCache.setObject(result, forKey: key, cost: result.length * 8)
        }
    }
    #endif

    private static func finalHighlight(code: String, language: String?) -> NSAttributedString {
        let raw = MarkdownCodeSyntax.rawLanguage(language)
        let normalized = normalizedLanguage(language)
        let highlighted = makeEngine()?.highlight(code, as: normalized, fastRender: true)
            ?? NSAttributedString(string: code, attributes: [.foregroundColor: IOSCodePalette.foreground])
        guard foregroundColorCount(in: highlighted) <= 1,
              let fallbackLanguage = normalized ?? raw else {
            let readable = NSMutableAttributedString(attributedString: highlighted)
            IOSCodePalette.ensuringReadableForeground(in: readable)
            return readable
        }
        return lexicalFallback(code: code, language: fallbackLanguage)
    }

    private static func lexicalFallback(code: String, language: String) -> NSAttributedString {
        let result = NSMutableAttributedString(
            string: code,
            attributes: [.foregroundColor: IOSCodePalette.foreground]
        )
        let fullRange = NSRange(location: 0, length: result.length)
        var occupied = IndexSet()

        func apply(
            _ pattern: String,
            color: UIColor,
            options: NSRegularExpression.Options = []
        ) {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            for match in regex.matches(in: code, range: fullRange) {
                let range = match.range
                guard range.length > 0,
                      !occupied.intersects(integersIn: range.location..<(range.location + range.length)) else {
                    continue
                }
                result.addAttribute(.foregroundColor, value: color, range: range)
                occupied.insert(integersIn: range.location..<(range.location + range.length))
            }
        }

        for rule in MarkdownCodeSyntax.lexicalRules {
            let color: UIColor
            switch rule.role {
            case .comment: color = UIColor(red: 0x9A/255, green: 0xA4/255, blue: 0xB2/255, alpha: 1)
            case .string: color = UIColor(red: 0xA5/255, green: 0xD6/255, blue: 1, alpha: 1)
            case .number: color = UIColor(red: 0xD2/255, green: 0xA8/255, blue: 1, alpha: 1)
            case .keyword: color = UIColor(red: 1, green: 0x8F/255, blue: 0xC7/255, alpha: 1)
            case .type: color = UIColor(red: 1, green: 0xB8/255, blue: 0x6C/255, alpha: 1)
            }
            apply(rule.pattern, color: color, options: rule.options)
        }
        _ = language
        return result
    }

    private static func foregroundColorCount(in string: NSAttributedString) -> Int {
        var colors: Set<String> = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, _, _ in
            guard let color = value as? UIColor else {
                colors.insert("none")
                return
            }
            let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: .dark))
            var red: CGFloat = 0
            var green: CGFloat = 0
            var blue: CGFloat = 0
            var alpha: CGFloat = 0
            guard resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
                colors.insert(resolved.description)
                return
            }
            colors.insert("\(red)-\(green)-\(blue)-\(alpha)")
        }
        return colors.count
    }
}
