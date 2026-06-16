#if os(iOS)
/// LucideIcon — SwiftUI view that renders Lucide icons from SVG path data.
///
/// All icons use viewBox 0 0 24 24, stroke rendering (no fill),
/// strokeWidth 2, round line cap/join.

import SwiftUI

// MARK: - LucideIcon View

struct LucideIcon: View {
    let icon: LucideIconType
    var size: CGFloat = 20
    var strokeWidth: CGFloat = 2
    var color: Color = .primary

    init(_ icon: LucideIconType, size: CGFloat = 20, strokeWidth: CGFloat = 2, color: Color = .primary) {
        self.icon = icon
        self.size = size
        self.strokeWidth = strokeWidth
        self.color = color
    }

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / 24
            let scaledStroke = strokeWidth * scale

            for element in icon.elements {
                var path: Path
                switch element {
                case .path(let d):
                    path = parseSVGPath(d)
                case .circle(let cx, let cy, let r):
                    path = Path(ellipseIn: CGRect(
                        x: cx - r, y: cy - r,
                        width: r * 2, height: r * 2
                    ))
                case .rect(let x, let y, let w, let h, let rx):
                    path = Path(roundedRect: CGRect(x: x, y: y, width: w, height: h),
                                cornerRadius: rx)
                }

                let transform = CGAffineTransform(scaleX: scale, y: scale)
                let scaledPath = path.applying(transform)

                context.stroke(
                    scaledPath,
                    with: .color(color),
                    style: StrokeStyle(
                        lineWidth: scaledStroke,
                        lineCap: .round,
                        lineJoin: .round
                    )
                )
            }
        }
        // Supersample the Canvas at 2× the display size, then scale
        // back down. Rendering at higher internal resolution and
        // letting SwiftUI/Metal downsample produces noticeably
        // sharper strokes (better anti-aliasing of the stroke
        // edges) than rendering directly at the target size.
        .frame(width: size * 2, height: size * 2)
        .scaleEffect(0.5)
        .frame(width: size, height: size)
        .drawingGroup()
    }
}

// MARK: - Tab Bar Image

extension LucideIconType {
    /// Renders the icon as a template-mode `Image` suitable for use in `tabItem` or other
    /// contexts where SwiftUI requires a concrete `Image` rather than an arbitrary `View`.
    @MainActor
    func tabImage(size: CGFloat = 24) -> Image {
        let view = LucideIcon(self, size: size, color: .black)
        let renderer = ImageRenderer(content: view)
        renderer.scale = UIScreen.main.scale
        if let uiImage = renderer.uiImage {
            return Image(uiImage: uiImage.withRenderingMode(.alwaysTemplate))
        }
        return Image(systemName: "questionmark")
    }

    /// Renders the icon as a template-mode `Image` for swipe action labels.
    @MainActor
    func swipeImage(size: CGFloat = 22) -> Image {
        tabImage(size: size)
    }
}

// MARK: - SVG Element

enum SVGElement {
    case path(String)
    case circle(cx: CGFloat, cy: CGFloat, r: CGFloat)
    case rect(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, rx: CGFloat)
}

// MARK: - LucideIconType

enum LucideIconType {
    case bellOff
    case bellRing
    case check
    case checkCircle2
    case circleStop
    case copy
    case fileEdit
    case fileText
    case folderSearch
    case gitFork
    case imagePlus
    case loader2
    case lock
    case lockOpen
    case messageSquare
    case pencil
    case pin
    case pinOff
    case search
    case square
    case terminal
    case trash2
    case x
    case botMessageSquare
    case monitorCloud
    case userCog
    case circleSlash
    case shieldQuestion
    case messageCircleQuestion
    case squareTerminal
    case chevronsLeftRightEllipsis
    case searchCode
    case fileSearch
    case squareMousePointer
    case keyboard
    case mic
    case sendHorizontal
    case circleUser
    case bookText

