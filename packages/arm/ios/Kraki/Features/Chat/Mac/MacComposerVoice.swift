/// The Mac composer's voice surface: waveforms, live transcript views and their scrolling.

#if os(macOS)
import AppKit
import SwiftUI

// MARK: - Inline VoiceType transcript surface

/// A quiet transcript-only backdrop driven by real microphone peaks, never
/// a canned idle animation. Faded ends keep the adjacent image and action
/// slots clear. Background geometry cannot resize or intercept the controls.
struct MacVoiceBackgroundWaveform: View {
    let levels: [Float]

    static func heightFractions(levels: [Float], count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let recent = Array(levels.suffix(8))
        let samples = Array(repeating: Float(0), count: max(0, 8 - recent.count)) + recent
        return (0..<count).map { index in
            let position = CGFloat(index) / CGFloat(max(1, count - 1)) * CGFloat(samples.count - 1)
            let left = Int(position)
            let right = min(left + 1, samples.count - 1)
            let mix = position - CGFloat(left)
            let amplitude = VoiceLevelBars.loudness(samples[left]) * (1 - mix)
                + VoiceLevelBars.loudness(samples[right]) * mix
            return 0.06 + amplitude * 0.78
        }
    }

    var body: some View {
        GeometryReader { geometry in
            let count = max(8, min(160, Int(geometry.size.width / 8)))
            let heights = Self.heightFractions(levels: levels, count: count)
            HStack(spacing: 0) {
                ForEach(heights.indices, id: \.self) { index in
                    Capsule()
                        .fill(Color.krakiPrimary.opacity(0.10))
                        .frame(width: 3, height: max(2, geometry.size.height * heights[index]))
                        .frame(maxWidth: .infinity)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .animation(.spring(response: 0.18, dampingFraction: 0.8), value: levels)
        }
    }
}

/// Measure wrapping against the unchanged single-row arrangement. Deciding
/// from the *expanded* transcript width would flip back and forth at the wrap
/// boundary (stacking frees width, unwrapping would then unstack the buttons).
struct MacVoiceSurfaceLayout: Layout {
    let pieces: [MacComposerVoiceTranscriptView.Piece]

    struct Geometry {
        let stacked: Bool
        let height: CGFloat
        let transcript: CGRect
        let cancel: CGRect
        let edit: CGRect
    }

    func geometry(width: CGFloat) -> Geometry {
        let width = max(1, width)
        let gap: CGFloat = 8, cancelWidth: CGFloat = 70, editWidth: CGFloat = 62, buttonHeight: CGFloat = 30
        let padding = MacComposerMetrics.textVerticalPadding
        let horizontalTextWidth = max(1, width - cancelWidth - editWidth - gap * 2)
        let stacked = MacComposerVoiceTranscriptView.measure(pieces, width: horizontalTextWidth)
            > MacComposerMetrics.minimumTextHeight + 0.5
        let textWidth = stacked ? max(1, width - cancelWidth - gap) : horizontalTextWidth
        let textHeight = min(
            max(MacComposerMetrics.minimumTextHeight, MacComposerVoiceTranscriptView.measure(pieces, width: textWidth)),
            MacComposerMetrics.minimumTextHeight + MacComposerVoiceTranscriptView.lineHeight * (MacComposerMetrics.maxVisibleTextLines - 1)
        )
        let actionsHeight = stacked ? buttonHeight * 2 + 4 : buttonHeight
        let height = max(textHeight + padding * 2, actionsHeight + 6)
        let actionTop = (height - actionsHeight) / 2
        let cancelX = stacked ? width - cancelWidth : textWidth + gap
        let placedEditWidth = stacked ? cancelWidth : editWidth
        return Geometry(stacked: stacked, height: height,
                        transcript: CGRect(x: 0, y: padding, width: textWidth, height: height - padding * 2),
                        cancel: CGRect(x: cancelX, y: actionTop, width: cancelWidth, height: buttonHeight),
                        edit: CGRect(x: width - placedEditWidth,
                                     y: stacked ? actionTop + buttonHeight + 4 : actionTop,
                                     width: placedEditWidth, height: buttonHeight))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 600
        return CGSize(width: width, height: geometry(width: width).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 3 else { return }
        let layout = geometry(width: bounds.width)
        for (view, frame) in zip(subviews, [layout.transcript, layout.cancel, layout.edit]) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                       anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

struct MacComposerVoiceSurface: View {
    let controller: KrakiVoiceInputController
    let preview: (prefix: String, spoken: String, suffix: String)
    let onFinish: () -> Void
    let onCancel: () -> Void
    @State private var width: CGFloat = 0
    /// Cancel / Edit re-stack when the transcript wraps: they don't slide
    /// across each other while the box grows; they fade in at their new place.
    @State private var actionsOpacity = 1.0
    private var stacked: Bool { width > 1 && MacVoiceSurfaceLayout(pieces: displayedPieces).geometry(width: width - 9).stacked }

    var body: some View {
        MacVoiceSurfaceLayout(pieces: displayedPieces) {
            MacComposerVoiceTranscriptOnly(controller: controller, preview: preview)
            actions
        }
        .padding(.leading, 4)
        .padding(.trailing, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: stacked) { _, _ in
            actionsOpacity = 0
            withAnimation(.easeOut(duration: 0.14).delay(0.14)) { actionsOpacity = 1 }
        }
    }

    @ViewBuilder
    private var actions: some View {
            Button(action: onCancel) {
                Label("Cancel", systemImage: "xmark")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 70, height: 30)
                    .background(.primary.opacity(0.05), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Cancel voice input")
            .accessibilityIdentifier("voice-cancel")
            .help(MacControlHelp.voiceCancel)
            .background {
                #if DEBUG
                MacComposerControlGeometryProbe(identifier: "voice-cancel")
                #endif
            }
            .opacity(actionsOpacity)
            .animation(nil, value: stacked)
            Button(action: onFinish) {
                Label("Edit", systemImage: "character.cursor.ibeam")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.krakiPrimary)
                    .frame(minWidth: 62, maxWidth: .infinity)
                    .frame(height: 30)
                    .background(Color.krakiPrimary.opacity(0.10), in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Edit voice text")
            .accessibilityIdentifier("voice-to-text")
            .help(MacControlHelp.voiceEdit)
            .background {
                #if DEBUG
                MacComposerControlGeometryProbe(identifier: "voice-to-text")
                #endif
            }
            .opacity(actionsOpacity)
            .animation(nil, value: stacked)
    }

    private var displayedPieces: [(text: String, opacity: Double)] {
        MacComposerVoiceTranscriptOnly.pieces(controller: controller, preview: preview)
    }
}

/// The recording transcript over its live waveform, without the actions:
/// the chat surface adds Cancel / Edit beside it; the new-session composer
/// puts them in its bottom row instead.
struct MacComposerVoiceTranscriptOnly: View {
    let controller: KrakiVoiceInputController
    let preview: (prefix: String, spoken: String, suffix: String)
    var topAligned = false
    /// The new-session composer shows iOS's level bars in its bottom row.
    var showsWaveform = true
    var maxVisibleLines: CGFloat = MacComposerMetrics.maxVisibleTextLines

    var body: some View {
        let pieces = Self.pieces(controller: controller, preview: preview)
        MacComposerScrollableVoiceTranscript(pieces: pieces, revision: revision, topAligned: topAligned,
                                             maxVisibleLines: maxVisibleLines)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                if showsWaveform { waveform }
            }
    }

    private var waveform: some View {
                MacVoiceBackgroundWaveform(levels: controller.levels)
                    .mask {
                        LinearGradient(stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .white, location: 0.12),
                            .init(color: .white, location: 0.88),
                            .init(color: .clear, location: 1)
                        ], startPoint: .leading, endPoint: .trailing)
                    }
                    .clipped()
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
    }

    private var revision: String {
        "\(preview.prefix)-\(preview.spoken)-\(preview.suffix)-\(controller.state)"
    }

    static func pieces(controller: KrakiVoiceInputController,
                       preview: (prefix: String, spoken: String, suffix: String)) -> [(text: String, opacity: Double)] {
        // Pressed while Kraki is reconnecting: say so at the caret until the
        // connection is back and recording starts by itself.
        if preview.spoken.isEmpty, controller.state == .waitingForConnection {
            let separator = preview.prefix.isEmpty || preview.prefix.last?.isWhitespace == true ? "" : " "
            return [(preview.prefix, 1), (separator + "Connecting…", 0.45), (preview.suffix, 1)]
        }
        return [(preview.prefix, 1), (preview.spoken, 1), (preview.suffix, 1)]
    }
}

final class MacComposerVoiceTranscriptView: NSView {
    typealias Piece = (text: String, opacity: Double)

    private static let font = NSFont.systemFont(ofSize: 15)
    static let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: font))
    static let maxVisibleLines: CGFloat = 8

    private var pieces: [Piece] = []
    private var value = NSAttributedString(string: "")
    private var framesetter: CTFramesetter?
    private var measuredWidth: CGFloat = 0
    private var measuredHeight: CGFloat = lineHeight
    private(set) var contentHeight: CGFloat = lineHeight
    var preservesContentHeight = false
    /// Taller boxes (new session): short speech starts on the first line,
    /// where the editor's text will be after Edit.
    var topAligned = false { didSet { if topAligned != oldValue { needsDisplay = true } } }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: measuredHeight)
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }

