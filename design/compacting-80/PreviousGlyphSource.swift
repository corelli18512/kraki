import SwiftUI
import QuartzCore

/// Approved B3, rounded/aligned rims. Mac is 80% of the previous size;
/// iOS stays at 98%. Both retain the same paths, cadence and 16pt slot.
enum SessionCompactingGeometry {
    #if os(macOS)
    static let scale: CGFloat = 0.98 * 0.80
    #else
    static let scale: CGFloat = 0.98
    #endif
    static let duration = 2.0
    static let keyTimes: [Double] = Array(Set((0...240).map { Double($0)/240 } + [0, 0.32, 0.60, 0.73, 0.82, 1])).sorted()

    static func compression(_ fraction: Double) -> Double {
        let t = min(1, max(0, fraction))*2
        func smooth(_ x: Double) -> Double { let x = min(1, max(0, x)); return x*x*x*(x*(x*6-15)+10) }
        if t < 0.64 { return smooth(t/0.64) }
        if t < 1.20 { return 1 }
        if t < 1.46 { return 1-1.16*smooth((t-1.20)/0.26) }
        if t < 1.64 { return -0.16*(1-smooth((t-1.46)/0.18)) }
        return 0
    }

    static func path(index: Int) -> CGPath {
        let top = planePath()
        guard index != 0 else { return top }
        let x = top.boundingBoxOfPath.minX
        let y = 8 + (x-1.75)*(10.635-8)/(7.24-1.75)
        let p = CGMutablePath()
        p.move(to: CGPoint(x: x, y: y))
        p.addLine(to: CGPoint(x: 7.24, y: 10.635))
        p.addQuadCurve(to: CGPoint(x: 8.76, y: 10.635), control: CGPoint(x: 8, y: 11))
        p.addLine(to: CGPoint(x: top.boundingBoxOfPath.maxX, y: y))
        return p
    }

    private static func planePath() -> CGPath {
        let points = [CGPoint(x: 8, y: 5), CGPoint(x: 14.25, y: 8), CGPoint(x: 8, y: 11), CGPoint(x: 1.75, y: 8)]
        func moved(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
            let dx = b.x-a.x, dy = b.y-a.y, length = max(hypot(dx, dy), 0.001)
            return CGPoint(x: a.x+dx/length*0.85, y: a.y+dy/length*0.85)
        }
        let p = CGMutablePath()
        p.move(to: moved(points[0], points[3]))
        for i in 0..<4 {
            p.addQuadCurve(to: moved(points[i], points[(i+1)%4]), control: points[i])
            p.addLine(to: moved(points[(i+1)%4], points[i]))
        }
        p.closeSubpath()
        return p
    }
}

enum SessionPreviewGlyphKind: Equatable {
    case compacting
    case delivery(SessionDeliveryStatus)

    var animates: Bool {
        switch self {
        case .compacting, .delivery(.correcting), .delivery(.sending): return true
        default: return false
        }
    }
}

/// Persistent layers; a color or text refresh never replaces their identity or
/// animation. No per-frame SwiftUI state, view IDs, or list layout invalidation.
final class SessionPreviewGlyphLayer: CALayer {
    let planes = (0..<3).map { _ in CAShapeLayer() }
    let delivery = CALayer()
    private(set) var kind: SessionPreviewGlyphKind?
    private(set) var isAnimating = false

    override init() {
        super.init()
        bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
        for (i, plane) in planes.enumerated() {
            plane.frame = bounds
            plane.lineWidth = 1.05*SessionCompactingGeometry.scale
            plane.lineCap = .round; plane.lineJoin = .round; plane.fillColor = nil
            var transform = CGAffineTransform(translationX: 8, y: 8)
                .scaledBy(x: SessionCompactingGeometry.scale, y: SessionCompactingGeometry.scale)
                .translatedBy(x: -8, y: -8)
            plane.path = SessionCompactingGeometry.path(index: i).copy(using: &transform)
            addSublayer(plane)
        }
        delivery.frame = bounds; addSublayer(delivery)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override init(layer: Any) { super.init(layer: layer) }

    func configure(kind: SessionPreviewGlyphKind, color: CGColor, image: CGImage?, displayScale: CGFloat,
                   animate: Bool) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let kindChanged = self.kind != kind
        self.kind = kind
        for plane in planes { plane.strokeColor = color; plane.contentsScale = displayScale; plane.isHidden = kind != .compacting }
        delivery.isHidden = kind == .compacting
        delivery.contentsScale = displayScale
        delivery.contents = image
        let shouldAnimate = animate && kind.animates
        if kindChanged || shouldAnimate != isAnimating {
            removeAllAnimations()
            for (i, plane) in planes.enumerated() {
                plane.removeAllAnimations()
                plane.transform = CATransform3DMakeTranslation(0, CGFloat(i-1)*3.6*SessionCompactingGeometry.scale, 0)
            }
            delivery.removeAllAnimations(); delivery.transform = CATransform3DIdentity
            delivery.opacity = kind == .delivery(.correcting) ? 0.70 : 1
            isAnimating = shouldAnimate
            if shouldAnimate { installAnimation(kind) }
        }
        CATransaction.commit()
    }

    private func animation(_ key: String, duration: Double, times: [Double], values: [Double], on layer: CALayer) -> CAKeyframeAnimation {
        let animation = CAKeyframeAnimation(keyPath: key)
        animation.values = values; animation.keyTimes = times.map { NSNumber(value: $0) }
        animation.duration = duration; animation.repeatCount = .infinity; animation.calculationMode = .linear
        animation.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        animation.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil)
            - Date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: duration)
        return animation
    }

    private func installAnimation(_ kind: SessionPreviewGlyphKind) {
        if kind == .compacting {
            let times = SessionCompactingGeometry.keyTimes
            for i in [0, 2] {
                let values = times.map { Double(i-1)*(3.6-1.75*SessionCompactingGeometry.compression($0))*Double(SessionCompactingGeometry.scale) }
                planes[i].add(animation("transform.translation.y", duration: 2, times: times, values: values, on: planes[i]), forKey: "compression")
            }
        } else {
            let correcting = kind == .delivery(.correcting)
            let times = (0...120).map { Double($0)/120 }
            let wave = times.map { 0.5-0.5*cos($0*2 * .pi) }
            let duration = correcting ? 1.8 : 1.3
            let values = wave.map { correcting ? 0.52+0.28*$0 : 0.78+0.22*$0 }
            delivery.add(animation("opacity", duration: duration, times: times, values: values, on: delivery), forKey: "activity")
            if !correcting {
                delivery.add(animation("transform.translation.y", duration: duration, times: times,
                                       values: wave.map { -0.65*$0 }, on: delivery), forKey: "outgoing")
            }
        }
    }
}
