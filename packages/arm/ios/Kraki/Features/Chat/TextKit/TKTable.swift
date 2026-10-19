/// Markdown tables in iOS bubbles: the scrollable table view, its attachment, and the full-screen table sheet.

import UIKit

typealias TKTableLayout = ChatTable

extension ChatTablePaint {
    static func current(surface: UIColor, traits: UITraitCollection) -> ChatTablePaint {
        func resolve(_ color: UIColor) -> CGColor { color.resolvedColor(with: traits).cgColor }
        return ChatTablePaint(
            hairline: resolve(UIColor.label.withAlphaComponent(0.13)),
            headerFill: resolve(UIColor.label.withAlphaComponent(0.05)),
            codeFill: resolve(UIColor.label.withAlphaComponent(0.08)),
            surface: resolve(surface),
            highlight: resolve(UIColor.systemYellow.withAlphaComponent(0.22)),
            accent: resolve(UIColor.systemYellow.withAlphaComponent(0.45))
        )
    }
}

/// Draws the part of a table currently on screen. Lives at the scroll view's
/// visible bounds (it does not scroll), so pinned first column and sticky
/// header are simply drawn at the viewport edge.
private final class TKTableCanvasView: UIView {
    weak var host: TKTableScrollView?

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        contentMode = .redraw
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ rect: CGRect) {
        guard let host, let geometry = host.geometry, let context = UIGraphicsGetCurrentContext() else { return }
        let paint = ChatTablePaint.current(surface: host.surfaceColor, traits: traitCollection)
        if geometry.mode == .cards {
            geometry.drawCards(in: context, paint: paint)
            return
        }
        let viewport = CGRect(x: host.contentOffset.x, y: host.full ? host.contentOffset.y : 0,
                              width: bounds.width, height: bounds.height)
        geometry.drawGrid(in: context, viewport: viewport,
                          rowLimit: host.full ? geometry.rowHeights.count : geometry.previewRowCount,
                          stickyHeader: host.full, paint: paint)
    }
}

/// One table in a bubble (preview) or full screen. Grid previews scroll
/// sideways with the first column pinned; full screen scrolls both ways with
/// a sticky header and first column. Cards never scroll.
final class TKTableScrollView: UIScrollView, UIScrollViewDelegate, UIContextMenuInteractionDelegate {
    private(set) var tableLayout: ChatTable
    let full: Bool
    var onShowAll: (() -> Void)?
    /// Full screen: header taps sort; the new table is reported here.
    var onSort: ((ChatTable) -> Void)?
    /// Opaque color behind pinned/sticky cells (the bubble or page).
    var surfaceColor: UIColor = .systemBackground { didSet { canvas.setNeedsDisplay() } }
    private(set) var geometry: ChatTableGeometry?

    private let canvas = TKTableCanvasView()
    private let footer = UIView()
    private let footerLabel = UILabel()
    private let footerButton = UIButton(type: .system)
    private let fade = CAGradientLayer()
    private let fadeView = UIView()