    func update(pieces: [Piece], width: CGFloat) -> CGFloat {
        self.pieces = pieces
        rebuildAttributedText()
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityLabel("Voice transcript")
        setAccessibilityValue(value.string)
        if width > 1 {
            measuredWidth = width
            contentHeight = Self.measure(value, width: width)
            measuredHeight = min(contentHeight, Self.lineHeight * Self.maxVisibleLines)
        } else {
            measuredWidth = 0
            contentHeight = Self.lineHeight
            measuredHeight = Self.lineHeight
        }
        invalidateIntrinsicContentSize()
        needsDisplay = true
        return measuredHeight
    }

    static func measure(_ pieces: [Piece], width: CGFloat) -> CGFloat {
        measure(attributedText(pieces: pieces, color: .labelColor), width: width)
    }

    /// Re-wrap the current text at a new width (the box resized without
    /// new speech). Returns whether anything changed.
    @discardableResult
    func refit(width: CGFloat) -> Bool {
        guard width > 1, abs(width - measuredWidth) > 0.5 else { return false }
        _ = update(pieces: pieces, width: width)
        return true
    }

    private static func attributedText(pieces: [Piece], color: NSColor) -> NSAttributedString {
        let output = NSMutableAttributedString()
        for piece in pieces where !piece.text.isEmpty {
            output.append(NSAttributedString(
                string: piece.text,
                attributes: [
                    .font: NSFont.systemFont(ofSize: 15),
                    .foregroundColor: color.withAlphaComponent(max(0, min(1, piece.opacity))),
                ]
            ))
        }
        return output
    }

