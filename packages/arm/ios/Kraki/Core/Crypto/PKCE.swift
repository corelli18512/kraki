/// PKCE (RFC 7636) helpers for OAuth Authorization Code Flow.
///
/// The iOS app uses PKCE on every GitHub OAuth attempt so the relay's
/// `client_secret` is not the only thing protecting against code
/// interception. Mobile clients can't safely embed a secret, so PKCE
/// is the only thing that binds an authorization code to the device
/// that started the flow.

import Foundation
import CryptoKit

enum PKCE {
    /// Random URL-safe high-entropy code verifier (RFC 7636 §4.1).
    /// 32 random bytes → 43 base64url characters, well within the
    /// 43–128 char range GitHub accepts.
    static func generateCodeVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // SecRandom failure is essentially impossible on iOS, but
            // fall back to a CryptoKit SymmetricKey rather than crash.
            let key = SymmetricKey(size: .bits256)
            return key.withUnsafeBytes { Self.base64URLEncode(Data($0)) }
        }
        return Self.base64URLEncode(Data(bytes))
    }

    /// SHA-256 the verifier, base64url-encode the digest. Sent as
    /// `code_challenge` in the authorize URL with method `S256`.
    static func deriveChallenge(verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return Self.base64URLEncode(Data(digest))
    }

    /// Standard base64url encoding (no padding, `+` → `-`, `/` → `_`).
    static func base64URLEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