    var elements: [SVGElement] {
        switch self {
        case .bellOff:
            return [
                .path("M10.268 21a2 2 0 0 0 3.464 0"),
                .path("M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"),
                .path("M2 2L22 22"),
                .path("M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"),
            ]
        case .bellRing:
            return [
                .path("M10.268 21a2 2 0 0 0 3.464 0"),
                .path("M22 8c0-2.3-.8-4.3-2-6"),
                .path("M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"),
                .path("M4 2C2.8 3.7 2 5.7 2 8"),
            ]
        case .check:
            return [
                .path("M20 6L9 17L4 12"),
            ]
        case .checkCircle2:
            return [
                .circle(cx: 12, cy: 12, r: 10),
                .path("M9 12L11 14L15 10"),
            ]
        case .circleStop:
            return [
                .circle(cx: 12, cy: 12, r: 10),
                .rect(x: 9, y: 9, width: 6, height: 6, rx: 1),
            ]
        case .copy:
            return [
                .rect(x: 8, y: 8, width: 14, height: 14, rx: 2),
                .path("M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"),
            ]
        case .fileEdit:
            return [
                .path("M12.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v9.34"),
                .path("M14 2v5a1 1 0 0 0 1 1h5"),
                .path("M10.378 12.622a1 1 0 0 1 3 3.003L8.36 20.637a2 2 0 0 1-.854.506l-2.867.837a.5.5 0 0 1-.62-.62l.836-2.869a2 2 0 0 1 .506-.853Z"),
            ]
        case .fileText:
            return [
                .path("M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2Z"),
                .path("M14 2v5a1 1 0 0 0 1 1h5"),
                .path("M10 9H8"),
                .path("M16 13H8"),
            ]
        case .folderSearch:
            return [
                .path("M10.7 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v4.1"),
                .path("M21 21L19.1 19.1"),
                .circle(cx: 17, cy: 17, r: 3),
            ]
        case .gitFork:
            return [
                .circle(cx: 12, cy: 18, r: 3),
                .circle(cx: 6, cy: 6, r: 3),
                .circle(cx: 18, cy: 6, r: 3),
                .path("M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"),
                .path("M12 12v3"),
            ]
        case .imagePlus:
            return [
                .path("M16 5h6"),
                .path("M19 2v6"),
                .path("M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"),
                .path("M21 15L17.914 11.914a2 2 0 0 0-2.828 0L6 21"),
                .circle(cx: 9, cy: 9, r: 2),
            ]
        case .loader2:
            return [
                .path("M21 12a9 9 0 1 1-6.219-8.56"),
            ]
        case .lock:
            return [
                .rect(x: 3, y: 11, width: 18, height: 11, rx: 2),
                .path("M7 11V7a5 5 0 0 1 10 0v4"),
            ]
        case .lockOpen:
            return [
                .rect(x: 3, y: 11, width: 18, height: 11, rx: 2),
                .path("M7 11V7a5 5 0 0 1 9.9-1"),
            ]
        case .messageSquare:
            return [
                .path("M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2Z"),
            ]
        case .pencil:
            return [
                .path("M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497Z"),
                .path("M15 5L19 9"),
            ]
        case .pin:
            return [
                .path("M12 17v5"),
                .path("M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z"),
            ]
        case .pinOff:
            return [
                .path("M12 17v5"),
                .path("M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"),
                .path("M2 2L22 22"),
                .path("M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"),
            ]
        case .search:
            return [
                .path("M21 21L16.66 16.66"),
                .circle(cx: 11, cy: 11, r: 8),
            ]
        case .square:
            return [
                .rect(x: 3, y: 3, width: 18, height: 18, rx: 2),
            ]
        case .terminal:
            return [
                .path("M12 19h8"),
                .path("M4 17L10 11L4 5"),
            ]
        case .trash2:
            return [
                .path("M10 11v6"),
                .path("M14 11v6"),
                .path("M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"),
                .path("M3 6h18"),
                .path("M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"),
            ]
        case .x:
            return [
                .path("M18 6L6 18"),
                .path("M6 6L18 18"),
            ]
        case .botMessageSquare:
            return [
                .path("M12 6V2H8"),
                .path("M15 11v2"),
                .path("M9 11v2"),
                .path("M2 12h2"),
                .path("M20 12h2"),
                .path("M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"),
            ]
        case .monitorCloud:
            return [
                .path("M11 13a3 3 0 1 1 2.83-4H14a2 2 0 0 1 0 4Z"),
                .path("M12 17v4"),
                .path("M8 21h8"),
                .rect(x: 2, y: 3, width: 20, height: 14, rx: 2),
            ]
        case .userCog:
            return [
                .circle(cx: 9, cy: 7, r: 4),
                .path("M10 15H6a4 4 0 0 0-4 4v2"),
                .path("m14.305 16.53.923-.382"),
                .path("m15.228 13.852-.923-.383"),
                .path("m16.852 12.228-.383-.923"),
                .path("m16.852 17.772-.383.924"),
                .path("m19.148 12.228.383-.923"),
                .path("m19.53 18.696-.382-.924"),
                .path("m20.772 13.852.924-.383"),
                .path("m20.772 16.148.924.383"),
                .circle(cx: 18, cy: 15, r: 3),
            ]
        case .circleSlash:
            return [
                .circle(cx: 12, cy: 12, r: 10),
                .path("M9 15L15 9"),
            ]
        case .shieldQuestion:
            return [
                .path("M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"),
                .path("M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"),
                .path("M12 17h.01"),
            ]
        case .messageCircleQuestion:
            return [
                .path("M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"),
                .path("M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"),
                .path("M12 17h.01"),
            ]
        case .squareTerminal:
            return [
                .path("m7 11 2-2-2-2"),
                .path("M11 13h4"),
                .rect(x: 3, y: 3, width: 18, height: 18, rx: 2),
            ]
        case .chevronsLeftRightEllipsis:
            return [
                .path("M12 12h.01"),
                .path("M16 12h.01"),
                .path("m17 7 5 5-5 5"),
                .path("m7 7-5 5 5 5"),
                .path("M8 12h.01"),
            ]
        case .searchCode:
            return [
                .path("m13 13.5 2-2.5-2-2.5"),
                .path("m21 21-4.3-4.3"),
                .path("M9 8.5 7 11l2 2.5"),
                .circle(cx: 11, cy: 11, r: 8),
            ]
        case .fileSearch:
            return [
                .path("M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"),
                .path("M14 2v5a1 1 0 0 0 1 1h5"),
                .circle(cx: 11.5, cy: 14.5, r: 2.5),
                .path("M13.3 16.3 15 18"),
            ]
        case .squareMousePointer:
            return [
                .path("M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z"),
                .path("M21 11V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6"),
            ]
        case .keyboard:
            return [
                .path("M10 8h.01"),
                .path("M12 12h.01"),
                .path("M14 8h.01"),
                .path("M16 12h.01"),
                .path("M18 8h.01"),
                .path("M6 8h.01"),
                .path("M7 16h10"),
                .path("M8 12h.01"),
                .rect(x: 2, y: 4, width: 20, height: 16, rx: 2),
            ]
        case .mic:
            return [
                .path("M12 19v3"),
                .path("M19 10v2a7 7 0 0 1-14 0v-2"),
                .rect(x: 9, y: 2, width: 6, height: 13, rx: 3),
            ]
        case .sendHorizontal:
            return [
                .path("M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"),
                .path("M6 12h16"),
            ]
        case .circleUser:
            return [
                .circle(cx: 12, cy: 12, r: 10),
                .circle(cx: 12, cy: 10, r: 3),
                .path("M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662"),
            ]
        case .bookText:
            return [
                .path("M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"),
                .path("M8 11h8"),
                .path("M8 7h6"),
            ]
        }
    }
}