    private static func resolvedLabelColor(for appearance: NSAppearance) -> NSColor {
        var resolved = NSColor.labelColor
        appearance.performAsCurrentDrawingAppearance {
            resolved = NSColor.labelColor.usingColorSpace(.deviceRGB) ?? NSColor.labelColor
        }
        return resolved
    }

    private func rebuildAttributedText() {
        value = Self.attributedText(
            pieces: pieces,
            color: Self.resolvedLabelColor(for: effectiveAppearance)
        )
        framesetter = CTFramesetterCreateWithAttributedString(value)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        rebuildAttributedText()
        needsDisplay = true
    }

    private static func measure(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        guard text.length > 0 else { return lineHeight }
        let framesetter = CTFramesetterCreateWithAttributedString(text)
        let suggested = CTFramesetterSuggestFrameSizeWithConstraints(
            framesetter,
            CFRange(location: 0, length: text.length),
            nil,
            CGSize(width: max(1, width), height: .greatestFiniteMagnitude),
            nil
        )
        return max(lineHeight, ceil(suggested.height + 1))
    }

    override func layout() {
        super.layout()
        guard bounds.width > 1,
              abs(bounds.width - measuredWidth) > 0.5 else { return }
        measuredWidth = bounds.width
        let fullHeight = Self.measure(value, width: bounds.width)
        contentHeight = fullHeight
        if preservesContentHeight,
           bounds.height < fullHeight - 0.5 {
            setFrameSize(NSSize(width: bounds.width, height: fullHeight))
        }
        let height = min(fullHeight, Self.lineHeight * Self.maxVisibleLines)
        guard abs(height - measuredHeight) > 0.5 else {
            needsDisplay = true
            return
        }
        measuredHeight = height
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    /// Only the compact one-row surface centers short speech. Stacking the
    /// actions widens the text lane, so a wrapped line may fit on one line
    /// again while its viewport stays tall. Use the actual allocated height
    /// (also on resize), not the reflowed line count, to keep it at the top.
    var textDrawingRect: CGRect {
        if topAligned || bounds.height > MacComposerMetrics.minimumTextHeight + 0.5
            || contentHeight > Self.lineHeight * 1.5 { return bounds }
        let inset = max(0, (bounds.height - contentHeight) / 2)
        return bounds.insetBy(dx: 0, dy: inset)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext,
              let framesetter,
              value.length > 0 else { return }
        let visibleRange = contentHeight <= bounds.height + 0.5
            ? CFRange(location: 0, length: value.length)
            : visibleSuffixRange(width: bounds.width, height: bounds.height)
        context.saveGState()
        context.textMatrix = .identity
        context.translateBy(x: 0, y: bounds.height)
        context.scaleBy(x: 1, y: -1)
        let path = CGPath(rect: textDrawingRect, transform: nil)
        let frame = CTFramesetterCreateFrame(
            framesetter,
            visibleRange,
            path,
            nil
        )
        effectiveAppearance.performAsCurrentDrawingAppearance {
            CTFrameDraw(frame, context)
        }
        context.restoreGState()
    }

    /// Select complete trailing CoreText lines that fit the clipped voice
    /// viewport. Unlike substring binary search, line origins remain stable for
    /// CJK streaming and never collapse the representable to one glyph.
    private func visibleSuffixRange(width: CGFloat, height: CGFloat) -> CFRange {
        let fullRange = CFRange(location: 0, length: value.length)
        guard value.length > 0,
              width > 1,
              height > 1,
              Self.measure(value, width: width) > height + 0.5,
              let framesetter else { return fullRange }

        let measurementPath = CGPath(
            rect: CGRect(x: 0, y: 0, width: width, height: 100_000),
            transform: nil
        )
        let fullFrame = CTFramesetterCreateFrame(framesetter, fullRange, measurementPath, nil)
        let lines = CTFrameGetLines(fullFrame) as? [CTLine] ?? []
        guard !lines.isEmpty else { return fullRange }
        let lineHeight = ceil(NSLayoutManager().defaultLineHeight(for: .systemFont(ofSize: 15)))
        let visibleLineCount = max(1, min(lines.count, Int(floor(height / max(1, lineHeight)))))
        // During a SwiftUI width/height transition, a transient one-line bound
        // must never reduce a newly wrapped stream to the first glyph of its
        // trailing line. Wait for the ideal-height layout pass instead.
        guard visibleLineCount > 1 else { return fullRange }
        let firstVisibleLine = lines[lines.count - visibleLineCount]
        let firstRange = CTLineGetStringRange(firstVisibleLine)
        let start = max(0, min(value.length, firstRange.location))
        return CFRange(location: start, length: value.length - start)
    }

    #if DEBUG
    var debugAttributedText: NSAttributedString { value }
    func debugVisibleRange(width: CGFloat, height: CGFloat) -> CFRange {
        visibleSuffixRange(width: width, height: height)
    }
    static func debugAttributedText(pieces: [Piece], appearance: NSAppearance) -> NSAttributedString {
        attributedText(pieces: pieces, color: resolvedLabelColor(for: appearance))
    }
    #endif
}

struct MacComposerVoiceTranscript: NSViewRepresentable {
    let pieces: [MacComposerVoiceTranscriptView.Piece]
    let revision: String

