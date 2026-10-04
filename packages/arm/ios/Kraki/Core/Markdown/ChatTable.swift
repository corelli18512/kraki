/// ChatTable — one Markdown table in a chat bubble, shared by iOS and macOS.
///
/// Prepared once per message revision (cell Markdown → attributed strings,
/// width-independent measurements), then laid out per available width:
///
///   • grid  — column widths follow the browser's automatic table algorithm:
///             fill the width when everything fits on one line, otherwise
///             share the room between each column's minimum (longest
///             unbreakable word) and preferred (single-line) width. When even
///             the minimums do not fit, the grid scrolls sideways with its
///             first column pinned.
///   • cards — a narrow width and a text-heavy table that would not fit (or
///             would wrap into a tall ladder) become one card per row.
///
/// Measuring and drawing use CoreText only, so layout may run off the main
/// thread (the Mac prepares bubble content on a background queue).
import CoreText
import Foundation
#if os(iOS)
import UIKit
typealias ChatTableFont = UIFont
#else
import AppKit
typealias ChatTableFont = NSFont
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

// MARK: - Model

final class ChatTable {
    let source: [[String]]
    let alignments: [TableAlignment]
    let columnCount: Int
    let numeric: [Bool]
    let header: [NSAttributedString]
    let body: [[NSAttributedString]]
    /// Plain cell text (for search, sorting and accessibility).
    let plainBody: [[String]]
    let plainHeader: [String]
    /// Width-independent measurements (cell padding included).
    let columnMin: [CGFloat]
    let columnPreferred: [CGFloat]
    let headerWidths: [CGFloat]
    let sortColumn: Int?
    let sortAscending: Bool

    private(set) lazy var contentKey: String = {
        var hasher = Hasher()
        for row in source { hasher.combine(row) }
        hasher.combine(alignments.map { "\($0)" })
        return "\(source.count)x\(columnCount):\(hasher.finalize())"
    }()

    private let lock = NSLock()
    private var geometries: [String: ChatTableGeometry] = [:]
    private var geometryOrder: [String] = []

    var bodyRowCount: Int { body.count }
    /// Natural (single-line) width; a Mac bubble sizes itself from this.
    var naturalWidth: CGFloat { columnPreferred.reduce(0, +) + 2 }

    convenience init(rows: [[String]], alignments: [TableAlignment]) {
        let columnCount = max(rows.map(\.count).max() ?? 0, 1)
        let normalized = rows.map { row in
            row.count >= columnCount ? Array(row.prefix(columnCount))
                : row + Array(repeating: "", count: columnCount - row.count)
        }
        let headerRow = normalized.first ?? Array(repeating: "", count: columnCount)
        let bodyRows = Array(normalized.dropFirst())
        let numeric = (0..<columnCount).map { column in
            ChatTable.isNumericColumn(bodyRows.map { $0[column] })
        }
        let aligned = (0..<columnCount).map { column -> TableAlignment in
            let explicit = column < alignments.count ? alignments[column] : .leading
            // GFM cannot say "unspecified": a plain `---` parses as leading.
            // Numbers read best right-aligned unless the author centered them.
            return numeric[column] && explicit == .leading ? .trailing : explicit
        }
        self.init(source: normalized, header: headerRow, body: bodyRows, alignments: aligned,
                  numeric: numeric, sortColumn: nil, sortAscending: true)
    }

    private init(source: [[String]], header: [String], body bodyRows: [[String]],
                 alignments: [TableAlignment], numeric: [Bool], sortColumn: Int?, sortAscending: Bool) {
        self.source = source
        self.alignments = alignments
        self.columnCount = header.count
        self.numeric = numeric
        self.sortColumn = sortColumn
        self.sortAscending = sortAscending
        self.header = header.enumerated().map { column, text in
            ChatTable.cell(text, header: true, numeric: numeric[column], alignment: alignments[column])
        }
        self.body = bodyRows.map { row in
            row.enumerated().map { column, text in
                ChatTable.cell(text, header: false, numeric: numeric[column], alignment: alignments[column])
            }
        }
        self.plainHeader = self.header.map(\.string)
        self.plainBody = self.body.map { $0.map(\.string) }

        let pad = ChatTableStyle.padH * 2
        var mins = Array(repeating: CGFloat(0), count: header.count)
        var prefs = Array(repeating: CGFloat(0), count: header.count)
        var headerWidths = Array(repeating: CGFloat(0), count: header.count)
        for column in 0..<header.count {
            let headerWidth = ChatTableText.lineWidth(self.header[column])
            headerWidths[column] = headerWidth
            var minimum = min(headerWidth, 160)
            var preferred = headerWidth
            for row in self.body {
                let cell = row[column]
                guard cell.length > 0 else { continue }
                preferred = max(preferred, ChatTableText.lineWidth(cell))
                minimum = max(minimum, min(ChatTableStyle.minTokenCap, ChatTableText.minTokenWidth(cell)))
            }
            // Numbers never wrap ("27 ms" on one line).
            if numeric[column] { minimum = max(minimum, min(preferred, ChatTableStyle.minTokenCap)) }
            mins[column] = ceil(minimum) + pad
            prefs[column] = ceil(max(min(preferred, ChatTableStyle.preferredCap), minimum)) + pad
        }
        self.columnMin = mins
        self.columnPreferred = prefs
        self.headerWidths = headerWidths
    }

