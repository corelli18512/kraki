/// Code block highlighting for Mac bubbles (Highlightr), its palette, cache and generation counter.

#if os(macOS)
import AppKit
import Highlightr

enum MacCodePalette {
    static let background = NSColor(
        srgbRed: 0x18 / 255,
        green: 0x18 / 255,
        blue: 0x1B / 255,
        alpha: 1
    )
    static let foreground = NSColor(
        srgbRed: 0xF4 / 255,
        green: 0xF4 / 255,
        blue: 0xF5 / 255,
        alpha: 1
    )

    static func ensuringReadableForeground(in string: NSMutableAttributedString) {
        guard string.length > 0 else { return }
        var unreadableRanges: [NSRange] = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, range, _ in
            guard let color = value as? NSColor,
                  contrastRatio(foreground: color, background: background) >= 4.5 else {
                unreadableRanges.append(range)
                return
            }
        }
        for range in unreadableRanges {
            string.addAttribute(.foregroundColor, value: foreground, range: range)
        }
    }

    static func contrastRatio(foreground: NSColor, background: NSColor) -> CGFloat {
        guard let fg = foreground.usingColorSpace(.sRGB),
              let bg = background.usingColorSpace(.sRGB) else { return 1 }
        let alpha = fg.alphaComponent
        let red = fg.redComponent * alpha + bg.redComponent * (1 - alpha)
        let green = fg.greenComponent * alpha + bg.greenComponent * (1 - alpha)
        let blue = fg.blueComponent * alpha + bg.blueComponent * (1 - alpha)
        let foregroundLuminance = luminance(red: red, green: green, blue: blue)
        let backgroundLuminance = luminance(
            red: bg.redComponent,
            green: bg.greenComponent,
            blue: bg.blueComponent
        )
        return (max(foregroundLuminance, backgroundLuminance) + 0.05)
            / (min(foregroundLuminance, backgroundLuminance) + 0.05)
    }

    private static func luminance(red: CGFloat, green: CGFloat, blue: CGFloat) -> CGFloat {
        func linear(_ value: CGFloat) -> CGFloat {
            value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }
}


private let macCodeHighlightCache: NSCache<NSString, NSAttributedString> = {
    let cache = NSCache<NSString, NSAttributedString>()
    cache.countLimit = 256
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
}()

extension Notification.Name {
    static let macCodeHighlightReady = Notification.Name("chat.kraki.mac.code-highlight-ready")
}

final class MacCodeHighlightGeneration: @unchecked Sendable {
    static let shared = MacCodeHighlightGeneration()
    private let lock = NSLock()
    private var value = 0

    func advance() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    func current() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

enum MacCodeHighlighter {
    private static let queue = DispatchQueue(label: "chat.kraki.mac.code-highlight", qos: .utility)
    private static let provisionalThreadKey = "chat.kraki.mac.code-highlight.provisional"
    nonisolated(unsafe) private static var engine: Highlightr?

    #if DEBUG
    struct Diagnostic {
        let title: String
        let language: String
        let supported: Bool
        let rawColorCount: Int
        let readableColorCount: Int
        let sourcePreserved: Bool
        let characterCount: Int
    }
    #endif

    private static func normalizedLanguage(_ language: String?) -> String? {
        MarkdownCodeSyntax.normalizedLanguage(language)
    }

    private static func highlighted(
        code: String,
        language: String?,
        engine: Highlightr
    ) -> NSAttributedString {
        let rawLanguage = MarkdownCodeSyntax.rawLanguage(language)
        let normalized = normalizedLanguage(language)
        if MarkdownCodeSyntax.isIntentionallyPlain(language) {
            return NSAttributedString(string: code)
        }
        let highlighted = engine.highlight(code, as: normalized, fastRender: true)
            ?? NSAttributedString(string: code)
        guard foregroundColorCount(in: highlighted) <= 1,
              let fallbackLanguage = normalized ?? rawLanguage else { return highlighted }
        return lexicalFallback(code: code, language: fallbackLanguage)
    }

    private static func lexicalFallback(code: String, language: String) -> NSAttributedString {
        let result = NSMutableAttributedString(string: code, attributes: [
            .foregroundColor: MacCodePalette.foreground,
        ])
        let fullRange = NSRange(location: 0, length: result.length)
        var occupied = IndexSet()

        func apply(_ pattern: String, color: NSColor, options: NSRegularExpression.Options = []) {
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
            let color: NSColor
            switch rule.role {
            case .comment: color = NSColor(srgbRed: 0x9A/255, green: 0xA4/255, blue: 0xB2/255, alpha: 1)
            case .string: color = NSColor(srgbRed: 0xA5/255, green: 0xD6/255, blue: 0xFF/255, alpha: 1)
            case .number: color = NSColor(srgbRed: 0xD2/255, green: 0xA8/255, blue: 0xFF/255, alpha: 1)
            case .keyword: color = NSColor(srgbRed: 0xFF/255, green: 0x8F/255, blue: 0xC7/255, alpha: 1)
            case .type: color = NSColor(srgbRed: 0xFF/255, green: 0xB8/255, blue: 0x6C/255, alpha: 1)
            }
            apply(rule.pattern, color: color, options: rule.options)
        }
        _ = language
        return result
    }