    final class Coordinator {
        var revision = ""
        var width: CGFloat = 0
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> MacComposerVoiceTranscriptView {
        let view = MacComposerVoiceTranscriptView(frame: .zero)
        view.wantsLayer = true
        view.layer?.masksToBounds = true
        return view
    }

    func updateNSView(_ transcriptView: MacComposerVoiceTranscriptView, context: Context) {
        let width = max(1, transcriptView.bounds.width)
        guard context.coordinator.revision != revision
                || abs(context.coordinator.width - width) > 0.5 else { return }
        context.coordinator.revision = revision
        context.coordinator.width = width
        _ = transcriptView.update(pieces: pieces, width: width)
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: MacComposerVoiceTranscriptView,
        context: Context
    ) -> CGSize? {
        guard let proposedWidth = proposal.width, proposedWidth > 1 else { return nil }
        let width = proposedWidth
        let contentHeight = MacComposerVoiceTranscriptView.measure(pieces, width: width)
        return CGSize(
            width: width,
            height: min(contentHeight, MacComposerVoiceTranscriptView.lineHeight * MacComposerVoiceTranscriptView.maxVisibleLines)
        )
    }
}

/// Keeps the live voice transcript at its newest line after AppKit finishes
/// a document-frame/layout pass. The scroll view still accepts normal wheel
/// and trackpad input between recognition updates.
final class MacComposerVoiceScrollView: MacEdgeFadingScrollView {
    var followsTail = true