    /// The same table with its body rows reordered by one column (nil = source order).
    func sorted(by column: Int?, ascending: Bool) -> ChatTable {
        let header = source.first ?? []
        var rows = Array(source.dropFirst())
        if let column, column < columnCount {
            let keyed = rows.enumerated().map { index, row in (index, row, ChatTable.sortKey(plainBody[index][column])) }
            rows = keyed.sorted { a, b in
                // Empty cells sink to the bottom in both directions.
                if case .empty = a.2 { if case .empty = b.2 { return a.0 < b.0 }; return false }
                if case .empty = b.2 { return true }
                let order = ChatTable.compare(a.2, b.2)
                if order == .orderedSame { return a.0 < b.0 }
                return ascending ? order == .orderedAscending : order == .orderedDescending
            }.map(\.1)
        }
        return ChatTable(source: [header] + rows, header: header, body: rows, alignments: alignments,
                         numeric: numeric, sortColumn: column, sortAscending: ascending)
    }

    /// Height the table occupies inside a bubble of this width.
    func bubbleHeight(width: CGFloat) -> CGFloat { geometry(width: width).bubbleHeight }

    func geometry(width: CGFloat, full: Bool = false, columnOverrides: [Int: CGFloat] = [:]) -> ChatTableGeometry {
        let width = max(1, (width * 2).rounded() / 2)
        if !columnOverrides.isEmpty {
            return ChatTableGeometry(table: self, width: width, full: full, overrides: columnOverrides)
        }
        let key = "\(width)|\(full ? 1 : 0)"
        lock.lock()
        if let hit = geometries[key] { lock.unlock(); return hit }
        lock.unlock()
        let built = ChatTableGeometry(table: self, width: width, full: full, overrides: [:])
        lock.lock()
        defer { lock.unlock() }
        // Another thread may have built the same width meanwhile: keep one.
        if let raced = geometries[key] { return raced }
        geometries[key] = built
        geometryOrder.append(key)
        if geometryOrder.count > 6 { geometries.removeValue(forKey: geometryOrder.removeFirst()) }
        return built
    }

    // MARK: Export

    func semanticText() -> String {
        ([plainHeader] + plainBody).map { $0.joined(separator: "\t") }.joined(separator: "\n")
    }

    /// Tab-separated values: pastes into Numbers / Excel as real columns.
    func tsv() -> String {
        ([plainHeader] + plainBody).map { row in
            row.map { $0.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ") }
                .joined(separator: "\t")
        }.joined(separator: "\n")
    }

    /// GFM Markdown (cell Markdown preserved).
    func markdown() -> String {
        func line(_ cells: [String]) -> String {
            "| " + cells.map { $0.replacingOccurrences(of: "|", with: "\\|") }.joined(separator: " | ") + " |"
        }
        let separator = "|" + alignments.map { alignment -> String in
            switch alignment {
            case .leading: return " --- "
            case .center: return " :-: "
            case .trailing: return " --: "
            }
        }.joined(separator: "|") + "|"
        let rows = source.map { line($0) }
        guard let first = rows.first else { return "" }
        return ([first, separator] + rows.dropFirst()).joined(separator: "\n")
    }

    // MARK: Cell building

    private static func cell(_ text: String, header: Bool, numeric: Bool, alignment: TableAlignment) -> NSAttributedString {
        let size = header ? ChatTableStyle.headerSize : ChatTableStyle.bodySize
        let paragraph = NSMutableParagraphStyle()
        switch alignment {
        case .leading: paragraph.alignment = .left
        case .center: paragraph.alignment = .center
        case .trailing: paragraph.alignment = .right
        }
        paragraph.lineBreakMode = .byWordWrapping
        paragraph.lineSpacing = header ? 0 : 1
        let result = NSMutableAttributedString()
        for run in parseMarkdownInline(text) {
            var font: ChatTableFont
            if run.code {
                font = ChatTableStyle.mono(size)
            } else if numeric && !header {
                font = ChatTableStyle.digits(size, run.bold ? .semibold : .regular)
            } else {
                font = ChatTableStyle.system(size, header || run.bold ? .semibold : .regular)
            }
            if run.italic && !run.code { font = ChatTableStyle.italic(font) }
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: run.link != nil ? ChatTableStyle.link
                    : (header ? ChatTableStyle.secondary : ChatTableStyle.text),
                .paragraphStyle: paragraph,
            ]
            if let link = run.link { attributes[.link] = link }
            if run.code { attributes[.chatTableCode] = true }
            if run.strikethrough { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            result.append(NSAttributedString(string: run.text, attributes: attributes))
        }
        return result
    }

    // MARK: Numbers

    private static let numericPattern = try! NSRegularExpression(
        pattern: #"^[~≈<>≤≥]?\s?[+\-−±]?[$€£¥]?\s?\d[\d,\s]*(\.\d+)?\s?(%|‰|[kKMBGT]B?|ms|µs|ns|s|m|h|d|x|×|★|pt|px|天|小时|分钟|秒|个|次|行|元)?$"#
    )

    static func isNumericCell(_ text: String) -> Bool {
        let plain = text.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard !plain.isEmpty, plain.count <= 24 else { return false }
        let range = NSRange(location: 0, length: (plain as NSString).length)
        return numericPattern.firstMatch(in: plain, range: range) != nil
    }

    private static func isNumericColumn(_ cells: [String]) -> Bool {
        let filled = cells.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !["—", "-", "–", "N/A", "n/a", "NA", "?"].contains($0) }
        guard !filled.isEmpty else { return false }
        let numbers = filled.filter(isNumericCell).count
        return Double(numbers) / Double(filled.count) >= 0.75
    }