    init(layout: ChatTable, fullTable: Bool = false) {
        tableLayout = layout
        full = fullTable
        super.init(frame: .zero)
        delegate = self
        backgroundColor = .clear
        showsVerticalScrollIndicator = fullTable
        showsHorizontalScrollIndicator = true
        alwaysBounceHorizontal = false
        alwaysBounceVertical = fullTable
        isDirectionalLockEnabled = true
        delaysContentTouches = false
        clipsToBounds = true
        if !fullTable {
            layer.cornerRadius = ChatTableStyle.cornerRadius
            layer.cornerCurve = .continuous
            layer.borderWidth = 1
        }
        canvas.host = self
        addSubview(canvas)

        fadeView.isUserInteractionEnabled = false
        fadeView.layer.addSublayer(fade)
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        addSubview(fadeView)

        footerLabel.font = .systemFont(ofSize: 12.5)
        footerLabel.textColor = .secondaryLabel
        footerLabel.lineBreakMode = .byTruncatingTail
        var config = UIButton.Configuration.plain()
        config.title = String(localized: "Open table")
        config.image = UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
        config.imagePlacement = .trailing
        config.imagePadding = 3
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 0)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var updated = attributes
            updated.font = .systemFont(ofSize: 12.5, weight: .semibold)
            return updated
        }
        footerButton.configuration = config
        footerButton.addTarget(self, action: #selector(showAllRows), for: .touchUpInside)
        footer.addSubview(footerLabel)
        footer.addSubview(footerButton)
        addSubview(footer)

        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
        addInteraction(UIContextMenuInteraction(delegate: self))

        isAccessibilityElement = true
        let rows = String(localized: "\(layout.bodyRowCount) rows")
        let columns = String(localized: "\(layout.columnCount) columns")
        accessibilityLabel = String(localized: "Table, \(rows), \(columns)")
        accessibilityValue = layout.semanticText()
        accessibilityTraits = [.adjustable]
        accessibilityCustomActions = [
            UIAccessibilityCustomAction(name: String(localized: "Open table"), target: self, selector: #selector(accessibilityShowAllRows)),
            UIAccessibilityCustomAction(name: String(localized: "Copy table"), target: self, selector: #selector(accessibilityCopy)),
        ]
    }

    required init?(coder: NSCoder) { fatalError() }

    func replaceTable(_ table: ChatTable) {
        tableLayout = table
        geometry = nil
        accessibilityValue = table.semanticText()
        setNeedsLayout()
        canvas.setNeedsDisplay()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 1 else { return }
        if geometry?.width != bounds.width {
            geometry = tableLayout.geometry(width: bounds.width, full: full)
            canvas.setNeedsDisplay()
        }
        guard let geometry else { return }
        layer.borderColor = UIColor.label.withAlphaComponent(0.16).resolvedColor(with: traitCollection).cgColor
        let cards = geometry.mode == .cards
        let gridHeight = full ? bounds.height : (cards ? geometry.bubbleHeight - 2 : geometry.previewGridHeight)
        let contentHeight = full ? geometry.fullHeight : gridHeight
        let newContentSize = CGSize(width: cards ? bounds.width : geometry.contentWidth, height: contentHeight)
        if contentSize != newContentSize { contentSize = newContentSize }
        canvas.frame = CGRect(x: contentOffset.x, y: full ? contentOffset.y : 0,
                              width: bounds.width, height: gridHeight)
        canvas.setNeedsDisplay()

        footer.isHidden = !geometry.showsFooter
        if geometry.showsFooter {
            footer.frame = CGRect(x: contentOffset.x, y: geometry.previewGridHeight,
                                  width: bounds.width, height: ChatTableStyle.footerHeight)
            footer.backgroundColor = UIColor.label.withAlphaComponent(0.04)
            footerLabel.text = geometry.footerText
            let buttonWidth = footerButton.intrinsicContentSize.width
            footerButton.frame = CGRect(x: bounds.width - buttonWidth - 6, y: 0, width: buttonWidth, height: ChatTableStyle.footerHeight)
            footerLabel.frame = CGRect(x: ChatTableStyle.padH, y: 0,
                                       width: max(0, footerButton.frame.minX - ChatTableStyle.padH - 4),
                                       height: ChatTableStyle.footerHeight)
            let line = footer.layer.sublayers?.first(where: { $0.name == "rule" }) ?? {
                let rule = CALayer(); rule.name = "rule"; footer.layer.addSublayer(rule); return rule
            }()
            line.frame = CGRect(x: 0, y: 0, width: bounds.width, height: 0.5)
            line.backgroundColor = UIColor.label.withAlphaComponent(0.13).resolvedColor(with: traitCollection).cgColor
        }

        let maxOffset = max(0, contentSize.width - bounds.width)
        let showsFade = !cards && maxOffset > 1 && contentOffset.x < maxOffset - 1
        fadeView.isHidden = !showsFade
        if showsFade {
            fadeView.frame = CGRect(x: contentOffset.x + bounds.width - 28, y: full ? contentOffset.y : 0,
                                    width: 28, height: gridHeight)
            fade.frame = fadeView.bounds
            let surface = surfaceColor.resolvedColor(with: traitCollection)
            fade.colors = [surface.withAlphaComponent(0).cgColor, surface.cgColor]
        }
        bringSubviewToFront(fadeView)
        bringSubviewToFront(footer)
        showsHorizontalScrollIndicator = maxOffset > 1
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        setNeedsLayout()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        setNeedsLayout()
        canvas.setNeedsDisplay()
    }

    // MARK: Interaction

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        guard let geometry else { return }
        let point = gesture.location(in: self)
        if !footer.isHidden, footer.frame.contains(point) { return }
        if geometry.mode == .cards {
            if let url = geometry.link(at: CGPoint(x: point.x, y: point.y)) { open(url) }
            else if geometry.hiddenCardFields > 0 { onShowAll?() }
            return
        }
        let viewportY = full ? contentOffset.y : 0
        if full, let hit = geometry.gridCell(at: point, viewportMinX: contentOffset.x, viewportMinY: viewportY,
                                             stickyHeader: true), hit.row < 0 {
            sort(by: hit.column)
            return
        }
        if let url = geometry.link(at: point, viewportMinX: contentOffset.x, viewportMinY: viewportY, stickyHeader: full) {
            open(url)
        }
    }

    private func sort(by column: Int) {
        let next: ChatTable
        if tableLayout.sortColumn == column {
            next = tableLayout.sortAscending ? tableLayout.sorted(by: column, ascending: false)
                : tableLayout.sorted(by: nil, ascending: true)
        } else {
            next = tableLayout.sorted(by: column, ascending: !tableLayout.numeric[column])
        }
        replaceTable(next)
        onSort?(next)
    }

    private func open(_ url: URL) {
        guard isSafeLinkURL(url) else { return }
        UIApplication.shared.open(url)
    }

    @objc private func showAllRows() { onShowAll?() }

    @objc private func accessibilityShowAllRows() -> Bool {
        onShowAll?()
        return true
    }

    @objc private func accessibilityCopy() -> Bool {
        UIPasteboard.general.string = tableLayout.markdown()
        return true
    }

    override func accessibilityIncrement() { scrollHorizontally(direction: 1) }
    override func accessibilityDecrement() { scrollHorizontally(direction: -1) }

    private func scrollHorizontally(direction: CGFloat) {
        let maximum = max(0, contentSize.width - bounds.width)
        let target = min(maximum, max(0, contentOffset.x + direction * bounds.width * 0.8))
        setContentOffset(CGPoint(x: target, y: contentOffset.y), animated: true)
    }

    func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
                                configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            var actions: [UIMenuElement] = [
                UIAction(title: String(localized: "Copy Table"), image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                    UIPasteboard.general.string = self?.tableLayout.markdown()
                },
                UIAction(title: String(localized: "Copy as TSV"), image: UIImage(systemName: "tablecells")) { [weak self] _ in
                    UIPasteboard.general.string = self?.tableLayout.tsv()
                },
            ]
            if !self.full, self.onShowAll != nil {
                actions.append(UIAction(title: String(localized: "Open Table"), image: UIImage(systemName: "arrow.up.left.and.arrow.down.right")) { [weak self] _ in
                    self?.onShowAll?()
                })
            }
            return UIMenu(children: actions)
        }
    }
}

