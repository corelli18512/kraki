#if os(iOS)
import SwiftUI
import UIKit
import CryptoKit
import XCTest
@testable import Kraki

/// K-079: a pairing link opened while a sheet (New Session, the scanner) is
/// open shows its prompt over the sheet instead of dismissing it.
@MainActor
final class PairingPromptAlertsTests: XCTestCase {
    private struct SheetHost: View {
        @State var showsSheet = true
        var body: some View {
            Color.clear
                .sheet(isPresented: $showsSheet) { Text(verbatim: "New Session") }
                .modifier(PairingPromptAlerts())
        }
    }

    @Observable
    final class CoverModel {
        var showsCover = true
    }

    /// The login screen's scanner: a full-screen cover that dismisses
    /// itself in the same pass that sets the prompt.
    private struct CoverHost: View {
        @Bindable var model: CoverModel
        var body: some View {
            Color.clear
                .fullScreenCover(isPresented: $model.showsCover) { Text(verbatim: "Scanner") }
                .modifier(PairingPromptAlerts())
        }
    }

    private func host<V: View>(_ view: V, app: AppState) throws -> (UIWindow, UIHostingController<AnyView>) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        let host = UIHostingController(rootView: AnyView(view.environment(app)))
        window.rootViewController = host
        window.makeKeyAndVisible()
        TopmostAlertPresenter.shared.window = window
        return (window, host)
    }

    private func tearDownHost(_ window: UIWindow, _ host: UIViewController) {
        TopmostAlertPresenter.shared.show(id: nil) { UIAlertController() }
        TopmostAlertPresenter.shared.window = nil
        host.dismiss(animated: false)
        window.isHidden = true
        window.rootViewController = nil
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    }

    private func spin(until condition: () -> Bool, seconds: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
    }

    func testPairingPromptShowsOverAnOpenSheetAndKeepsIt() throws {
        let app = AppState.makeUnitTestHost()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.windowLevel = .alert + 1
        let host = UIHostingController(rootView: SheetHost().environment(app))
        window.rootViewController = host
        window.makeKeyAndVisible()
        TopmostAlertPresenter.shared.window = window
        defer {
            TopmostAlertPresenter.shared.show(id: nil) { UIAlertController() }
            TopmostAlertPresenter.shared.window = nil
            host.dismiss(animated: false)
            window.isHidden = true
            window.rootViewController = nil
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        }

        spin { host.presentedViewController != nil && host.presentedViewController?.isBeingPresented == false }
        let sheet = try XCTUnwrap(host.presentedViewController, "the sheet is open")

        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?token=pt_other"))
        app.pendingPairingPrompt = .alreadyConnected(link, login: "octo")
        spin { sheet.presentedViewController is UIAlertController }

        XCTAssertIdentical(host.presentedViewController, sheet, "the sheet stays open")
        let alert = try XCTUnwrap(sheet.presentedViewController as? UIAlertController, "the prompt shows over the sheet")
        XCTAssertEqual(alert.title, String(localized: "Already Connected"))
        XCTAssertEqual(alert.actions.map(\.title), [String(localized: "Log Out and Connect"), String(localized: "Keep Current")])

        // Answered elsewhere (or Keep Current): only the alert goes away.
        app.pendingPairingPrompt = nil
        spin { sheet.presentedViewController == nil }
        XCTAssertNil(sheet.presentedViewController)
        XCTAssertIdentical(host.presentedViewController, sheet)
    }

    /// Review G6: a self-hosted-relay QR scanned on the login screen sets the
    /// prompt while the scanner cover closes; the prompt still shows.
    func testPromptShowsWhenTheScannerCoverClosesInTheSamePass() throws {
        let app = AppState.makeUnitTestHost()
        let model = CoverModel()
        let (window, host) = try host(CoverHost(model: model), app: app)
        defer { tearDownHost(window, host) }

        spin { host.presentedViewController != nil && host.presentedViewController?.isBeingPresented == false }
        XCTAssertNotNil(host.presentedViewController, "the scanner is open")

        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss://self.example&token=pt_self"))
        app.openPairingLink(link)
        model.showsCover = false
        spin { host.presentedViewController is UIAlertController }

        let alert = try XCTUnwrap(host.presentedViewController as? UIAlertController, "the prompt shows once the scanner is gone")
        XCTAssertEqual(alert.title, String(localized: "Connect to a Self-Hosted Server?"))
    }

    /// A prompt already showing over the scanner leaves with it unanswered;
    /// it is shown again on the screen underneath.
    func testPromptShownOnTheScannerComesBackWhenTheScannerCloses() throws {
        let app = AppState.makeUnitTestHost()
        let model = CoverModel()
        let (window, host) = try host(CoverHost(model: model), app: app)
        defer { tearDownHost(window, host) }

        spin { host.presentedViewController != nil && host.presentedViewController?.isBeingPresented == false }
        let cover = try XCTUnwrap(host.presentedViewController, "the scanner is open")
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss://self.example&token=pt_self"))
        app.openPairingLink(link)
        spin { cover.presentedViewController is UIAlertController && cover.presentedViewController?.isBeingPresented == false }
        XCTAssertTrue(cover.presentedViewController is UIAlertController, "first over the scanner")

        model.showsCover = false
        spin { host.presentedViewController is UIAlertController }
        let alert = try XCTUnwrap(host.presentedViewController as? UIAlertController, "shown again once the scanner is gone")
        XCTAssertEqual(alert.title, String(localized: "Connect to a Self-Hosted Server?"))
        XCTAssertNotNil(app.pendingPairingPrompt, "still unanswered")
    }

    /// Review G1: confirming the relay for a computer this account knows
    /// pairs with it and clears the prompt, so later prompts and key
    /// warnings are not hidden behind a stale one.
    func testConfirmingTheRelayForAKnownComputerClearsThePrompt() throws {
        let suite = "PairingPromptAlerts.\(UUID().uuidString)"
        TentacleTrustStore.shared.useDefaults(try XCTUnwrap(UserDefaults(suiteName: suite)))
        defer {
            TentacleTrustStore.shared.reset()
            DeviceTrustModel.shared.reset()
            UserDefaults().removePersistentDomain(forName: suite)
        }
        let app = AppState.makeUnitTestHost()
        app.hasStoredCredentials = true
        app.deviceStore.setDevices([DeviceSummary(id: "pc", name: "PC", role: .tentacle, kind: nil, publicKey: nil, encryptionKey: nil, online: false, lastSeen: nil, createdAt: nil)])
        let ik = DeviceTrustWire.b64url(Curve25519.Signing.PrivateKey().publicKey.rawRepresentation)
        let xk = DeviceTrustWire.b64url(Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        let link = try XCTUnwrap(PairingLink(string: "https://app.kraki.chat/?relay=wss://self.example&token=pt_self&tid=pc&ik=\(ik)&xk=\(xk)&ps=5JHuX0U7LWjbxz0KSFNFmA"))
        XCTAssertNotNil(link.trust)

        app.openPairingLink(link)
        let prompt = try XCTUnwrap(app.pendingPairingPrompt)
        XCTAssertEqual(prompt, .confirmRelay(link))

        PairingPromptAlerts.confirm(prompt, app: app)
        XCTAssertNil(app.pendingPairingPrompt)
        XCTAssertEqual(TentacleTrustStore.shared.pin("pc")?.identityKey, ik, "paired with the known computer")
    }
}
#endif