    private enum SortKey { case number(Double), text(String), empty }

    private static func sortKey(_ text: String) -> SortKey {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, !["—", "-", "–", "N/A", "n/a"].contains(trimmed) else { return .empty }
        if isNumericCell(trimmed) {
            let digits = trimmed.replacingOccurrences(of: "−", with: "-")
                .filter { $0.isNumber || $0 == "." || $0 == "-" }
            if let value = Double(digits) { return .number(value) }
        }
        return .text(trimmed)
    }

    private static func compare(_ a: SortKey, _ b: SortKey) -> ComparisonResult {
        switch (a, b) {
        case let (.number(x), .number(y)): return x < y ? .orderedAscending : (x > y ? .orderedDescending : .orderedSame)
        case let (.text(x), .text(y)): return x.localizedStandardCompare(y)
        case (.number, .text): return .orderedAscending
        case (.text, .number): return .orderedDescending
        case (.empty, .empty): return .orderedSame
        // Empty cells always sink to the bottom of an ascending sort.
        case (.empty, _): return .orderedDescending
        case (_, .empty): return .orderedAscending
        }
    }
}

// MARK: - Geometry

final class ChatTableGeometry {
    enum Mode { case grid, cards }

    struct Card {
        struct Field {
            let label: CTFrame
            let value: CTFrame
            let y: CGFloat
            let labelHeight: CGFloat
            let valueHeight: CGFloat
        }
        let y: CGFloat
        let height: CGFloat
        let row: Int
        let title: CTFrame
        let titleHeight: CGFloat
        let trailing: CTLine?
        let fields: [Field]
        let moreLine: CTLine?
        let moreY: CGFloat
    }

    let table: ChatTable
    let width: CGFloat
    let full: Bool
    let mode: Mode
    let columnWidths: [CGFloat]
    let columnOrigins: [CGFloat]
    let contentWidth: CGFloat
    let headerHeight: CGFloat
    /// Body row heights / top edges in content space (header occupies [0, headerHeight]).
    let rowHeights: [CGFloat]
    let rowOrigins: [CGFloat]
    let overflows: Bool
    let pinsFirstColumn: Bool
    let previewRowCount: Int
    /// Height of the grid part shown in the bubble (header + preview rows).
    let previewGridHeight: CGFloat
    let showsFooter: Bool
    let footerText: String
    /// Total height inside a bubble (frame border included).
    let bubbleHeight: CGFloat
    /// Header + every row (full-screen content height).
    let fullHeight: CGFloat
    let cards: [Card]
    let cardLabelWidth: CGFloat
    let hiddenCardFields: Int

    private let lock = NSLock()
    private var frames: [Int: CTFrame] = [:]

    var hiddenRowCount: Int { table.bodyRowCount - previewRowCount }

