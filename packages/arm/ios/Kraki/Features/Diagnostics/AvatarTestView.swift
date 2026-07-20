#if os(iOS) && DEBUG
import SwiftUI

/// Pixel smoke for the two sizes supported by web AgentAvatar.tsx.
/// Launch with KRAKI_AVATAR_TEST=1.
struct AvatarTestView: View {
    private let sessionId = "mrgg6nj1-kkreou2m"

    var body: some View {
        VStack(spacing: 28) {
            Text("Pi avatar · web parity")
                .font(.headline)

            HStack(spacing: 28) {
                avatarColumn("sm · 28 / 16 / r6", size: .sm)
                avatarColumn("md · 36 / 20 / r8", size: .md)
            }

            HStack(spacing: 20) {
                AgentAvatar(agent: "pi", sessionId: sessionId, size: .sm)
                Text("Session header (web sm)")
                Spacer()
            }
            .padding()
            .background(Color.surfaceSecondary)
            .cornerRadius(12)

            HStack(alignment: .top, spacing: 12) {
                AgentAvatar(agent: "pi", sessionId: sessionId, size: .md)
                VStack(alignment: .leading) {
                    Text("chat view").font(.headline)
                    Text("Session card (web default md)").foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding()
            .background(Color.surfaceSecondary)
            .cornerRadius(12)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.surfacePrimary)
    }

    private func avatarColumn(_ label: String, size: AvatarSize) -> some View {
        VStack(spacing: 8) {
            AgentAvatar(agent: "pi", sessionId: sessionId, size: size)
            Text(label).font(.caption2).foregroundStyle(.secondary)
        }
    }
}
#endif
