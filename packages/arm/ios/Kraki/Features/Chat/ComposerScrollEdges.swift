#if os(iOS)
import SwiftUI
import UIKit

/// Composer scroll-edge hints: while text is scrolled out of view above or
/// below, that edge of the text fades out.
enum IOSComposerScrollFade {
    static let length: CGFloat = 16
}

/// Measures composer text the way the body TextField lays it out, so growth
/// can be animated in the same update as the text change.
enum IOSComposerTextMetrics {
    static var font: UIFont { UIFont.preferredFont(forTextStyle: .body) }
    static var lineHeight: CGFloat { ceil(font.lineHeight) }

    static func height(_ text: String, width: CGFloat, maxHeight: CGFloat) -> CGFloat {
        guard width > 1 else { return 0 }
        let measured = (text.isEmpty ? " " : text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font], context: nil).height
        let lines = max(1, (measured / font.lineHeight).rounded())
        return min(lines * lineHeight, maxHeight)
    }
}

struct IOSScrollEdges: Equatable {
    var top = false
    var bottom = false
    init() {}
    init(_ g: ScrollGeometry) {
        top = g.contentOffset.y + g.contentInsets.top > 0.5
        bottom = g.contentOffset.y + g.containerSize.height < g.contentSize.height + g.contentInsets.top + g.contentInsets.bottom - 0.5
    }
}

/// Opaque in the middle; transparent at an edge that has more text.
struct IOSScrollEdgeMask: View {
    let edges: IOSScrollEdges
    var body: some View {
        GeometryReader { g in
            let f = min(0.45, IOSComposerScrollFade.length / max(1, g.size.height))
            LinearGradient(stops: [
                .init(color: edges.top ? .clear : .black, location: 0),
                .init(color: .black, location: f),
                .init(color: .black, location: 1 - f),
                .init(color: edges.bottom ? .clear : .black, location: 1),
            ], startPoint: .top, endPoint: .bottom)
        }
        .animation(.easeOut(duration: 0.12), value: edges)
    }
}

/// Finds the multi-line TextField's native UITextView (it is placed in the
/// field's background) and masks its scrolled-out edges.
struct IOSTextFieldEdgeFade: UIViewRepresentable {
    func makeUIView(context: Context) -> Marker { Marker() }
    func updateUIView(_ view: Marker, context: Context) { view.schedule() }

    final class Marker: UIView {
        private weak var input: UITextView?
        private var observations: [NSKeyValueObservation] = []
        private let fadeMask = CAGradientLayer()
        private var scheduled = false
        #if DEBUG
        private(set) var debugEdges = IOSScrollEdges()
        var debugInput: UITextView? { input }
        #endif

        init() { super.init(frame: .zero); isUserInteractionEnabled = false }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func didMoveToWindow() { super.didMoveToWindow(); schedule() }
        override func layoutSubviews() { super.layoutSubviews(); schedule() }

        func schedule() {
            guard !scheduled else { return }
            scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.scheduled = false
                self.attach()
                self.update()
            }
        }

        private func attach() {
            guard window != nil, input?.window == nil || input == nil else { return }
            var root = superview
            while let candidate = root, input == nil {
                if let found = Self.find(in: candidate) { track(found) }
                root = candidate.superview
            }
        }

        private static func find(in root: UIView) -> UITextView? {
            if let view = root as? UITextView, view.isEditable { return view }
            for child in root.subviews { if let found = find(in: child) { return found } }
            return nil
        }

        private func track(_ view: UITextView) {
            input = view
            observations = [
                view.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.update() }
                },
                view.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.update() }
                },
                view.observe(\.bounds, options: [.new]) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.update() }
                },
            ]
        }

        func update() {
            guard let view = input else { return }
            let offset = view.contentOffset.y + view.adjustedContentInset.top
            let maxOffset = view.contentSize.height + view.adjustedContentInset.top + view.adjustedContentInset.bottom - view.bounds.height
            // A full five-line field reports a few points of slack below its
            // last line; only real hidden text (well under a line) counts.
            let top = offset > 4
            let bottom = maxOffset - offset > 4
            #if DEBUG
            debugEdges.top = top; debugEdges.bottom = bottom
            #endif
            guard top || bottom else {
                if view.layer.mask != nil { view.layer.mask = nil }
                return
            }
            CATransaction.begin(); CATransaction.setDisableActions(true)
            // A scroll view's layer bounds move with the content offset.
            fadeMask.frame = view.layer.bounds
            let f = min(0.45, IOSComposerScrollFade.length / max(1, view.bounds.height))
            let clear = UIColor.clear.cgColor, solid = UIColor.black.cgColor
            fadeMask.colors = [top ? clear : solid, solid, solid, bottom ? clear : solid]
            fadeMask.locations = [0, NSNumber(value: Double(f)), NSNumber(value: Double(1 - f)), 1]
            if view.layer.mask !== fadeMask { view.layer.mask = fadeMask }
            CATransaction.commit()
        }
    }
}
#endif
