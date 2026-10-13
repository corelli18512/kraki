import SwiftUI

/// The signed-in user's picture. GitHub accounts use their GitHub avatar
/// (`https://github.com/<login>.png`, as the web app does; the relay doesn't
/// send a picture). Other accounts, or while it loads / if it fails: initials.
struct AccountAvatar: View {
    let user: UserInfo
    let size: CGFloat
    var initials: String

    static func url(for user: UserInfo, size: CGFloat, scale: CGFloat = 3) -> URL? {
        guard user.provider == "github",
              user.login.range(of: #"^[A-Za-z0-9-]{1,39}$"#, options: .regularExpression) != nil else { return nil }
        return URL(string: "https://github.com/\(user.login).png?size=\(Int(size * scale))")
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
