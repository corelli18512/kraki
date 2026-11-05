#if os(iOS)
import SwiftUI
import UIKit
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
}
#endif