    static func clearProvisionalFlag() {
        Thread.current.threadDictionary.removeObject(forKey: provisionalThreadKey)
    }

    static func consumeProvisionalFlag() -> Bool {
        let provisional = Thread.current.threadDictionary[provisionalThreadKey] as? Bool ?? false
        Thread.current.threadDictionary.removeObject(forKey: provisionalThreadKey)
        return provisional
    }

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

    #if DEBUG
    static func catalogDiagnostics(
        completion: @escaping ([Diagnostic]) -> Void
    ) {
        let cases: [(String, String, String)] = MacBubbleCatalog.samples.flatMap { sample in
            splitMessageBody(sample.body).compactMap { segment in
                guard case let .codeBlock(language, code) = segment,
                      let language, !language.isEmpty else { return nil }
                return (sample.title, language.lowercased(), code)
            }
        }
        queue.async {
            guard let engine = makeEngine() else {
                DispatchQueue.main.async { completion([]) }
                return
            }
            let supported = Set(engine.supportedLanguages().map { $0.lowercased() })
            let results = cases.map { title, language, code in
                let normalized = normalizedLanguage(language)
                let raw = engine.highlight(code, as: normalized, fastRender: true)
                    ?? NSAttributedString(string: code)
                let production = highlighted(code: code, language: language, engine: engine)
                let readable = NSMutableAttributedString(attributedString: production)
                MacCodePalette.ensuringReadableForeground(in: readable)
                return Diagnostic(
                    title: title,
                    language: language,
                    supported: normalized.map(supported.contains) ?? true,
                    rawColorCount: foregroundColorCount(in: raw),
                    readableColorCount: foregroundColorCount(in: readable),
                    sourcePreserved: raw.string == code && readable.string == code,
                    characterCount: code.count
                )
            }
            DispatchQueue.main.async { completion(results) }
        }
    }
    #endif

    private static func foregroundColorCount(in string: NSAttributedString) -> Int {
        var colors: Set<String> = []
        string.enumerateAttribute(
            .foregroundColor,
            in: NSRange(location: 0, length: string.length)
        ) { value, _, _ in
            guard let color = value as? NSColor,
                  let rgb = color.usingColorSpace(.sRGB) else {
                colors.insert("none")
                return
            }
            let red = Int((rgb.redComponent * 255).rounded())
            let green = Int((rgb.greenComponent * 255).rounded())
            let blue = Int((rgb.blueComponent * 255).rounded())
            let alpha = Int((rgb.alphaComponent * 255).rounded())
            colors.insert("\(red)-\(green)-\(blue)-\(alpha)")
        }
        return colors.count
    }

    private static func storeHighlighted(_ highlighted: NSAttributedString, forKey key: NSString) {
        macCodeHighlightCache.setObject(
            highlighted,
            forKey: key,
            cost: highlighted.length * 8
        )
        MacCodeHighlightGeneration.shared.advance()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .macCodeHighlightReady, object: nil)
        }
    }

    static func attributed(
        code: String,
        language: String?,
        allowHighlighting: Bool = true
    ) -> NSAttributedString {
        guard allowHighlighting else { return NSAttributedString(string: code) }
        let normalized = normalizedLanguage(language) ?? "auto"
        let key = macContentCacheKey(prefix: normalized, content: code)
        if let cached = macCodeHighlightCache.object(forKey: key) { return cached }

        if Thread.isMainThread {
            Thread.current.threadDictionary[provisionalThreadKey] = true
            // Syntax highlighting is cosmetic and Highlightr can take 300ms+
            // on a cold real-world block. Never synchronously wait for its
            // utility queue from the chat/scroll main thread. Render correct
            // monospaced code immediately and populate the cache for a later
            // revisit without invalidating the current viewport.
            queue.async {
                if macCodeHighlightCache.object(forKey: key) != nil { return }
                // Highlightr's fast parser stays on this queue. `fastRender:
                // false` converts HTML through UIFoundation via safeMainSync,
                // which inserted visible main-thread stalls during scrolling.
                let result = makeEngine().map {
                    highlighted(code: code, language: language, engine: $0)
                } ?? NSAttributedString(string: code)
                storeHighlighted(result, forKey: key)
            }
            let provisional = NSMutableAttributedString(string: code)
            provisional.addAttribute(
                .tkCodeHighlightProvisional,
                value: true,
                range: NSRange(location: 0, length: provisional.length)
            )
            return provisional
        }

        return queue.sync {
            if let cached = macCodeHighlightCache.object(forKey: key) { return cached }
            let result = makeEngine().map {
                highlighted(code: code, language: language, engine: $0)
            } ?? NSAttributedString(string: code)
            storeHighlighted(result, forKey: key)
            return result
        }
    }
}
#endif