// MARK: - SVG Path Parser

/// Parses a subset of SVG path `d` attribute into a SwiftUI `Path`.
/// Supports: M/m, L/l, H/h, V/v, C/c, S/s, Q/q, T/t, A/a, Z/z
func parseSVGPath(_ d: String) -> Path {
    var path = Path()
    let tokens = tokenizeSVGPath(d)
    var i = 0
    var currentX: CGFloat = 0
    var currentY: CGFloat = 0
    var startX: CGFloat = 0
    var startY: CGFloat = 0
    var lastControlX: CGFloat = 0
    var lastControlY: CGFloat = 0
    var lastCommand: Character = " "

    func num() -> CGFloat {
        guard i < tokens.count else { return 0 }
        let val = CGFloat(Double(tokens[i]) ?? 0)
        i += 1
        return val
    }

    func hasMoreNumbers() -> Bool {
        guard i < tokens.count else { return false }
        return Double(tokens[i]) != nil
    }

    while i < tokens.count {
        let token = tokens[i]

        // Check if token is a command letter
        guard let cmd = token.first, token.count == 1, cmd.isLetter else {
            i += 1
            continue
        }
        i += 1

        let cmdChar = cmd

        switch cmdChar {
        case "M":
            repeat {
                let x = num(); let y = num()
                if lastCommand != "M" && lastCommand != " " {
                    path.addLine(to: CGPoint(x: x, y: y))
                } else {
                    path.move(to: CGPoint(x: x, y: y))
                }
                currentX = x; currentY = y
                startX = currentX; startY = currentY
                lastCommand = "M"
            } while hasMoreNumbers()

        case "m":
            var first = true
            repeat {
                let dx = num(); let dy = num()
                currentX += dx; currentY += dy
                if first {
                    path.move(to: CGPoint(x: currentX, y: currentY))
                    startX = currentX; startY = currentY
                    first = false
                } else {
                    // Implicit relative line-to after first move
                    path.addLine(to: CGPoint(x: currentX, y: currentY))
                }
                lastCommand = "m"
            } while hasMoreNumbers()

        case "L":
            repeat {
                let x = num(); let y = num()
                path.addLine(to: CGPoint(x: x, y: y))
                currentX = x; currentY = y
                lastCommand = "L"
            } while hasMoreNumbers()

        case "l":
            repeat {
                let dx = num(); let dy = num()
                currentX += dx; currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
                lastCommand = "l"
            } while hasMoreNumbers()

        case "H":
            repeat {
                let x = num()
                path.addLine(to: CGPoint(x: x, y: currentY))
                currentX = x
                lastCommand = "H"
            } while hasMoreNumbers()

        case "h":
            repeat {
                let dx = num()
                currentX += dx
                path.addLine(to: CGPoint(x: currentX, y: currentY))
                lastCommand = "h"
            } while hasMoreNumbers()

        case "V":
            repeat {
                let y = num()
                path.addLine(to: CGPoint(x: currentX, y: y))
                currentY = y
                lastCommand = "V"
            } while hasMoreNumbers()

        case "v":
            repeat {
                let dy = num()
                currentY += dy
                path.addLine(to: CGPoint(x: currentX, y: currentY))
                lastCommand = "v"
            } while hasMoreNumbers()

        case "C":
            repeat {
                let x1 = num(); let y1 = num()
                let x2 = num(); let y2 = num()
                let x = num(); let y = num()
                path.addCurve(
                    to: CGPoint(x: x, y: y),
                    control1: CGPoint(x: x1, y: y1),
                    control2: CGPoint(x: x2, y: y2)
                )
                lastControlX = x2; lastControlY = y2
                currentX = x; currentY = y
                lastCommand = "C"
            } while hasMoreNumbers()

        case "c":
            repeat {
                let dx1 = num(); let dy1 = num()
                let dx2 = num(); let dy2 = num()
                let dx = num(); let dy = num()
                let x1 = currentX + dx1; let y1 = currentY + dy1
                let x2 = currentX + dx2; let y2 = currentY + dy2
                let x = currentX + dx; let y = currentY + dy
                path.addCurve(
                    to: CGPoint(x: x, y: y),
                    control1: CGPoint(x: x1, y: y1),
                    control2: CGPoint(x: x2, y: y2)
                )
                lastControlX = x2; lastControlY = y2
                currentX = x; currentY = y
                lastCommand = "c"
            } while hasMoreNumbers()

        case "S":
            repeat {
                let cx1: CGFloat
                let cy1: CGFloat
                if lastCommand == "C" || lastCommand == "c" || lastCommand == "S" || lastCommand == "s" {
                    cx1 = 2 * currentX - lastControlX
                    cy1 = 2 * currentY - lastControlY
                } else {
                    cx1 = currentX; cy1 = currentY
                }
                let x2 = num(); let y2 = num()
                let x = num(); let y = num()
                path.addCurve(
                    to: CGPoint(x: x, y: y),
                    control1: CGPoint(x: cx1, y: cy1),
                    control2: CGPoint(x: x2, y: y2)
                )
                lastControlX = x2; lastControlY = y2
                currentX = x; currentY = y
                lastCommand = "S"
            } while hasMoreNumbers()

        case "s":
            repeat {
                let cx1: CGFloat
                let cy1: CGFloat
                if lastCommand == "C" || lastCommand == "c" || lastCommand == "S" || lastCommand == "s" {
                    cx1 = 2 * currentX - lastControlX
                    cy1 = 2 * currentY - lastControlY
                } else {
                    cx1 = currentX; cy1 = currentY
                }
                let dx2 = num(); let dy2 = num()
                let dx = num(); let dy = num()
                let x2 = currentX + dx2; let y2 = currentY + dy2
                let x = currentX + dx; let y = currentY + dy
                path.addCurve(
                    to: CGPoint(x: x, y: y),
                    control1: CGPoint(x: cx1, y: cy1),
                    control2: CGPoint(x: x2, y: y2)
                )
                lastControlX = x2; lastControlY = y2
                currentX = x; currentY = y
                lastCommand = "s"
            } while hasMoreNumbers()

        case "Q":
            repeat {
                let x1 = num(); let y1 = num()
                let x = num(); let y = num()
                path.addQuadCurve(
                    to: CGPoint(x: x, y: y),
                    control: CGPoint(x: x1, y: y1)
                )
                lastControlX = x1; lastControlY = y1
                currentX = x; currentY = y
                lastCommand = "Q"
            } while hasMoreNumbers()

        case "q":
            repeat {
                let dx1 = num(); let dy1 = num()
                let dx = num(); let dy = num()
                let x1 = currentX + dx1; let y1 = currentY + dy1
                let x = currentX + dx; let y = currentY + dy
                path.addQuadCurve(
                    to: CGPoint(x: x, y: y),
                    control: CGPoint(x: x1, y: y1)
                )
                lastControlX = x1; lastControlY = y1
                currentX = x; currentY = y
                lastCommand = "q"
            } while hasMoreNumbers()

        case "T":
            repeat {
                let cx1: CGFloat
                let cy1: CGFloat
                if lastCommand == "Q" || lastCommand == "q" || lastCommand == "T" || lastCommand == "t" {
                    cx1 = 2 * currentX - lastControlX
                    cy1 = 2 * currentY - lastControlY
                } else {
                    cx1 = currentX; cy1 = currentY
                }
                let x = num(); let y = num()
                path.addQuadCurve(
                    to: CGPoint(x: x, y: y),
                    control: CGPoint(x: cx1, y: cy1)
                )
                lastControlX = cx1; lastControlY = cy1
                currentX = x; currentY = y
                lastCommand = "T"
            } while hasMoreNumbers()

        case "t":
            repeat {
                let cx1: CGFloat
                let cy1: CGFloat
                if lastCommand == "Q" || lastCommand == "q" || lastCommand == "T" || lastCommand == "t" {
                    cx1 = 2 * currentX - lastControlX
                    cy1 = 2 * currentY - lastControlY
                } else {
                    cx1 = currentX; cy1 = currentY
                }
                let dx = num(); let dy = num()
                let x = currentX + dx; let y = currentY + dy
                path.addQuadCurve(
                    to: CGPoint(x: x, y: y),
                    control: CGPoint(x: cx1, y: cy1)
                )
                lastControlX = cx1; lastControlY = cy1
                currentX = x; currentY = y
                lastCommand = "t"
            } while hasMoreNumbers()

        case "A":
            repeat {
                let rx = num(); let ry = num()
                let rotation = num()
                let largeArc = num(); let sweep = num()
                let x = num(); let y = num()
                addArc(
                    to: &path,
                    from: CGPoint(x: currentX, y: currentY),
                    to: CGPoint(x: x, y: y),
                    rx: rx, ry: ry,
                    rotation: rotation,
                    largeArc: largeArc != 0,
                    sweep: sweep != 0
                )
                currentX = x; currentY = y
                lastCommand = "A"
            } while hasMoreNumbers()

        case "a":
            repeat {
                let rx = num(); let ry = num()
                let rotation = num()
                let largeArc = num(); let sweep = num()
                let dx = num(); let dy = num()
                let x = currentX + dx; let y = currentY + dy
                addArc(
                    to: &path,
                    from: CGPoint(x: currentX, y: currentY),
                    to: CGPoint(x: x, y: y),
                    rx: rx, ry: ry,
                    rotation: rotation,
                    largeArc: largeArc != 0,
                    sweep: sweep != 0
                )
                currentX = x; currentY = y
                lastCommand = "a"
            } while hasMoreNumbers()

        case "Z", "z":
            path.closeSubpath()
            currentX = startX; currentY = startY
            lastCommand = "Z"

        default:
            break
        }
    }

    return path
}

