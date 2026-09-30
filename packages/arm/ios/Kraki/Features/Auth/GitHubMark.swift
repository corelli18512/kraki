import SwiftUI

// MARK: - GitHub SVG Mark

/// GitHub's octocat logo as a SwiftUI Shape — exact SVG path from the web app.
struct GitHubMark: View {
    var color: Color = .white
    var body: some View {
        GitHubShape()
            .fill(color)
    }
}

struct GitHubShape: Shape {
    func path(in rect: CGRect) -> Path {
        // GitHub Octicon mark, viewBox 0 0 16 16. Re-translated from
        // the canonical SVG `d` attribute via a relative-to-absolute
        // helper so the curve control points are correct.
        let scale = min(rect.width, rect.height) / 16
        var inner = Path()
        var cur = CGPoint(x: 8, y: 0)
        inner.move(to: cur)

        func absC(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat, _ y: CGFloat) {
            inner.addCurve(
                to: CGPoint(x: x, y: y),
                control1: CGPoint(x: x1, y: y1),
                control2: CGPoint(x: x2, y: y2)
            )
            cur = CGPoint(x: x, y: y)
        }
        func relC(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ x: CGFloat, _ y: CGFloat) {
            absC(cur.x + x1, cur.y + y1, cur.x + x2, cur.y + y2, cur.x + x, cur.y + y)
        }

        // From SVG d: M8 0 C3.58 0 0 3.58 0 8 c0 3.54 2.29 6.53 5.47 7.59 ...
        absC(3.58, 0, 0, 3.58, 0, 8)
        relC(0, 3.54, 2.29, 6.53, 5.47, 7.59)
        relC(0.4, 0.07, 0.55, -0.17, 0.55, -0.38)
        relC(0, -0.19, -0.01, -0.82, -0.01, -1.49)
        relC(-2.01, 0.37, -2.53, -0.49, -2.69, -0.94)
        relC(-0.09, -0.23, -0.48, -0.94, -0.82, -1.13)
        relC(-0.28, -0.15, -0.68, -0.52, -0.01, -0.53)
        relC(0.63, -0.01, 1.08, 0.58, 1.23, 0.82)
        relC(0.72, 1.21, 1.87, 0.87, 2.33, 0.66)
        relC(0.07, -0.52, 0.28, -0.87, 0.51, -1.07)
        relC(-1.78, -0.2, -3.64, -0.89, -3.64, -3.95)
        relC(0, -0.87, 0.31, -1.59, 0.82, -2.15)
        relC(-0.08, -0.2, -0.36, -1.02, 0.08, -2.12)
        relC(0, 0, 0.67, -0.21, 2.2, 0.82)
        // a 7.59 7.59 0 0 1 2-.27 → tiny near-horizontal arc, approximate
        // as a flat cubic so we don't need an arc primitive.
        relC(0.67, -0.09, 1.33, -0.18, 2, -0.27)
        // a 7.594 7.594 0 0 1 2 .27 → mirror arc on the right side.
        relC(0.67, 0.09, 1.33, 0.18, 2, 0.27)
        relC(1.53, -1.04, 2.2, -0.82, 2.2, -0.82)
        relC(0.44, 1.1, 0.16, 1.92, 0.08, 2.12)
        relC(0.51, 0.56, 0.82, 1.27, 0.82, 2.15)
        relC(0, 3.07, -1.87, 3.75, -3.65, 3.95)
        relC(0.29, 0.25, 0.54, 0.73, 0.54, 1.48)
        relC(0, 1.07, -0.01, 1.93, -0.01, 2.2)
        relC(0, 0.21, 0.15, 0.46, 0.55, 0.38)
        // A8.013 8.013 0 0 0 16 8 → final near-vertical arc back up.
        absC(13.71, 14.53, 16, 11.54, 16, 8)
        // c0-4.42-3.58-8-8-8
        relC(0, -4.42, -3.58, -8, -8, -8)
        inner.closeSubpath()

        return inner
            .applying(.init(scaleX: scale, y: scale))
            .offsetBy(dx: (rect.width - 16 * scale) / 2,
                      dy: (rect.height - 16 * scale) / 2)
    }
}
