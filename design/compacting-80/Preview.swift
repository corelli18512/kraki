import SwiftUI
import AppKit
import QuartzCore

// Only protocol scaffolding; all glyphs, colors and paths come from production.
enum SessionMode { case safe, auto, delegate }

@MainActor
func compactImage(revised: Bool, dark: Bool, zoom: CGFloat, fraction: Double = 0) -> CGImage {
    var environment = EnvironmentValues()
    environment.colorScheme = dark ? .dark : .light
    let color = Color.krakiPrimary.resolve(in: environment).cgColor
    let root: CALayer
    let planes: [CAShapeLayer]
    let scale: CGFloat
    if revised {
        let renderer = SessionPreviewGlyphLayer()
        renderer.configure(kind: .compacting, color: color, image: nil, displayScale: 2*zoom, animate: false)
        root = renderer; planes = renderer.planes; scale = SessionCompactingGeometry.scale
    } else {
        let renderer = PreviousPreviewGlyphLayer()
        renderer.configure(kind: .compacting, color: color, image: nil, displayScale: 2*zoom, animate: false)
        root = renderer; planes = renderer.planes; scale = PreviousCompactingGeometry.scale
    }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    for (i, plane) in planes.enumerated() {
        plane.transform = CATransform3DMakeTranslation(0, CGFloat(i-1)*(3.6-1.75*SessionCompactingGeometry.compression(fraction))*scale, 0)
    }
    CATransaction.commit()
    let pixels = Int(16*zoom*2)
    let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.translateBy(x: 0, y: CGFloat(pixels))
    context.scaleBy(x: 2*zoom, y: -2*zoom)
    root.render(in: context)
    return context.makeImage()!
}

struct Compact: View {
    var revised: Bool
    var dark = false
    var zoom: CGFloat = 1
    var fraction: Double = 0
    var body: some View {
        Image(decorative: compactImage(revised: revised, dark: dark, zoom: zoom, fraction: fraction), scale: 2)
            .resizable().frame(width: 16*zoom, height: 16*zoom)
    }
}

// Revised sizes, colors and stroke widths match MacSessionStatusGlyph exactly.
// The previous preview already had the smaller compacting glyph.
struct Neighbors: View {
    var revised: Bool
    var dark: Bool
    let zoom: CGFloat = 3
    var body: some View {
        HStack(spacing: 0) {
            cell { LucideIcon(.botMessageSquare, size: 13*1.20*zoom, strokeWidth: 1.9, color: .krakiPrimary) }
            cell { Compact(revised: revised, dark: dark, zoom: zoom) }
            cell { LucideIcon(.circleUser, size: 13*1.10*zoom, strokeWidth: 1.9, color: .textSecondary) }
            cell { Image(systemName: "tray.and.arrow.up").font(.system(size: 11.5*zoom, weight: .medium)).foregroundStyle(Color.krakiPrimary) }
            cell { LucideIcon(.messageCircleQuestion, size: 14*zoom, strokeWidth: 2.2, color: Color(hex: 0xD97706)) }
            cell { LucideIcon(.shieldQuestion, size: 14*(revised ? 1.10 : 1)*zoom, strokeWidth: 2.2, color: Color(hex: 0xD97706)) }
            cell { LucideIcon(.circleSlash, size: 14*zoom, strokeWidth: 2.2, color: .red) }
            cell { LucideIcon(.keyboard, size: 14*zoom, strokeWidth: 2, color: Color(hex: 0xC65D5D)) }
        }
    }
    func cell<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        content().frame(width: 16*zoom, height: 16*zoom).frame(maxWidth: .infinity)
    }
}

struct Gallery: View {
    var dark: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(dark ? "深色模式" : "浅色模式").font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("3× 等比放大 · 展开态，同一动画相位").font(.system(size: 11)).foregroundStyle(Color.textSecondary)
            }
            HStack(spacing: 10) {
                Color.clear.frame(width: 100, height: 1)
                HStack(spacing: 0) {
                    ForEach(["助手", "压缩", "用户", "发送", "待答", "授权", "错误", "草稿"], id: \.self) { label in
                        Text(label).font(.system(size: 11, weight: ["压缩", "授权"].contains(label) ? .semibold : .regular))
                            .foregroundStyle(["压缩", "授权"].contains(label) ? Color.krakiPrimary : Color.textSecondary)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            HStack(spacing: 10) {
                Text("上一版").font(.system(size: 12)).foregroundStyle(Color.textSecondary).frame(width: 100, alignment: .leading)
                Neighbors(revised: false, dark: dark)
            }
            HStack(spacing: 10) {
                Text("这一版").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.krakiPrimary).frame(width: 100, alignment: .leading)
                Neighbors(revised: true, dark: dark)
            }
            Divider()
            HStack(spacing: 18) {
                Text("新版实际尺寸").font(.system(size: 11)).foregroundStyle(Color.textSecondary).frame(width: 100, alignment: .leading)
                HStack(spacing: 6) {
                    LucideIcon(.botMessageSquare, size: 13*1.20, strokeWidth: 1.9, color: .krakiPrimary).frame(width: 16, height: 16)
                    Text("助手消息")
                }
                Spacer()
                HStack(spacing: 6) {
                    LucideIcon(.circleUser, size: 13*1.10, strokeWidth: 1.9, color: .textSecondary).frame(width: 16, height: 16)
                    Text("用户消息")
                }
                Spacer()
                HStack(spacing: 6) { Compact(revised: true, dark: dark); Text("正在压缩…") }
                Spacer()
                HStack(spacing: 6) {
                    LucideIcon(.shieldQuestion, size: 14*1.10, strokeWidth: 2.2, color: Color(hex: 0xD97706)).frame(width: 16, height: 16)
                    Text("等待授权")
                }
            }.font(.system(size: 12)).foregroundStyle(Color.textSecondary)
        }.padding(18)
            .background(Color.surfacePrimary, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.borderPrimary, lineWidth: 0.6))
            .foregroundStyle(Color.textPrimary)
            .environment(\.colorScheme, dark ? .dark : .light)
    }
}