    init(table: ChatTable, width: CGFloat, full: Bool, overrides: [Int: CGFloat]) {
        self.table = table
        self.width = width
        self.full = full
        let pad = ChatTableStyle.padH * 2
        let inner = max(1, width - 2)
        let mins = table.columnMin
        let prefs = table.columnPreferred
        let sumMin = mins.reduce(0, +)
        let sumPref = prefs.reduce(0, +)

        var widths: [CGFloat]
        var overflows = false
        if sumPref <= inner {
            let extra = inner - sumPref
            widths = prefs.map { $0 + extra * $0 / max(sumPref, 1) }
        } else if sumMin <= inner {
            let share = (inner - sumMin) / max(sumPref - sumMin, 1)
            widths = zip(mins, prefs).map { $0 + ($1 - $0) * share }
        } else {
            // It scrolls sideways anyway: keep cells on one line where
            // reasonable instead of squeezing every column to its minimum.
            widths = zip(mins, prefs).map { max($0, min($1, ChatTableStyle.scrollColumnCap)) }
            overflows = true
        }
        for (column, value) in overrides where column < widths.count {
            widths[column] = max(mins[column] * 0.5, min(value, 900))
        }
        if !overrides.isEmpty { overflows = widths.reduce(0, +) > inner + 0.5 }
        widths = widths.map { floor($0 * 2) / 2 }
        columnWidths = widths
        var origins: [CGFloat] = []
        var x: CGFloat = 0
        for w in widths { origins.append(x); x += w }
        columnOrigins = origins
        contentWidth = max(inner, x)
        self.overflows = overflows

        let headerLine = ceil(ChatTableStyle.system(ChatTableStyle.headerSize, .semibold).lineHeight)
        var headerHeight = headerLine
        for column in 0..<table.columnCount {
            headerHeight = max(headerHeight, ChatTableText.height(table.header[column], width: widths[column] - pad))
        }
        self.headerHeight = ceil(headerHeight) + ChatTableStyle.padV * 2

        let bodyLine = ceil(ChatTableStyle.system(ChatTableStyle.bodySize).lineHeight)
        var heights: [CGFloat] = []
        var tops: [CGFloat] = []
        var y = self.headerHeight
        for row in table.body {
            var h = bodyLine
            for column in 0..<table.columnCount where row[column].length > 0 {
                h = max(h, ChatTableText.height(row[column], width: widths[column] - pad))
            }
            let rowHeight = ceil(h) + ChatTableStyle.padV * 2
            tops.append(y)
            heights.append(rowHeight)
            y += rowHeight
        }
        rowHeights = heights
        rowOrigins = tops
        fullHeight = y
        pinsFirstColumn = overflows && widths.first.map { $0 <= inner * 0.5 } == true

        // Cards: a narrow bubble, a text-heavy table, few rows, and a grid that
        // would scroll sideways or wrap into a tall ladder.
        let textColumns = (1..<max(table.columnCount, 1)).filter { !table.numeric[$0] }
        let textHeavy = table.columnCount >= 3 && textColumns.count >= 2
            && textColumns.map { prefs[$0] }.reduce(0, +) / CGFloat(max(textColumns.count, 1)) > 140
        let ladder = heights.contains { $0 > bodyLine * 4 + ChatTableStyle.padV * 2 }
        let useCards = !full && overrides.isEmpty && width < ChatTableStyle.compactWidth
            && textHeavy && table.bodyRowCount > 0 && table.bodyRowCount <= ChatTableStyle.previewRowLimit
            && (overflows || ladder)
        mode = useCards ? .cards : .grid

        let previewRows = full ? table.bodyRowCount : min(table.bodyRowCount, ChatTableStyle.previewRowLimit)
        previewRowCount = previewRows
        previewGridHeight = previewRows > 0 ? rowOrigins[previewRows - 1] + rowHeights[previewRows - 1] : self.headerHeight

        if useCards {
            let built = ChatTableGeometry.layoutCards(table: table, width: inner)
            cards = built.cards
            cardLabelWidth = built.labelWidth
            hiddenCardFields = built.hidden
            showsFooter = false
            footerText = ""
            bubbleHeight = (cards.last.map { $0.y + $0.height } ?? 0) + 2
        } else {
            cards = []
            cardLabelWidth = 0
            hiddenCardFields = 0
            let hidden = table.bodyRowCount - previewRows
            showsFooter = !full && (hidden > 0 || overflows)
            if hidden > 0 {
                footerText = "Showing \(previewRows) of \(table.bodyRowCount) rows · \(table.columnCount) columns"
            } else if overflows {
                #if os(iOS)
                footerText = "\(table.columnCount) columns · swipe for more"
                #else
                footerText = "\(table.columnCount) columns · scroll for more"
                #endif
            } else {
                footerText = ""
            }
            bubbleHeight = previewGridHeight + (showsFooter ? ChatTableStyle.footerHeight : 0) + 2
        }
    }

    // MARK: Cards