    /// The box can change size without new speech (window resize, sidebar,
    /// the actions re-stacking). Re-fit the document to the viewport every
    /// time: re-wrap at the new width and drop height left over from a
    /// narrower / taller layout. Before, a stale taller document stayed
    /// scrolled to its old bottom and the text slid out of the box.
    override func tile() {
        super.tile()
        refitDocument()
    }

    func refitDocument() {
        guard let document = documentView as? MacComposerVoiceTranscriptView else { return }
        let clip = contentView.bounds.size
        guard clip.width > 1, clip.height > 1 else { return }
        document.refit(width: clip.width)
        let height = max(document.contentHeight, clip.height)
        if abs(document.frame.height - height) > 0.5 || abs(document.frame.width - clip.width) > 0.5 {
            document.setFrameSize(NSSize(width: clip.width, height: height))
        }
        let maximumY = max(0, height - clip.height)
        let target = followsTail ? maximumY : min(contentView.bounds.origin.y, maximumY)
        if abs(contentView.bounds.origin.y - target) > 0.5 {
            contentView.bounds.origin.y = target
            super.reflectScrolledClipView(contentView)
        }
        edgeFade?.update()
    }

    override func layout() {
        super.layout()
        refitDocument()
        guard followsTail,
              let documentView,
              documentView.frame.height > contentView.bounds.height + 0.5 else { return }
        let maximumY = max(0, documentView.frame.height - contentView.bounds.height)
        guard abs(contentView.bounds.origin.y - maximumY) > 0.5 else { return }
        contentView.bounds.origin.y = maximumY
        super.reflectScrolledClipView(contentView)
        edgeFade?.update()
    }
}

/// A growing, three-line-capped native scroll surface for voice text. The
/// document keeps the complete CoreText layout while the clip view follows
/// its bottom edge after every recognition update, so long dictation remains
/// readable and the newest words never disappear below the composer.
struct MacComposerScrollableVoiceTranscript: NSViewRepresentable {
    let pieces: [MacComposerVoiceTranscriptView.Piece]
    let revision: String
    var topAligned = false
    var maxVisibleLines: CGFloat = MacComposerMetrics.maxVisibleTextLines

    final class Coordinator {
        var revision = ""
        var width: CGFloat = 0
        var proposedWidth: CGFloat = 0
        weak var documentView: MacComposerVoiceTranscriptView?
        var edgeFade: MacScrollEdgeFade?