// MARK: - SVG Path Tokenizer

private func tokenizeSVGPath(_ d: String) -> [String] {
    var tokens: [String] = []
    var current = ""
    let chars = Array(d)
    var i = 0

    while i < chars.count {
        let ch = chars[i]

        if ch.isWhitespace || ch == "," {
            if !current.isEmpty {
                tokens.append(current)
                current = ""
            }
            i += 1
            continue
        }

        if ch.isLetter {
            if !current.isEmpty {
                tokens.append(current)
                current = ""
            }
            tokens.append(String(ch))
            i += 1
            continue
        }

        // Start of a number
        if ch == "-" || ch == "+" || ch == "." || ch.isNumber {
            // If we already have a number and hit a minus sign, split
            if !current.isEmpty && (ch == "-" || ch == "+") {
                tokens.append(current)
                current = ""
            }
            // Handle implicit split on second decimal point
            if ch == "." && current.contains(".") {
                tokens.append(current)
                current = ""
            }
            current.append(ch)
            i += 1
            continue
        }

        i += 1
    }

    if !current.isEmpty {
        tokens.append(current)
    }

    return tokens
}

// MARK: - SVG Arc to Bezier

/// Converts an SVG arc command into one or more cubic bezier curves.
private func addArc(
    to path: inout Path,
    from p1: CGPoint,
    to p2: CGPoint,
    rx inputRx: CGFloat,
    ry inputRy: CGFloat,
    rotation: CGFloat,
    largeArc: Bool,
    sweep: Bool
) {
    guard p1 != p2 else { return }

    var rx = abs(inputRx)
    var ry = abs(inputRy)
    guard rx > 0, ry > 0 else {
        path.addLine(to: p2)
        return
    }

    let phi = rotation * .pi / 180
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)

    let dx = (p1.x - p2.x) / 2
    let dy = (p1.y - p2.y) / 2

    let x1p = cosPhi * dx + sinPhi * dy
    let y1p = -sinPhi * dx + cosPhi * dy

    // Scale radii if necessary
    var lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lambda > 1 {
        let sqrtLambda = sqrt(lambda)
        rx *= sqrtLambda
        ry *= sqrtLambda
        lambda = 1
    }

    let rxSq = rx * rx
    let rySq = ry * ry
    let x1pSq = x1p * x1p
    let y1pSq = y1p * y1p

    var sq = max(0, (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq))
    sq = sqrt(sq)
    let sign: CGFloat = (largeArc == sweep) ? -1 : 1

    let cxp = sign * sq * (rx * y1p / ry)
    let cyp = sign * sq * -(ry * x1p / rx)

    let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2
    let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2

    let theta1 = svgAngle(ux: 1, uy: 0, vx: (x1p - cxp) / rx, vy: (y1p - cyp) / ry)
    var dTheta = svgAngle(
        ux: (x1p - cxp) / rx, uy: (y1p - cyp) / ry,
        vx: (-x1p - cxp) / rx, vy: (-y1p - cyp) / ry
    )

    if !sweep && dTheta > 0 { dTheta -= 2 * .pi }
    if sweep && dTheta < 0 { dTheta += 2 * .pi }

    // Split arc into segments of at most π/2
    let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2))))
    let delta = dTheta / CGFloat(segments)

    for seg in 0..<segments {
        let t1 = theta1 + CGFloat(seg) * delta
        let t2 = t1 + delta
        arcToBezier(path: &path, cx: cx, cy: cy, rx: rx, ry: ry, phi: phi, t1: t1, t2: t2)
    }
}