    private static func layoutCards(table: ChatTable, width: CGFloat) -> (cards: [Card], labelWidth: CGFloat, hidden: Int) {
        let pad = ChatTableStyle.padH
        let trailingColumn = (1..<table.columnCount).first { column in
            table.numeric[column] && table.plainBody.allSatisfy { $0[column].count <= 12 }
        }
        let fieldColumns = (1..<table.columnCount).filter { $0 != trailingColumn }
        let shownColumns = Array(fieldColumns.prefix(ChatTableStyle.cardFieldLimit))
        let hiddenPerCard = fieldColumns.count - shownColumns.count
        let labels = shownColumns.map { ChatTableText.restyled(table.header[$0], size: ChatTableStyle.headerSize,
                                                               weight: .regular, color: ChatTableStyle.secondary) }
        let labelWidth = min(96, ceil(labels.map(ChatTableText.lineWidth).max() ?? 0))
        let valueX = pad + labelWidth + 10
        let valueWidth = max(40, width - valueX - pad)

        var cards: [Card] = []
        var y: CGFloat = 0
        for (rowIndex, row) in table.body.enumerated() {
            var trailing: CTLine?
            var trailingWidth: CGFloat = 0
            if let trailingColumn, row[trailingColumn].length > 0 {
                let value = ChatTableText.restyled(row[trailingColumn], size: ChatTableStyle.bodySize,
                                                   weight: .regular, color: ChatTableStyle.secondary)
                trailing = CTLineCreateWithAttributedString(value)
                trailingWidth = ChatTableText.lineWidth(value) + 10
            }
            let title = ChatTableText.restyled(row[0], size: ChatTableStyle.bodySize + 0.5, weight: .semibold,
                                               color: ChatTableStyle.text, keepLinks: true, align: .left)
            let titleWidth = max(40, width - pad * 2 - trailingWidth)
            let titleHeight = ceil(ChatTableText.height(title, width: titleWidth))
            let titleFrame = ChatTableText.frame(title, width: titleWidth, height: titleHeight)
            var fy = ChatTableStyle.padV + 2 + titleHeight + 4
            var fields: [Card.Field] = []
            for (index, column) in shownColumns.enumerated() {
                let value = ChatTableText.restyled(row[column], size: ChatTableStyle.bodySize, weight: nil,
                                                   color: nil, keepLinks: true, align: .left)
                let shown = value.length > 0 ? value
                    : ChatTableText.restyled(NSAttributedString(string: "—"), size: ChatTableStyle.bodySize,
                                             weight: .regular, color: ChatTableStyle.secondary)
                let labelHeight = ceil(ChatTableText.height(labels[index], width: labelWidth))
                let valueHeight = ceil(ChatTableText.height(shown, width: valueWidth))
                fields.append(Card.Field(
                    label: ChatTableText.frame(labels[index], width: labelWidth, height: labelHeight),
                    value: ChatTableText.frame(shown, width: valueWidth, height: valueHeight),
                    y: fy, labelHeight: labelHeight, valueHeight: valueHeight))
                fy += max(labelHeight, valueHeight) + 3
            }
            var moreLine: CTLine?
            let moreY = fy + 1
            if hiddenPerCard > 0 {
                let more = NSAttributedString(string: "+\(hiddenPerCard) more \(hiddenPerCard == 1 ? "field" : "fields") · Open table", attributes: [
                    .font: ChatTableStyle.system(ChatTableStyle.headerSize, .medium),
                    .foregroundColor: ChatTableStyle.link,
                ])
                moreLine = CTLineCreateWithAttributedString(more)
                fy += ceil(ChatTableStyle.system(ChatTableStyle.headerSize).lineHeight) + 4
            }
            let height = fy - 3 + ChatTableStyle.padV + 2
            cards.append(Card(y: y, height: height, row: rowIndex, title: titleFrame, titleHeight: titleHeight,
                              trailing: trailing, fields: fields, moreLine: moreLine, moreY: moreY))
            y += height
        }
        return (cards, labelWidth, hiddenPerCard)
    }

    // MARK: Cell frames

    func cellFrame(row: Int, column: Int) -> CTFrame {
        let key = (row + 1) * 4096 + column
        lock.lock()
        if let hit = frames[key] { lock.unlock(); return hit }
        lock.unlock()
        let string = row < 0 ? table.header[column] : table.body[row][column]
        let width = max(1, columnWidths[column] - ChatTableStyle.padH * 2)
        let height = row < 0 ? headerHeight : rowHeights[row]
        let frame = ChatTableText.frame(string, width: width, height: height)
        lock.lock()
        frames[key] = frame
        lock.unlock()
        return frame
    }

