#if os(iOS)
/// iOS chat image views that animate GIFs: the bubble thumbnail surface and
/// the image view of the full-screen viewer.

import SwiftUI
import UIKit

/// A chat image: the still image right away and, for an animated GIF, its
/// frames once decoded in the background (`AttachmentImageCache`). Starts
/// playing by itself unless Reduce Motion is on; then it shows the first
/// frame (with a play badge in thumbnails) until played.
final class ChatAnimatedImageView: UIImageView {
    private(set) var stillImage: UIImage?
    private(set) lazy var player: ChatGIFPlayer = {
        let player = ChatGIFPlayer { [weak self] frame in self?.showFrame(frame) }
        player.onPlaybackChange = { [weak self] in
            self?.updateBadge()
            self?.onPlaybackChange?()
        }
        return player
    }()
    private let pausedBadge = UIImageView(image: UIImage(systemName: "play.circle.fill"))

    /// Thumbnails mark a GIF that is not playing (Reduce Motion) with a badge.
    var showsPausedBadge = false { didSet { updateBadge() } }
    /// Called when the GIF turns out animated and on play / pause.
    var onPlaybackChange: (() -> Void)?

    var file: ChatImageFile? { player.file }
    var isPausedBadgeVisible: Bool { !pausedBadge.isHidden }
    var isAnimated: Bool { player.isAnimated }
    var isPlaying: Bool { player.isPlaying }

    override init(frame: CGRect) {
        super.init(frame: frame)
        pausedBadge.tintColor = .white
        pausedBadge.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold)
        pausedBadge.layer.shadowColor = UIColor.black.cgColor
        pausedBadge.layer.shadowOpacity = 0.45
        pausedBadge.layer.shadowRadius = 3
        pausedBadge.layer.shadowOffset = .zero
        pausedBadge.isHidden = true
        pausedBadge.isAccessibilityElement = false
        addSubview(pausedBadge)
    }

    convenience init() {
        self.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// Never sizes its SwiftUI or Auto Layout host: the image fills the
    /// frame it is given.
    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric)
    }

    /// Shows `still`, then animates `file` if it is an animated GIF.
    func show(_ still: UIImage?, file: ChatImageFile?) {
        if still !== stillImage {
            stillImage = still
            if !isAnimated { image = still }
        }
        player.show(file)
    }

    func togglePlayback() {
        player.togglePlayback()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        player.setVisible(window != nil)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side: CGFloat = 30
        pausedBadge.frame = CGRect(x: bounds.maxX - side - 8, y: bounds.maxY - side - 8, width: side, height: side)
    }

    private func updateBadge() {
        pausedBadge.isHidden = !(showsPausedBadge && isAnimated && !isPlaying)
    }

    /// Frames may be decoded smaller than the still image: keep its size in
    /// points so the layout never changes between frames.
    private func showFrame(_ frame: CGImage?) {
        guard let frame else {
            image = stillImage
            return
        }
        let stillWidth = stillImage.map { $0.size.width } ?? CGFloat(frame.width)
        let scale = stillWidth > 0 ? CGFloat(frame.width) / stillWidth : 1
        image = UIImage(cgImage: frame, scale: max(scale, 0.01), orientation: .up)
    }
}

/// The image of a bubble thumbnail, filling (and cropped to) its frame.
struct ChatImageSurface: UIViewRepresentable {
    let image: UIImage
    let file: ChatImageFile?

    func makeUIView(context: Context) -> ChatAnimatedImageView {
        let view = ChatAnimatedImageView()
        view.contentMode = .scaleAspectFill
        view.clipsToBounds = true
        view.isUserInteractionEnabled = false
        view.showsPausedBadge = true
        view.accessibilityIgnoresInvertColors = true
        view.show(image, file: file)
        return view
    }

    func updateUIView(_ view: ChatAnimatedImageView, context: Context) {
        view.show(image, file: file)
    }
}
#endif
