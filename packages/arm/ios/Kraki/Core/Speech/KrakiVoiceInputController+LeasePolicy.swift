import Foundation

extension KrakiVoiceInputController {
    /// A lease is a device credential, not a usage allowance: Head grants the
    /// audio budget incrementally on the broker connection, charged to the
    /// UTC day the audio is used. Only its signed validity window matters.
    static func isLeaseUsable(_ lease: VoiceLease, nowUnixSec: Int) -> Bool {
        lease.payload.exp > nowUnixSec + 5 && lease.payload.iat <= nowUnixSec + 30
    }

    /// The broker or Head refused this particular lease (expired, revoked,
    /// unknown after a Head reset, or signed by a rotated key). Retrying the
    /// same lease can never succeed; a newly issued one can.
    static func isLeaseRejection(_ reason: String) -> Bool {
        [
            "lease_expired", "lease_revoked", "not_found", "bad_signature",
            "malformed_lease", "not_yet_valid", "authorization_expired",
            "wrong_user", "wrong_device",
        ].contains { reason.localizedCaseInsensitiveContains($0) }
    }
}