    func row(atY y: CGFloat) -> Int? {
        guard y >= headerHeight, !rowOrigins.isEmpty else { return nil }
        var low = 0, high = rowOrigins.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if rowOrigins[mid] <= y { low = mid } else { high = mid - 1 }
        }
        return y < rowOrigins[low] + rowHeights[low] ? low : nil
    }

    func column(atX x: CGFloat) -> Int? {
        for column in columnOrigins.indices.reversed() where x >= columnOrigins[column] {
            return x < columnOrigins[column] + columnWidths[column] ? column : nil
        }
        return nil
    }

    /// Resolve a point in grid content space, honoring a pinned first column
    /// at viewport x `viewportMinX`.
    func gridCell(at point: CGPoint, viewportMinX: CGFloat, viewportMinY: CGFloat, stickyHeader: Bool) -> (row: Int, column: Int, local: CGPoint)? {
        var x = point.x
        if pinsFirstColumn, point.x - viewportMinX < columnWidths[0], viewportMinX > 0 {
            x = point.x - viewportMinX
        }
        guard let column = column(atX: x) else { return nil }
        let headerTop = stickyHeader ? viewportMinY : 0
        if point.y >= headerTop, point.y < headerTop + headerHeight {
            return (-1, column, CGPoint(x: x - columnOrigins[column], y: point.y - headerTop))
        }
        guard let row = row(atY: point.y) else { return nil }
        return (row, column, CGPoint(x: x - columnOrigins[column], y: point.y - rowOrigins[row]))
    }

    func link(at point: CGPoint, viewportMinX: CGFloat = 0, viewportMinY: CGFloat = 0, stickyHeader: Bool = false) -> URL? {
        if mode == .cards { return cardLink(at: point) }
        guard let hit = gridCell(at: point, viewportMinX: viewportMinX, viewportMinY: viewportMinY, stickyHeader: stickyHeader),
              hit.row >= 0 else { return nil }
        return ChatTableText.link(in: cellFrame(row: hit.row, column: hit.column),
                                  at: CGPoint(x: hit.local.x - ChatTableStyle.padH, y: hit.local.y - ChatTableStyle.padV))
    }

    private func cardLink(at point: CGPoint) -> URL? {
        guard let card = cards.first(where: { point.y >= $0.y && point.y < $0.y + $0.height }) else { return nil }
        let local = CGPoint(x: point.x - 1, y: point.y - 1 - card.y)
        if local.y < ChatTableStyle.padV + 2 + card.titleHeight {
            return ChatTableText.link(in: card.title, at: CGPoint(x: local.x - ChatTableStyle.padH, y: local.y - ChatTableStyle.padV - 2))
        }
        let valueX = ChatTableStyle.padH + cardLabelWidth + 10
        for field in card.fields where local.y >= field.y && local.y < field.y + field.valueHeight {
            return ChatTableText.link(in: field.value, at: CGPoint(x: local.x - valueX, y: local.y - field.y))
        }
        return nil
    }

    // MARK: Drawing

    /// Draw the grid into a flipped context whose origin is the viewport's
    /// top-left. `viewport` is in content coordinates.
    func drawGrid(in context: CGContext, viewport: CGRect, rowLimit: Int, stickyHeader: Bool,
                  paint: ChatTablePaint, highlightedRows: Set<Int> = [], currentRow: Int? = nil) {
        context.saveGState()
        context.translateBy(x: -viewport.minX, y: -viewport.minY)
        let rowCount = min(rowLimit, rowHeights.count)
        let visibleColumns = columnOrigins.indices.filter {
            columnOrigins[$0] + columnWidths[$0] > viewport.minX && columnOrigins[$0] < viewport.maxX
        }
        let firstRow = row(atY: max(viewport.minY, headerHeight)) ?? (viewport.minY < headerHeight ? 0 : rowCount)
        let pin = pinsFirstColumn && viewport.minX > 0.5
        let pinX = viewport.minX

        func drawRows(columns: [Int], xShift: (Int) -> CGFloat) {
            var row = firstRow
            while row < rowCount, rowOrigins[row] < viewport.maxY {
                let top = rowOrigins[row]
                if highlightedRows.contains(row) {
                    context.setFillColor(row == currentRow ? paint.accent : paint.highlight)
                    let minX = columns.map { columnOrigins[$0] + xShift($0) }.min() ?? 0
                    let maxX = columns.map { columnOrigins[$0] + xShift($0) + columnWidths[$0] }.max() ?? 0
                    context.fill(CGRect(x: minX, y: top, width: maxX - minX, height: rowHeights[row]))
                }
                for column in columns {
                    drawCell(in: context, frame: cellFrame(row: row, column: column),
                             x: columnOrigins[column] + xShift(column) + ChatTableStyle.padH,
                             y: top + ChatTableStyle.padV, height: rowHeights[row], paint: paint)
                }
                if row > 0 {
                    context.setFillColor(paint.hairline)
                    let minX = columns.map { columnOrigins[$0] + xShift($0) }.min() ?? 0
                    let maxX = columns.map { columnOrigins[$0] + xShift($0) + columnWidths[$0] }.max() ?? 0
                    context.fill(CGRect(x: minX, y: top - 0.5, width: maxX - minX, height: 1 / 2))
                }
                row += 1
            }
        }

        drawRows(columns: visibleColumns, xShift: { _ in 0 })

        if pin {
            let w = columnWidths[0]
            let top = max(viewport.minY, headerHeight)
            let bottom = min(viewport.maxY, rowCount > 0 ? rowOrigins[rowCount - 1] + rowHeights[rowCount - 1] : headerHeight)
            context.setFillColor(paint.surface)
            context.fill(CGRect(x: pinX, y: top, width: w, height: max(0, bottom - top)))
            drawRows(columns: [0], xShift: { _ in pinX })
            context.setFillColor(paint.hairline)
            context.fill(CGRect(x: pinX + w - 0.5, y: viewport.minY, width: 0.5, height: viewport.height))
        }

        // Header (sticky in full screen).
        let headerTop = stickyHeader ? viewport.minY : 0
        if headerTop + headerHeight > viewport.minY {
            context.setFillColor(paint.surface)
            context.fill(CGRect(x: viewport.minX, y: headerTop, width: viewport.width, height: headerHeight))
            context.setFillColor(paint.headerFill)
            context.fill(CGRect(x: viewport.minX, y: headerTop, width: viewport.width, height: headerHeight))
            var headerColumns = visibleColumns
            if pin { headerColumns.removeAll { $0 == 0 } }
            for column in headerColumns {
                drawCell(in: context, frame: cellFrame(row: -1, column: column),
                         x: columnOrigins[column] + ChatTableStyle.padH, y: headerTop + ChatTableStyle.padV,
                         height: headerHeight, paint: paint)
                if column == table.sortColumn {
                    drawSortMark(in: context, column: column, x: columnOrigins[column], top: headerTop, paint: paint)
                }
            }
            if pin {
                context.setFillColor(paint.surface)
                context.fill(CGRect(x: pinX, y: headerTop, width: columnWidths[0], height: headerHeight))
                context.setFillColor(paint.headerFill)
                context.fill(CGRect(x: pinX, y: headerTop, width: columnWidths[0], height: headerHeight))
                drawCell(in: context, frame: cellFrame(row: -1, column: 0), x: pinX + ChatTableStyle.padH,
                         y: headerTop + ChatTableStyle.padV, height: headerHeight, paint: paint)
                if table.sortColumn == 0 { drawSortMark(in: context, column: 0, x: pinX, top: headerTop, paint: paint) }
                context.setFillColor(paint.hairline)
                context.fill(CGRect(x: pinX + columnWidths[0] - 0.5, y: headerTop, width: 0.5, height: headerHeight))
            }
            context.setFillColor(paint.hairline)
            context.fill(CGRect(x: viewport.minX, y: headerTop + headerHeight - 0.5, width: viewport.width, height: 0.5))
        }
        context.restoreGState()
    }

    private func drawSortMark(in context: CGContext, column: Int, x: CGFloat, top: CGFloat, paint: ChatTablePaint) {
        let arrow = table.sortAscending ? "↑" : "↓"
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: arrow, attributes: [
            .font: ChatTableStyle.system(ChatTableStyle.headerSize, .bold),
            .foregroundColor: ChatTableStyle.link,
        ]))
        let numericColumn = table.alignments[column] == .trailing
        let width = ChatTableText.lineWidth(table.header[column])
        let arrowX = numericColumn ? x + columnWidths[column] - ChatTableStyle.padH - width - 12
            : x + ChatTableStyle.padH + width + 3
        ChatTableText.draw(line, in: context, at: CGPoint(x: arrowX, y: top + ChatTableStyle.padV))
    }

    func drawCards(in context: CGContext, paint: ChatTablePaint) {
        let pad = ChatTableStyle.padH
        for (index, card) in cards.enumerated() {
            let top = card.y + 1
            if index > 0 {
                context.setFillColor(paint.hairline)
                context.fill(CGRect(x: 1, y: top - 0.5, width: width - 2, height: 0.5))
            }
            drawCell(in: context, frame: card.title, x: pad + 1, y: top + ChatTableStyle.padV + 2,
                     height: card.titleHeight, paint: paint)
            if let trailing = card.trailing {
                let w = CGFloat(CTLineGetTypographicBounds(trailing, nil, nil, nil))
                ChatTableText.draw(trailing, in: context, at: CGPoint(x: width - 1 - pad - w, y: top + ChatTableStyle.padV + 3))
            }
            for field in card.fields {
                drawCell(in: context, frame: field.label, x: pad + 1, y: top + field.y + 1,
                         height: field.labelHeight, paint: paint)
                drawCell(in: context, frame: field.value, x: pad + 1 + cardLabelWidth + 10, y: top + field.y,
                         height: field.valueHeight, paint: paint)
            }
            if let more = card.moreLine {
                ChatTableText.draw(more, in: context, at: CGPoint(x: pad + 1, y: top + card.moreY))
            }
        }
    }

    private func drawCell(in context: CGContext, frame: CTFrame, x: CGFloat, y: CGFloat, height: CGFloat,
                          paint: ChatTablePaint) {
        ChatTableText.draw(frame, in: context, at: CGPoint(x: x, y: y), codeFill: paint.codeFill)
    }
}