final class TKTableAttachment: NSTextAttachment {
    let tableLayout: ChatTable

    init(rows: [[String]], alignments: [TableAlignment]) {
        tableLayout = ChatTable(rows: rows, alignments: alignments)
        super.init(data: nil, ofType: nil)
        allowsTextAttachmentView = false
        image = Self.transparentPixel
    }

    required init?(coder: NSCoder) { fatalError() }

    private static let transparentPixel: UIImage = {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1))
        return renderer.image { _ in }
    }()

    override func attachmentBounds(
        for attributes: [NSAttributedString.Key: Any],
        location: NSTextLocation,
        textContainer: NSTextContainer?,
        proposedLineFragment: CGRect,
        position: CGPoint
    ) -> CGRect {
        CGRect(x: 0, y: 0, width: proposedLineFragment.width,
               height: tableLayout.bubbleHeight(width: proposedLineFragment.width) + Self.verticalSpacing)
    }

    /// Breathing room below a table (the attachment line carries it).
    static let verticalSpacing: CGFloat = 6
}

final class TKTableSheetViewController: UIViewController {
    private var tableLayout: ChatTable
    private let titleLabel = UILabel()
    private let subtitleLabel = UILabel()

    init(layout: ChatTable) {
        tableLayout = layout
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let close = UIBarButtonItem(systemItem: .close)
        close.target = self
        close.action = #selector(dismissSheet)
        navigationItem.leftBarButtonItem = close
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: String(localized: "Copy"), image: nil, primaryAction: nil,
            menu: UIMenu(children: [
                UIAction(title: String(localized: "Copy Table"), image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                    UIPasteboard.general.string = self?.tableLayout.markdown()
                },
                UIAction(title: String(localized: "Copy as TSV"), image: UIImage(systemName: "tablecells")) { [weak self] _ in
                    UIPasteboard.general.string = self?.tableLayout.tsv()
                },
            ]))

        titleLabel.text = String(localized: "Table")
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        subtitleLabel.font = .systemFont(ofSize: 12)
        subtitleLabel.textColor = .secondaryLabel
        let titleStack = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
        titleStack.axis = .vertical
        titleStack.alignment = .center
        navigationItem.titleView = titleStack
        updateSubtitle()

        let table = TKTableScrollView(layout: tableLayout, fullTable: true)
        table.surfaceColor = .systemBackground
        table.onSort = { [weak self] sorted in
            self?.tableLayout = sorted
            self?.updateSubtitle()
        }
        table.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(table)
        NSLayoutConstraint.activate([
            table.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            table.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            table.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            table.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    private func updateSubtitle() {
        let rows = String(localized: "\(tableLayout.bodyRowCount) rows")
        let columns = String(localized: "\(tableLayout.columnCount) columns")
        if let column = tableLayout.sortColumn {
            subtitleLabel.text = String(localized: "\(rows) × \(columns) · sorted by \(tableLayout.plainHeader[column])")
        } else {
            subtitleLabel.text = String(localized: "\(rows) × \(columns)")
        }
    }

    @objc private func dismissSheet() { dismiss(animated: true) }
}
