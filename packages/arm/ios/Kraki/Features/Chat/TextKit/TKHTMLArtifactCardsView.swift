/// HTML artifact cards under an iOS chat bubble (moved out of TKBubbleCell.swift).

import UIKit

private final class TKHTMLArtifactButton: UIControl {
    private let iconBackground = UIView()
    private let iconView = UIImageView()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let openIcon = UIImageView()
    private var artifact: ContentRef?
    private var onOpen: ((ContentRef) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.cornerRadius = 8
        layer.borderWidth = 0.5
        backgroundColor = .secondarySystemBackground
        layer.borderColor = UIColor.separator.withAlphaComponent(0.55).cgColor

        iconBackground.backgroundColor = UIColor.tintColor.withAlphaComponent(0.12)
        iconBackground.layer.cornerRadius = 7
        iconBackground.isUserInteractionEnabled = false
        addSubview(iconBackground)

        iconView.image = UIImage(systemName: "doc.richtext")
        iconView.tintColor = .tintColor
        iconView.contentMode = .scaleAspectFit
        iconBackground.addSubview(iconView)

        titleLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        titleLabel.textColor = .label
        titleLabel.lineBreakMode = .byTruncatingTail
        addSubview(titleLabel)

        detailLabel.font = .systemFont(ofSize: 10)
        detailLabel.textColor = .secondaryLabel
        detailLabel.lineBreakMode = .byTruncatingTail
        addSubview(detailLabel)

        openIcon.image = UIImage(systemName: "chevron.right")
        openIcon.tintColor = .tertiaryLabel
        openIcon.contentMode = .scaleAspectFit
        addSubview(openIcon)

        addTarget(self, action: #selector(openArtifact), for: .touchUpInside)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(artifact: ContentRef, onOpen: @escaping (ContentRef) -> Void) {
        self.artifact = artifact
        self.onOpen = onOpen
        let nonEmpty: (String?) -> String? = { text in
            guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
            return trimmed
        }
        let title = nonEmpty(artifact.caption) ?? nonEmpty(artifact.name) ?? String(localized: "Report")
        titleLabel.text = title
        detailLabel.text = String(localized: "Report · \(ByteCountFormatter.string(fromByteCount: Int64(artifact.size), countStyle: .file))")
        accessibilityLabel = title
        accessibilityValue = detailLabel.text
        accessibilityHint = String(localized: "Opens report preview")
    }

    func reset() {
        artifact = nil
        onOpen = nil
        titleLabel.text = nil
        detailLabel.text = nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        iconBackground.frame = CGRect(x: 10, y: 10, width: 34, height: 34)
        iconView.frame = iconBackground.bounds.insetBy(dx: 8, dy: 8)
        openIcon.frame = CGRect(x: bounds.width - 25, y: 20, width: 10, height: 14)
        let textX: CGFloat = 54
        let textWidth = max(1, bounds.width - textX - 36)
        titleLabel.frame = CGRect(x: textX, y: 9, width: textWidth, height: 18)
        detailLabel.frame = CGRect(x: textX, y: 29, width: textWidth, height: 14)
    }

    @objc private func openArtifact() {
        guard let artifact else { return }
        onOpen?(artifact)
    }
}

final class TKHTMLArtifactCardsView: UIView {
    static let cardHeight: CGFloat = 54
    static let spacing: CGFloat = 6
    private var buttons: [TKHTMLArtifactButton] = []

    static func height(for count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return CGFloat(count) * cardHeight + CGFloat(count - 1) * spacing
    }

    func configure(artifacts: [ContentRef], onOpen: @escaping (ContentRef) -> Void) {
        while buttons.count < artifacts.count {
            let button = TKHTMLArtifactButton(frame: .zero)
            addSubview(button)
            buttons.append(button)
        }
        for (index, button) in buttons.enumerated() {
            if index < artifacts.count {
                button.isHidden = false
                button.configure(artifact: artifacts[index], onOpen: onOpen)
            } else {
                button.isHidden = true
                button.reset()
            }
        }
        isHidden = artifacts.isEmpty
        setNeedsLayout()
    }

    func reset() {
        buttons.forEach {
            $0.reset()
            $0.isHidden = true
        }
        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        var y: CGFloat = 0
        for button in buttons where !button.isHidden {
            button.frame = CGRect(x: 0, y: y, width: bounds.width, height: Self.cardHeight)
            y += Self.cardHeight + Self.spacing
        }
    }
}
