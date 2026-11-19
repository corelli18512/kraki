import Foundation

/// A message the computer refused without storing it (disk full, device
/// trust) comes back as an `error` naming its clientId. A bare `error` is
/// never a chat row: the bubble shows "Not delivered" (Retry / Delete) and
/// the reason is said in the app's words. The computer's English text is
/// logged only.
extension CommandSender {
    func handleRefusedInput(sessionId: String, payload: [String: Any]?) {
        guard let clientId = payload?["clientId"] as? String,
              failRefusedInput(sessionId: sessionId, clientId: clientId) else { return }
        let code = payload?["code"] as? String
        KLog.d("[Outbox] computer refused input code=\(code ?? "-") message=\(payload?["message"] as? String ?? "")")
        appState?.lastError = RefusedInputText.describe(code: code)
    }
}

/// A create/fork/import device trust refused (`error.payload.code`
/// `trust_rejected_*`), in the app's language; nil for other failures,
/// which keep the computer's text.
enum RefusedRequestText {
    static func describe(code: String?) -> String? {
        guard let code, code.hasPrefix("trust_rejected_") else { return nil }
        switch code {
        case "trust_rejected_clock":
            return String(localized: "Your computer refused this request because this device's clock is ahead of the computer's. Check the date and time on both, then try again.")
        case "trust_rejected_stale":
            return String(localized: "Your computer refused this request: it was signed too long ago, this device's clock is behind, or the computer recently reset its security state. Check the date and time, then try again in a few minutes.")
        case "trust_rejected_unrecorded":
            return String(localized: "Your computer couldn't record this request securely, so it wasn't run. Check that Kraki on the computer can write to its data folder, then try again.")
        default:
            return String(localized: "The computer couldn't complete that. Try again.")
        }
    }
}

/// `error.payload.code` of a refused message, in the app's language.
enum RefusedInputText {
    static func describe(code: String?) -> String {
        switch code {
        case "input_disk_full":
            return String(localized: "Kraki on your computer couldn't save this message because its disk is full. Free some space, then retry.")
        case "trust_rejected_clock":
            return String(localized: "Your computer refused this message because this device's clock is ahead of the computer's. Check the date and time on both, then retry.")
        case "trust_rejected_stale":
            return String(localized: "Your computer refused this message: it was signed too long ago, this device's clock is behind, or the computer recently reset its security state. Check the date and time, then retry in a few minutes.")
        case "trust_rejected_unrecorded":
            return String(localized: "Your computer couldn't record this message securely, so it wasn't run. Check that Kraki on the computer can write to its data folder, then retry.")
        default:
            return String(localized: "Kraki on your computer couldn't take this message. Retry; if it keeps failing, check the computer.")
        }
    }
}