struct Board: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("第三版 · 压缩调比例 / 授权 +10%").font(.system(size: 25, weight: .semibold))
            Text("基于上一版：压缩横向 +20%、纵向 +10% · 授权整体 +10% · 助手和用户不变")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            Gallery(dark: false)
            Gallery(dark: true)
            Text("Mac 原生生产图标渲染 · 图形与描边一起缩放 · 16 pt 占位和动画节奏不变 · 未发版")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }.padding(24).frame(width: 840)
            .background(Color(red: 0.946, green: 0.954, blue: 0.968))
            .environment(\.colorScheme, .light)
    }
}

@MainActor
func checks() {
    let old = BaselinePreviewGlyphLayer(), new = SessionPreviewGlyphLayer()
    let color = CGColor(gray: 0.4, alpha: 1)
    old.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: true)
    new.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: true)
    func near(_ a: Double, _ b: Double) { precondition(abs(a-b) < 0.000001, "\(a) != \(b)") }
    near(Double(SessionCompactingGeometry.scale), 0.784)
    near(new.sublayerTransform.m11, 1.20); near(new.sublayerTransform.m22, 1.10)
    precondition(new.anchorPoint == CGPoint(x: 0.5, y: 0.5))
    let aspect = CGAffineTransform(translationX: 8, y: 8)
        .scaledBy(x: new.sublayerTransform.m11, y: new.sublayerTransform.m22)
        .translatedBy(x: -8, y: -8)
    precondition(CGPoint(x: 8, y: 8).applying(aspect) == CGPoint(x: 8, y: 8))
    precondition(new.bounds == old.bounds && new.bounds.width == 16)
    for i in 0..<3 {
        near(new.planes[i].lineWidth, old.planes[i].lineWidth*0.8)
        let a = old.planes[i].path!.boundingBoxOfPath, b = new.planes[i].path!.boundingBoxOfPath
        near(b.width, a.width*0.8); near(b.height, a.height*0.8)
        near(b.midX-8, (a.midX-8)*0.8); near(b.midY-8, (a.midY-8)*0.8)
        near(new.planes[i].transform.m42, old.planes[i].transform.m42*0.8)
        if i != 1 {
            let before = old.planes[i].animation(forKey: "compression") as! CAKeyframeAnimation
            let after = new.planes[i].animation(forKey: "compression") as! CAKeyframeAnimation
            precondition(before.duration == after.duration && before.keyTimes == after.keyTimes)
            for (a, b) in zip(before.values as! [Double], after.values as! [Double]) { near(b, a*0.8) }
        }
    }
    for sample in 0...2000 {
        let t = Double(sample)/2000
        near(SessionCompactingGeometry.compression(t), BaselineCompactingGeometry.compression(t))
        for i in 0..<3 {
            let bounds = new.planes[i].path!.copy(strokingWithWidth: new.planes[i].lineWidth, lineCap: .round, lineJoin: .round, miterLimit: 10).boundingBoxOfPath
            let offset = CGFloat(i-1)*(3.6-1.75*SessionCompactingGeometry.compression(t))*SessionCompactingGeometry.scale
            let before = bounds.offsetBy(dx: 0, dy: offset)
            let after = before.applying(aspect)
            near(after.width, before.width*1.20); near(after.height, before.height*1.10)
            precondition(new.bounds.contains(after))
        }
    }
    let identity = new.planes[0], start = new.planes[0].animation(forKey: "compression")!.beginTime
    new.configure(kind: .compacting, color: CGColor(gray: 0.8, alpha: 1), image: nil, displayScale: 3, animate: true)
    precondition(new.planes[0] === identity && new.planes[0].animation(forKey: "compression")!.beginTime == start)
    new.configure(kind: .compacting, color: color, image: nil, displayScale: 2, animate: false)
    precondition(new.planes.allSatisfy { ($0.animationKeys() ?? []).isEmpty })
    old.configure(kind: .delivery(.sending), color: color, image: nil, displayScale: 2, animate: true)
    new.configure(kind: .delivery(.sending), color: color, image: nil, displayScale: 2, animate: true)
    precondition(CATransform3DIsIdentity(new.sublayerTransform))
    for key in ["outgoing", "activity"] {
        let a = old.delivery.animation(forKey: key) as! CAKeyframeAnimation
        let b = new.delivery.animation(forKey: key) as! CAKeyframeAnimation
        precondition(a.values as! [Double] == b.values as! [Double] && a.duration == b.duration)
    }
    print("PASS: base 0.8 geometry + centered 1.20x/1.10y parent transform (including stroke/travel); 2,001 full-cycle bounds/ratio samples; unchanged 16pt slot, cadence, delivery size/animation, theme identity and Reduce Motion cleanup")
}

@main
struct Preview {
    @MainActor static func main() throws {
        _ = NSApplication.shared
        checks()
        let renderer = ImageRenderer(content: Board())
        renderer.scale = 2
        let image = renderer.cgImage!
        let rep = NSBitmapImageRep(cgImage: image)
        let path = CommandLine.arguments[1]
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
        print("Wrote \(path) (\(image.width)×\(image.height))")
    }
}
