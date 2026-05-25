#if os(iOS)
/// AgentAvatar — Exact match of web AgentAvatar.tsx.
///
/// - Rounded rect (not circle) with per-session hue-based color
/// - Copilot SVG icon (same for all agents, colored per session)
/// - Corner badges (priority order at each anchor):
///     • bottom-right → permission-pending shield (amber).
///     • top-right    → pending-question glyph if any, else a
///                      loading spinner while `status == .active`.
///   Permission lives bottom-right, question lives top-right so the
///   two can co-exist on the same avatar without colliding.

import SwiftUI

// MARK: - Avatar Size

enum AvatarSize {
    case xs  // 18pt, rounded-sm (4pt)
    case sm  // 28pt, rounded-md (6pt)
    case md  // 36pt, rounded-lg (8pt)

    var dimension: CGFloat {
        switch self {
        case .xs: return 18
        case .sm: return 28
        case .md: return 36
        }
    }

    var cornerRadius: CGFloat {
        switch self {
        case .xs: return 4
        case .sm: return 6
        case .md: return 8
        }
    }

    var iconSize: CGFloat {
        switch self {
        case .xs: return 10
        case .sm: return 16
        case .md: return 20
        }
    }

    /// Diameter of a corner-badge glyph. Same scale we used for the
    /// previous tool-status icon — readable without crowding the
    /// avatar's main glyph.
    var badgeIconSize: CGFloat {
        switch self {
        case .xs: return 8
        case .sm: return 12
        case .md: return 14
        }
    }

    var pinSize: CGFloat {
        switch self {
        case .xs: return 7
        case .sm: return 10
        case .md: return 10
        }
    }
}

// MARK: - AgentAvatar View

struct AgentAvatar: View {
    let agent: String
    var sessionId: String? = nil
    var size: AvatarSize = .md
    var status: SessionState? = nil
    /// When true, render a shield-question glyph at the avatar's
    /// bottom-right corner. Driven by `MessageStore.permissionsForSession`.
    var pendingPermission: Bool = false
    /// When true, render a question-circle glyph at the avatar's
    /// top-right corner — overrides the active-state spinner so we
    /// don't double-stack indicators in the same spot.
    var pendingQuestion: Bool = false

    /// Deterministic hue from sessionId (or agent name as fallback)
    private var hue: Double {
        stringToHue(sessionId ?? agent)
    }

    private var bgColor: Color {
        let (h, s, b) = hslToHSB(h: hue / 360, s: 0.50, l: 0.90)
        return Color(hue: h, saturation: s, brightness: b)
    }

    private var iconColor: Color {
        let (h, s, b) = hslToHSB(h: hue / 360, s: 0.60, l: 0.40)
        return Color(hue: h, saturation: s, brightness: b)
    }

    var body: some View {
        ZStack {
            // Circle background with session-hue color
            Circle()
                .fill(bgColor)
                .frame(width: size.dimension, height: size.dimension)

            // Copilot SVG icon (same for all agents)
            CopilotIcon()
                .fill(iconColor)
                .frame(width: size.iconSize, height: size.iconSize)
        }
        .overlay(alignment: .bottomTrailing) {
            // Permission-pending shield. Solid red — stays readable
            // on any avatar hue without needing a backing disc.
            if pendingPermission {
                LucideIcon(.shieldQuestion,
                           size: size.badgeIconSize,
                           strokeWidth: 2.5,
                           color: Color(hex: 0xEF4444))
                    .offset(x: 4, y: 4)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .topTrailing) {
            // Question-pending glyph. Solid orange — stays readable
            // on any avatar hue without needing a backing disc.
            // Overrides the active-state spinner so we don't stack
            // indicators in the same corner.
            if pendingQuestion {
                LucideIcon(.messageCircleQuestion,
                           size: size.badgeIconSize,
                           strokeWidth: 2.5,
                           color: Color(hex: 0xF97316))
                    .offset(x: 4, y: -1)
                    .transition(.opacity)
            } else if status == .active {
                // Active-turn spinner. The default `krakiPrimary`
                // adaptively shifts to `kraki300` in dark mode, which
                // washes out the spinner strokes against the avatar's
                // pale-pastel hue. Pin a more solid blue for the
                // dark case so the spinner reads as a confident
                // affordance in both themes.
                ProgressView()
                    .controlSize(.mini)
                    .tint(Color(light: UIColor(Color.kraki500),
                                dark:  UIColor(Color.kraki400)))
                    .offset(x: 4, y: -1)
                    .transition(.opacity)
            }
        }
    }
}

// MARK: - Copilot Icon (SVG Shape)

/// The GitHub Copilot logo — used as the avatar icon for all agents.
/// Exact SVG path from the web AgentAvatar.tsx CopilotIcon component.
private struct CopilotIcon: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        var path = Path()

        // Main body
        path.addPath(parseSVGPath("M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z").applying(.init(scaleX: scale, y: scale)))

        // Eyes
        path.addPath(parseSVGPath("M14.5 14.25a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Zm-5 0a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Z").applying(.init(scaleX: scale, y: scale)))

        return path
    }
}

// MARK: - HSL to HSB conversion

/// Converts CSS HSL values to SwiftUI HSB values.
func hslToHSB(h: Double, s: Double, l: Double) -> (h: Double, s: Double, b: Double) {
    let b = l + s * min(l, 1 - l)
    let sHSB = b == 0 ? 0 : 2 * (1 - l / b)
    return (h, sHSB, b)
}

// MARK: - String → Hue hash

/// Deterministic hash of a string to a hue value (0-360).
/// Mirrors web's `stringToHue()` from lib/color.ts.
func stringToHue(_ str: String) -> Double {
    var hash: Int32 = 0
    for char in str.unicodeScalars {
        hash = (hash &* 31) &+ Int32(char.value)
    }
    return Double(abs(hash) % 360)
}

// MARK: - Agent Info (for labels, kept for session cards)

struct AgentInfo {
    let label: String

    static func from(_ agent: String) -> AgentInfo {
        switch agent.lowercased() {
        case "copilot": return AgentInfo(label: "Copilot")
        case "claude": return AgentInfo(label: "Claude")
        case "codex": return AgentInfo(label: "Codex")
        default: return AgentInfo(label: agent.capitalized)
        }
    }
}

#endif
