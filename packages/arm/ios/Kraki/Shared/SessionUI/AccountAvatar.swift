import SwiftUI

/// The signed-in user's picture. GitHub accounts use their GitHub avatar
/// (the relay doesn't send a picture). Other accounts, or while it loads / if
/// it fails: initials.
///
/// Load from GitHub's avatar CDN by login, not `github.com/<login>.png`: that
/// is only a redirect to the same image, and github.com is often unreachable
/// from mainland China while avatars.githubusercontent.com is not.
struct AccountAvatar: View {
    let user: UserInfo
    let size: CGFloat
    var initials: String

    static func url(for user: UserInfo, size: CGFloat, scale: CGFloat = 3) -> URL? {
        guard user.provider == "github",
              user.login.range(of: #"^[A-Za-z0-9-]{1,39}$"#, options: .regularExpression) != nil else { return nil }
        return URL(string: "https://avatars.githubusercontent.com/\(user.login)?s=\(Int(size * scale))")
    }

    var body: some View {
        AsyncImage(url: Self.url(for: user, size: size)) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(Color.krakiPrimary.opacity(0.15))
            Text(initials)
                .font(.system(size: size * 0.36, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.krakiPrimary)
        }
    }
}
