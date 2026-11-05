#if os(iOS)
/// App-wide alerts for pairing links and computer-key warnings.
///
/// A SwiftUI `.alert` on the root view dismisses whatever sheet is open (New
/// Session, the QR scanner) to present itself (K-079). These alerts arrive at
/// any time — a link opened from the Camera, a key change reported by the
/// relay — so they are presented with UIKit over the top-most view controller
/// instead, and the open sheet stays where it was.

import SwiftUI
import UIKit

/// Presents one `UIAlertController` at a time over the top-most presented
/// view controller of the key window.
@MainActor
final class TopmostAlertPresenter {
    static let shared = TopmostAlertPresenter()

    private weak var alert: UIAlertController?
    private(set) var shownID: String?
    private var wanted: (id: String, make: () -> UIAlertController)?
    private var retryScheduled = false
    /// Counts presentations, so a carrier watch stops once its alert is replaced.
    private var presentation = 0
    /// Tests: the window to present in (default: the app's key window).
    weak var window: UIWindow?

    /// Shows the alert identified by `id` (built by `make`), replacing a
    /// different one; `id == nil` dismisses the current one.
    func show(id: String?, make: @escaping () -> UIAlertController) {
        wanted = id.map { ($0, make) }
        apply()
    }

    private func apply() {
        let isShown = alert.map { $0.presentingViewController != nil && !$0.isBeingDismissed } ?? false
        if isShown, wanted?.id == shownID { return }
        if isShown { alert?.dismiss(animated: true) }
        if !isShown || wanted == nil {
            alert = nil
            shownID = nil
        }
        guard let wanted else { return }
        // Another presentation (or our previous alert) is still animating:
        // try again once it settled.
        guard let top = topViewController(), top.presentedViewController == nil,
              top.transitionCoordinator == nil, !isShown else {
            scheduleRetry()
            return
        }
        let next = wanted.make()
        top.present(next, animated: true)
        alert = next
        shownID = wanted.id
        presentation += 1
        if top.presentingViewController != nil {
            watchCarrier(top, of: next, presentation: presentation)
        }
    }

    /// An alert shown over a sheet or cover leaves with it, unanswered — the
    /// login scanner closes in the same pass that opens a prompt for its code.
    /// Then the alert is shown again on what is underneath.
    private func watchCarrier(_ carrier: UIViewController, of shown: UIAlertController, presentation: Int) {
        weak var carrier = carrier
        weak var shown = shown
        func check() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                guard let self, self.presentation == presentation else { return }
                guard shown?.presentingViewController == nil else { return check() }
                // Gone while its carrier stayed: answered, or dismissed by `show`.
                guard carrier.map({ $0.presentingViewController == nil || $0.isBeingDismissed }) ?? true else { return }
                self.alert = nil
                self.shownID = nil
                self.apply()
            }
        }
        check()
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.retryScheduled = false
            self?.apply()
        }
    }

    /// The controller to present on: the deepest presented one that is not
    /// on its way out (a sheet, a full-screen cover, or the root).
    func topViewController() -> UIViewController? {
        let window = window ?? UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
        var top = window?.rootViewController
        while let next = top?.presentedViewController, !next.isBeingDismissed {
            top = next
        }
        return top
    }
}

/// The pairing-link prompts (`AppState.pendingPairingPrompt`) and the
/// computer-key warning (`AppState.keyWarning`), shown over any open sheet.
struct PairingPromptAlerts: ViewModifier {
    @Environment(AppState.self) private var appState

    /// What should be on screen: a pairing prompt first, then a key warning.
    private var alertID: String? {
        if let prompt = appState.pendingPairingPrompt { return prompt.id }
        if let warning = appState.keyWarning { return "key:" + warning.ids.sorted().joined(separator: ",") }
        return nil
    }

    func body(content: Content) -> some View {
        content.onChange(of: alertID, initial: true) { _, id in
            // Let a sheet or cover that is appearing finish first.
            DispatchQueue.main.async {
                TopmostAlertPresenter.shared.show(id: id) { makeAlert() }
            }
        }
    }

    private func makeAlert() -> UIAlertController {
        guard let prompt = appState.pendingPairingPrompt else { return keyWarningAlert() }
        let alert = UIAlertController(
            title: Self.title(for: prompt),
            message: Self.message(for: prompt, logoutLoss: appState.logoutLossNotice),
            preferredStyle: .alert
        )
        let app = appState
        let (confirmTitle, confirmStyle, cancelTitle): (String, UIAlertAction.Style, String) = switch prompt {
        case .confirmRelay: (String(localized: "Connect"), .default, String(localized: "Cancel"))
        case .alreadyConnected: (String(localized: "Log Out and Connect"), .destructive, String(localized: "Keep Current"))
        case .replaceComputerKey: (String(localized: "Pair Anyway"), .destructive, String(localized: "Cancel"))
        }
        alert.addAction(UIAlertAction(title: confirmTitle, style: confirmStyle) { _ in Self.confirm(prompt, app: app) })
        alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel) { _ in app.pendingPairingPrompt = nil })
        return alert
    }

    /// The prompt's confirming answer. The prompt is cleared first: pairing
    /// with a known computer does not clear it, and a prompt left behind would
    /// hide every later prompt and key warning.
    @MainActor
    static func confirm(_ prompt: PairingLinkPrompt, app: AppState) {
        app.pendingPairingPrompt = nil
        switch prompt {
        case .confirmRelay(let link):
            app.openPairingLink(link, relayConfirmed: true)
        case .alreadyConnected(let link, _):
            app.logoutAndPair(link)
        case .replaceComputerKey(let link, _):
            app.openPairingLink(link, relayConfirmed: true, keyChangeConfirmed: true)
        }
    }

    private func keyWarningAlert() -> UIAlertController {
        let warning = appState.keyWarning
        let alert = UIAlertController(title: String(localized: "Computer Key Changed"), message: warning?.message, preferredStyle: .alert)
        let app = appState
        alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .cancel) { _ in
            if let ids = warning?.ids { app.acknowledgedKeyWarnings.formUnion(ids) }
        })
        return alert
    }

    static func title(for prompt: PairingLinkPrompt) -> String {
        switch prompt {
        case .confirmRelay: return String(localized: "Connect to a Self-Hosted Server?")
        case .alreadyConnected: return String(localized: "Already Connected")
        case .replaceComputerKey(_, let name): return String(localized: "New Key for \(name)?")
        }
    }

    /// `logoutLoss`: what "Log Out and Connect" would discard
    /// (`AppState.logoutLossNotice`).
    static func message(for prompt: PairingLinkPrompt, logoutLoss: [String] = []) -> String {
        switch prompt {
        case .confirmRelay(let link):
            return String(localized: "This code connects to \(link.relayHost), which is not a Kraki server. Continue only if you set up this server yourself.")
        case .alreadyConnected(_, let login):
            let connected = login.map { String(localized: "This iPhone is already connected as \($0). To connect a different account, log out first.") }
                ?? String(localized: "This iPhone is already connected. To connect a different account, log out first.")
            return ([connected] + logoutLoss).joined(separator: "\n\n")
        case .replaceComputerKey(_, let name):
            return String(localized: "This code has a different key than the one you paired with \(name). Continue only if you reinstalled Kraki there — otherwise someone may be trying to intercept your sessions.")
        }
    }
}
#endif
