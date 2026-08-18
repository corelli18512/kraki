import Foundation
import SwiftUI

/// Product-level Session Card projection shared by iOS and macOS.
/// Platform views own only their native cell/container mechanics.
enum SessionCardStatus: Equatable {
    case active
    case compacting
    case waiting
    case approval
    case error
    case offline
    case agentMessage
    case humanMessage
    case idle

    static func resolve(
        sessionState: SessionState,
        previewType: String?,
        deviceOnline: Bool?,
        hasDraft: Bool = false
    ) -> Self {
        if deviceOnline == false { return .offline }
        switch previewType {
        case "question": return .waiting
        case "permission": return .approval
        case "error": return .error
        default: break
        }
        switch sessionState {
        case .active: return .active
        case .compacting: return .compacting
        case .idle:
            if hasDraft { return .humanMessage }
            switch previewType {
            case "agent", "agent_message": return .agentMessage
            case "user", "user_message": return .humanMessage
            default: return .idle
            }
        }
    }

    var accessibilityLabel: String? {
        switch self {
        case .active: return "Running"
        case .compacting: return "Compacting"
        case .waiting: return "Waiting for an answer"
        case .approval: return "Waiting for approval"
        case .error: return "Failed"
        case .offline: return "Offline"
        case .agentMessage: return "Last message from agent"
        case .humanMessage: return "Last message from you"
        case .idle: return nil
        }
    }
}

struct SessionCardProjection: Equatable {
    let title: String
    let machineName: String?
    let model: String?
    let previewText: String?
    let timestamp: String
    let timeLabel: String
    let status: SessionCardStatus
    let isUnread: Bool
    let isPinned: Bool
    let isDraft: Bool
    let deviceOnline: Bool?

    static func make(
        session: SessionInfo,
        device: DeviceSummary?,
        preview: SessionPreview?,
        draft: String?,
        isCompacting: Bool = false
    ) -> Self {
        let machineName = session.deviceName.isEmpty ? device?.name : session.deviceName
        let normalizedMachineName = machineName?.isEmpty == true ? nil : machineName
        let normalizedDraft = draft?.collapseWhitespace()
        let previewText = normalizedDraft?.isEmpty == false
            ? normalizedDraft
            : preview?.text.collapseWhitespace()
        let timestamp = preview?.timestamp.isEmpty == false
            ? preview?.timestamp ?? ""
            : ISO8601.withFractional.string(from: session.createdAt)
        let hasDraft = normalizedDraft?.isEmpty == false

        return Self(
            title: session.displayTitle,
            machineName: normalizedMachineName,
            model: session.model,
            previewText: previewText?.isEmpty == true ? nil : previewText,
            timestamp: timestamp,
            timeLabel: SessionTimeFormatter.format(timestamp),
            status: .resolve(
                sessionState: isCompacting ? .compacting : session.state,
                previewType: preview?.type,
                deviceOnline: device?.online,
                hasDraft: hasDraft
            ),
            isUnread: session.readSeq < session.lastSeq,
            isPinned: session.pinned,
            isDraft: hasDraft,
            deviceOnline: device?.online
        )
    }
}

/// Shared Compacting glyph. Native variable-color layers provide the visual
/// language; TimelineView periodically renews the view identity so a retained
/// LazyVStack row cannot keep a stale symbol-effect presentation timeline.
struct CompactingStatusGlyph: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let cycleDuration: TimeInterval = 2.4

    var body: some View {
        if reduceMotion {
            symbol
        } else {
            TimelineView(.animation(minimumInterval: 0.18)) { context in
                let cycle = Int(context.date.timeIntervalSinceReferenceDate / cycleDuration)
                symbol
                    .id(cycle)
                    .symbolEffect(
                        .variableColor.iterative.reversing.hideInactiveLayers,
                        options: .repeat(.continuous).speed(0.9),
                        isActive: true
                    )
            }
        }
    }

    private var symbol: some View {
        Image(systemName: "square.stack.3d.down.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Color(hex: 0x0891B2))
            .frame(width: 16, height: 16)
    }
}

#if os(iOS)
/// iOS counterpart of the native macOS status slot. The slot remains fixed so
/// changes between active work, a speaker glyph, and an empty preview do not
/// move the rest of the three-row card.
struct SessionCardStatusGlyph: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let status: SessionCardStatus
    var hasDraft: Bool = false

    var body: some View {
        Group {
            switch status {
            case .active:
                IOSSessionActivityDots(color: .krakiPrimary, reduceMotion: reduceMotion)
            case .compacting:
                CompactingStatusGlyph()
            case .waiting:
                LucideIcon(.messageCircleQuestion, size: 14, strokeWidth: 2.2, color: Color(hex: 0xD97706))
            case .approval:
                LucideIcon(.shieldQuestion, size: 14, strokeWidth: 2.2, color: Color(hex: 0xD97706))
            case .error:
                LucideIcon(.circleSlash, size: 14, strokeWidth: 2.2, color: .red)
            case .offline:
                Image(systemName: "wifi.slash")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
            case .agentMessage:
                LucideIcon(.botMessageSquare, size: 13, strokeWidth: 1.9, color: .krakiPrimary)
            case .humanMessage:
                if hasDraft {
                    LucideIcon(.keyboard,
                               size: 14,
                               strokeWidth: 2,
                               color: Color(hex: 0x4F8C86))
                } else {
                    LucideIcon(.circleUser, size: 13, strokeWidth: 1.9, color: .secondary)
                }
            case .idle:
                Color.clear
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }
}

private struct IOSSessionActivityDots: View {
    let color: Color
    let reduceMotion: Bool

    var body: some View {
        if reduceMotion {
            HStack(spacing: 2.5) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(color.opacity(0.68)).frame(width: 3, height: 3)
                }
            }
            .frame(width: 14, height: 14)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 12.0)) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate
                HStack(spacing: 2.5) {
                    ForEach(0..<3, id: \.self) { index in
                        let wave = 0.5 + 0.5 * sin(phase * 5.2 - Double(index) * 0.85)
                        Circle()
                            .fill(color.opacity(0.35 + 0.65 * wave))
                            .frame(width: 3, height: 3)
                            .scaleEffect(0.72 + 0.28 * wave)
                    }
                }
                .frame(width: 14, height: 14)
            }
        }
    }
}
#endif

/// Mirrors the relay/web session timestamp contract on both Apple clients.
enum SessionTimeFormatter {
    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    static func format(_ iso: String) -> String {
        guard let date = ISO8601.parse(iso) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return timeFormatter.string(from: date) }
        if calendar.isDateInYesterday(date) { return "yesterday" }
        let days = calendar.dateComponents([.day], from: date, to: Date()).day ?? 0
        return "\(max(days, 2))d ago"
    }
}

extension String {
    /// Collapse whitespace for the single-line preview slot.
    func collapseWhitespace() -> String {
        components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