        func apply(
            pieces: [MacComposerVoiceTranscriptView.Piece],
            revision: String,
            to scrollView: NSScrollView
        ) {
            guard let documentView else { return }
            let clipWidth = scrollView.contentView.bounds.width
            let viewWidth = scrollView.bounds.width
            let width = max(1, clipWidth > 1 ? clipWidth : (viewWidth > 1 ? viewWidth : proposedWidth))
            let changed = self.revision != revision || abs(self.width - width) > 0.5
            guard changed else { return }
            self.revision = revision
            self.width = width
            _ = documentView.update(pieces: pieces, width: width)
            let documentHeight = max(documentView.contentHeight, scrollView.contentView.bounds.height)
            documentView.frame = NSRect(
                x: 0,
                y: 0,
                width: width,
                height: documentHeight
            )
            documentView.needsLayout = true
            scrollView.layoutSubtreeIfNeeded()
            // NSScrollView may perform an internal clip-view layout after the
            // representable update. Reassert the document extent after that
            // pass so AppKit cannot collapse the document back to its
            // intrinsic viewport height.
            documentView.setFrameSize(NSSize(width: width, height: documentHeight))
            documentView.setFrameOrigin(.zero)
            scrollToTail(scrollView)
            DispatchQueue.main.async { [weak self, weak scrollView] in
                guard let self, let scrollView else { return }
                self.scrollToTail(scrollView)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self, weak scrollView] in
                    guard let self, let scrollView else { return }
                    self.scrollToTail(scrollView)
                }
            }
        }

        func scrollToTail(_ scrollView: NSScrollView) {
            let clipView = scrollView.contentView
            let maxY = max(0, clipView.documentRect.height - clipView.bounds.height)
            clipView.bounds.origin.y = maxY
            scrollView.reflectScrolledClipView(clipView)
            edgeFade?.scheduleUpdate()
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = MacComposerVoiceScrollView(frame: .zero)
        scrollView.drawsBackground = false
        scrollView.contentView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasHorizontalScroller = false
        // Keep the viewport visually scrollbar-free while allowing native
        // trackpad/wheel packets to move the clip view.
        scrollView.hasVerticalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.verticalScrollElasticity = .automatic
        scrollView.horizontalScrollElasticity = .none

        let documentView = MacComposerVoiceTranscriptView(frame: .zero)
        documentView.autoresizingMask = [.width]
        documentView.preservesContentHeight = true
        documentView.topAligned = topAligned
        documentView.wantsLayer = true
        documentView.layer?.masksToBounds = false
        scrollView.documentView = documentView
        scrollView.followsTail = true
        context.coordinator.documentView = documentView
        context.coordinator.edgeFade = MacScrollEdgeFade(scrollView)
        scrollView.edgeFade = context.coordinator.edgeFade
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.documentView?.topAligned = topAligned
        context.coordinator.apply(pieces: pieces, revision: revision, to: scrollView)
        // SwiftUI may deliver the first update before the representable has
        // its final width. Re-apply after AppKit has committed that layout.
        DispatchQueue.main.async { [weak scrollView] in
            guard let scrollView else { return }
            context.coordinator.apply(pieces: pieces, revision: revision, to: scrollView)
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: NSScrollView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width, width > 1 else { return nil }
        context.coordinator.proposedWidth = width
        return CGSize(
            width: width,
            height: min(
                max(MacComposerMetrics.minimumTextHeight, proposal.height ?? MacComposerVoiceTranscriptView.measure(pieces, width: width)),
                MacComposerMetrics.minimumTextHeight + MacComposerVoiceTranscriptView.lineHeight * (maxVisibleLines - 1)
            )
        )
    }
}

private struct MacComposerWaveform: View {
    let levels: [Float]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                let level = min(1, max(0, levels[index]))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.63, green: 0.84, blue: 1.0),
                                Color(red: 0.68, green: 0.58, blue: 1.0),
                            ],
                            startPoint: .bottom,
                            endPoint: .top
                        )
                    )
                    .opacity(0.4 + 0.6 * Double(level))
                    .frame(width: 2, height: 2.5 + CGFloat(sqrt(level)) * 12)
            }
        }
        .frame(width: 34, height: 28)
        .animation(.linear(duration: 0.1), value: levels)
    }
}
#endif
