#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin
@testable import Kraki

/// K-178: on an iPhone SE the dictation row's Cancel / Edit buttons and the
/// voice failure note were cut off. Each control is measured in an SE-wide
/// composer against the same control with room to spare.
@MainActor final class IOSVoiceComposerLayoutTests: XCTestCase {
    /// iPhone SE (375 pt): 16 pt margins, the 44 pt send circle and its 8 pt
    /// gap leave 291 pt for the capsule.
    private static let seCapsuleWidth: CGFloat = 291
    private var windows: [UIWindow] = []

    override func setUpWithError() throws {
        try requireForegroundUITests()
        try super.setUpWithError()
        try Self.setApplicationAccessibility(true)
    }

    override func tearDown() {
        try? Self.setApplicationAccessibility(false)
        windows.forEach { $0.isHidden = true; $0.rootViewController = nil }
        windows.removeAll()
        super.tearDown()
    }

    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }

    /// The button labelled `identifier`.
    private func element(_ identifier: String, in window: UIWindow) -> NSObject? {
        var found: NSObject?
        func walk(_ object: NSObject) {
            guard found == nil else { return }
            if object.accessibilityLabel == identifier, object.accessibilityTraits.contains(.button) { found = object; return }
            var kids: [NSObject] = (object as? UIView)?.subviews ?? []
            let count = object.accessibilityElementCount()
            if count != NSNotFound, count > 0 { kids += (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject } }
            kids.forEach(walk)
        }
        walk(window)
        return found
    }

    /// Width of the control `identifier` when `content` is laid out `width` wide.
    private func width<Content: View>(of identifier: String, _ content: Content, width: CGFloat,
                                      size: DynamicTypeSize) throws -> CGFloat {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1_200, height: 400)
        windows.append(window)
        window.rootViewController = UIHostingController(rootView:
            content.frame(width: width).environment(\.dynamicTypeSize, size).environment(\.locale, Locale(identifier: "en")))
        window.makeKeyAndVisible()
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        let control = try XCTUnwrap(element(identifier, in: window), "\(identifier) not found")
        return control.accessibilityFrame.width
    }

    func testRecordingControlsKeepCancelAndEditWholeOnSE() throws {
        let controls = IOSVoiceRecordingControls(levels: [0.2, 0.4], startedAt: Date(), onCancel: {}, onEdit: {})
        for size in [DynamicTypeSize.large, .xLarge, .xxLarge, .xxxLarge] {
            for id in ["Cancel", "Edit"] {
                let roomy = try width(of: id, controls, width: 800, size: size)
                let se = try width(of: id, controls, width: Self.seCapsuleWidth, size: size)
                XCTAssertEqual(se, roomy, accuracy: 0.5, "\(id) is cut off at \(size) on an SE")
            }
        }
    }

    func testVoiceFailureNoteIsNotCutOffOnSE() throws {
        let note = VoiceInputError.microphoneDenied.localizedDescription + " "
            + IOSVoiceComposer.returnedToDraftDetail + " " + IOSVoiceComposer.keptUnsentDetail
        // The composer card leaves 375 - 2 × 16 pt on an SE.
        let row = UIHostingController(rootView: IOSVoiceFailureRow(text: note, onDismiss: {}))
        let height = row.sizeThatFits(in: CGSize(width: 343, height: CGFloat.greatestFiniteMagnitude)).height
        let label = UILabel()
        label.font = .preferredFont(forTextStyle: .caption1)
        label.numberOfLines = 0
        label.text = note
        // Text width: the row minus its 12 pt insets, the Dismiss button and the 8 pt gap.
        let dismiss = UILabel(); dismiss.font = .preferredFont(forTextStyle: .caption1); dismiss.text = "Dismiss"
        let textWidth = 343 - 24 - 8 - dismiss.intrinsicContentSize.width - 2
        let needed = label.sizeThatFits(CGSize(width: textWidth, height: CGFloat.greatestFiniteMagnitude)).height
        XCTAssertGreaterThanOrEqual(height, needed + 14 - 1, "every line of the note is shown")
    }
}
#endif