// MARK: - CoreText helpers

enum ChatTableText {
    static func lineWidth(_ string: NSAttributedString) -> CGFloat {
        guard string.length > 0 else { return 0 }
        let line = CTLineCreateWithAttributedString(string)
        return ceil(CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil)))
    }

    static func height(_ string: NSAttributedString, width: CGFloat) -> CGFloat {
        guard string.length > 0 else { return 0 }
        let setter = CTFramesetterCreateWithAttributedString(string)
        let size = CTFramesetterSuggestFrameSizeWithConstraints(
            setter, CFRange(location: 0, length: 0), nil,
            CGSize(width: max(1, width), height: .greatestFiniteMagnitude), nil)
        return ceil(size.height)
    }

    static func frame(_ string: NSAttributedString, width: CGFloat, height: CGFloat) -> CTFrame {
        let setter = CTFramesetterCreateWithAttributedString(string)
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: max(1, width), height: max(1, height) + 4), transform: nil)
        return CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
    }

    /// Widest run that cannot be broken: words, path components (breakable
    /// after "/"), and single CJK characters.
    static func minTokenWidth(_ string: NSAttributedString) -> CGFloat {
        let text = string.string as NSString
        var best: CGFloat = 0
        var start = 0
        func measure(_ location: Int, _ length: Int) {
            guard length > 0 else { return }
            best = max(best, lineWidth(string.attributedSubstring(from: NSRange(location: location, length: length))))
        }
        for index in 0..<text.length {
            let unit = text.character(at: index)
            if unit == 0x20 || unit == 0x09 || unit == 0x0A {
                measure(start, index - start)
                start = index + 1
            } else if unit == 0x2F {
                measure(start, index + 1 - start)
                start = index + 1
            } else if (0x2E80...0x9FFF).contains(unit) || (0xAC00...0xD7AF).contains(unit) || (0xFF00...0xFFEF).contains(unit) {
                measure(start, index - start)
                measure(index, 1)
                start = index + 1
            }
        }
        measure(start, text.length - start)
        return best
    }

    /// Same characters with another font/color; inline code and links survive.
    static func restyled(_ source: NSAttributedString, size: CGFloat, weight: ChatTableFont.Weight?,
                         color: PlatformColor?, keepLinks: Bool = false,
                         align: NSTextAlignment? = nil) -> NSAttributedString {
        let result = NSMutableAttributedString(attributedString: source)
        let range = NSRange(location: 0, length: result.length)
        result.enumerateAttributes(in: range) { attributes, subrange, _ in
            let isCode = attributes[.chatTableCode] != nil
            let isLink = attributes[.link] != nil
            if !isCode, let weight {
                result.addAttribute(.font, value: ChatTableStyle.system(size, weight), range: subrange)
            } else if !isCode, let font = attributes[.font] as? ChatTableFont {
                #if os(iOS)
                let resized = font.withSize(size)
                #else
                let resized = NSFont(descriptor: font.fontDescriptor, size: size) ?? font
                #endif
                result.addAttribute(.font, value: resized, range: subrange)
            }
            if let color, !(keepLinks && isLink) {
                result.addAttribute(.foregroundColor, value: color, range: subrange)
            }
            if !keepLinks { result.removeAttribute(.link, range: subrange) }
        }
        if let align {
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = align
            paragraph.lineBreakMode = .byWordWrapping
            paragraph.lineSpacing = 1
            result.addAttribute(.paragraphStyle, value: paragraph, range: range)
        }
        return result
    }

    /// Draw a frame laid out by `frame(_:width:height:)` with its top-left at
    /// `origin` in a flipped context. Inline-code runs get a rounded chip.
    static func draw(_ frame: CTFrame, in context: CGContext, at origin: CGPoint, codeFill: CGColor? = nil) {
        let path = CTFrameGetPath(frame)
        let box = path.boundingBox
        let lines = CTFrameGetLines(frame) as! [CTLine]
        guard !lines.isEmpty else { return }
        var origins = Array(repeating: CGPoint.zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: origin.x, y: origin.y + box.height)
        context.scaleBy(x: 1, y: -1)
        if let codeFill {
            for (index, line) in lines.enumerated() {
                for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                    let attributes = CTRunGetAttributes(run) as NSDictionary
                    guard attributes[NSAttributedString.Key.chatTableCode] != nil else { continue }
                    var ascent: CGFloat = 0, descent: CGFloat = 0
                    let width = CGFloat(CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0), &ascent, &descent, nil))
                    let range = CTRunGetStringRange(run)
                    let x = CTLineGetOffsetForStringIndex(line, range.location, nil)
                    let rect = CGRect(x: origins[index].x + x - 3, y: origins[index].y - descent - 1.5,
                                      width: width + 6, height: ascent + descent + 3)
                    context.setFillColor(codeFill)
                    context.addPath(CGPath(roundedRect: rect, cornerWidth: 4, cornerHeight: 4, transform: nil))
                    context.fillPath()
                }
            }
        }
        CTFrameDraw(frame, context)
        context.restoreGState()
    }

    /// Single line with its top-left at `origin` in a flipped context.
    static func draw(_ line: CTLine, in context: CGContext, at origin: CGPoint) {
        var ascent: CGFloat = 0
        _ = CTLineGetTypographicBounds(line, &ascent, nil, nil)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: origin.x, y: origin.y + ascent)
        context.scaleBy(x: 1, y: -1)
        context.textPosition = .zero
        CTLineDraw(line, context)
        context.restoreGState()
    }

    /// Link under `point` (top-left-origin coordinates inside the frame).
    static func link(in frame: CTFrame, at point: CGPoint) -> URL? {
        let box = CTFrameGetPath(frame).boundingBox
        let lines = CTFrameGetLines(frame) as! [CTLine]
        guard !lines.isEmpty, point.x >= -4 else { return nil }
        var origins = Array(repeating: CGPoint.zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        let flippedY = box.height - point.y
        for (index, line) in lines.enumerated() {
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            _ = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            let lineTop = origins[index].y + ascent + 2
            let lineBottom = origins[index].y - descent - leading - 2
            guard flippedY <= lineTop, flippedY >= lineBottom else { continue }
            let x = point.x - origins[index].x
            let lineWidth = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
            guard x >= -2, x <= lineWidth + 2 else { return nil }
            let stringIndex = CTLineGetStringIndexForPosition(line, CGPoint(x: x, y: 0))
            for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                let range = CTRunGetStringRange(run)
                guard stringIndex >= range.location, stringIndex <= range.location + range.length else { continue }
                let attributes = CTRunGetAttributes(run) as NSDictionary
                switch attributes[NSAttributedString.Key.link] {
                case let url as URL: return url
                case let string as String: return URL(string: string)
                default: continue
                }
            }
            return nil
        }
        return nil
    }
}

#if os(macOS)
extension NSFont {
    /// UIKit-style line height for shared measuring code.
    var lineHeight: CGFloat { ceil(ascender - descender + leading) }
}
#endif