private func svgAngle(ux: CGFloat, uy: CGFloat, vx: CGFloat, vy: CGFloat) -> CGFloat {
    let dot = ux * vx + uy * vy
    let len = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
    var angle = acos(max(-1, min(1, dot / len)))
    if ux * vy - uy * vx < 0 { angle = -angle }
    return angle
}

private func arcToBezier(
    path: inout Path,
    cx: CGFloat, cy: CGFloat,
    rx: CGFloat, ry: CGFloat,
    phi: CGFloat,
    t1: CGFloat, t2: CGFloat
) {
    let cosPhi = cos(phi)
    let sinPhi = sin(phi)

    let alpha = sin(t2 - t1) * (sqrt(4 + 3 * pow(tan((t2 - t1) / 2), 2)) - 1) / 3

    let cosT1 = cos(t1)
    let sinT1 = sin(t1)
    let cosT2 = cos(t2)
    let sinT2 = sin(t2)

    let ex1 = rx * cosT1
    let ey1 = ry * sinT1
    let ex2 = rx * cosT2
    let ey2 = ry * sinT2

    let dx1 = -rx * sinT1
    let dy1 = ry * cosT1
    let dx2 = -rx * sinT2
    let dy2 = ry * cosT2

    let cp1x = cx + cosPhi * (ex1 + alpha * dx1) - sinPhi * (ey1 + alpha * dy1)
    let cp1y = cy + sinPhi * (ex1 + alpha * dx1) + cosPhi * (ey1 + alpha * dy1)
    let cp2x = cx + cosPhi * (ex2 - alpha * dx2) - sinPhi * (ey2 - alpha * dy2)
    let cp2y = cy + sinPhi * (ex2 - alpha * dx2) + cosPhi * (ey2 - alpha * dy2)
    let endX = cx + cosPhi * ex2 - sinPhi * ey2
    let endY = cy + sinPhi * ex2 + cosPhi * ey2

    path.addCurve(
        to: CGPoint(x: endX, y: endY),
        control1: CGPoint(x: cp1x, y: cp1y),
        control2: CGPoint(x: cp2x, y: cp2y)
    )
}

#endif
