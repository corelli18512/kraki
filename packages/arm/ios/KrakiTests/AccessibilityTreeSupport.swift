#if os(iOS)
import XCTest
import SwiftUI
import UIKit
import Darwin

/// Hosts a SwiftUI view in a real window with app accessibility turned on (as
/// accessibility snapshot tools do), so tests can read what VoiceOver would
/// see: labels, identifiers, frames and hidden subtrees.
@MainActor
final class AccessibilityTreeHost {
    private(set) var window: UIWindow?

    init() throws {
        try Self.setApplicationAccessibility(true)
    }

    func show<V: View>(_ view: V, size: CGSize = CGSize(width: 393, height: 852)) throws -> UIHostingController<V> {
        self.window?.isHidden = true
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        drain(0.4)
        return host
    }

    func tearDown() {
        window?.isHidden = true
        window?.rootViewController = nil
        window = nil
        try? Self.setApplicationAccessibility(false)
    }

    func drain(_ seconds: Double) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }

    /// Every accessibility element reachable from the window, skipping
    /// subtrees that are hidden from accessibility.
    func elements() -> [NSObject] { nodes().filter(\.isAccessibilityElement) }

    /// Elements and containers (a table, a cell) reachable by accessibility.
    func nodes() -> [NSObject] {
        var out: [NSObject] = []
        var seen = Set<ObjectIdentifier>()
        func walk(_ object: NSObject) {
            guard seen.insert(ObjectIdentifier(object)).inserted else { return }
            if object.accessibilityElementsHidden { return }
            if let view = object as? UIView, view.isHidden || view.alpha == 0 { return }
            out.append(object)
            var kids: [NSObject] = []
            if let explicit = object.accessibilityElements as? [NSObject] {
                kids = explicit
            } else {
                let count = object.accessibilityElementCount()
                if count != NSNotFound, count > 0 {
                    kids = (0..<count).compactMap { object.accessibilityElement(at: $0) as? NSObject }
                }
                if kids.isEmpty { kids = (object as? UIView)?.subviews ?? [] }
            }
            kids.forEach(walk)
        }
        if let window { walk(window) }
        return out
    }

    func nodes(identifier: String) -> [NSObject] {
        nodes().filter { Self.identifier(of: $0) == identifier }
    }

    /// SwiftUI's elements answer `accessibilityIdentifier` without formally
    /// conforming to `UIAccessibilityIdentification`.
    static func identifier(of object: NSObject) -> String? {
        if let identified = object as? UIAccessibilityIdentification { return identified.accessibilityIdentifier }
        let getter = #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier)
        guard object.responds(to: getter) else { return nil }
        return object.perform(getter)?.takeUnretainedValue() as? String
    }

    /// "label|identifier|frame" of every element, for failure messages.
    func describeElements() -> [String] {
        elements().map { "\($0.accessibilityLabel ?? "nil")|\(Self.identifier(of: $0) ?? "")|\(type(of: $0))|\($0.accessibilityFrame.integral)" }
    }

    func elements(label: String) -> [NSObject] {
        elements().filter { $0.accessibilityLabel == label }
    }

    private static func setApplicationAccessibility(_ enabled: Bool) throws {
        let library = try XCTUnwrap(dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW), "libAccessibility")
        let symbol = try XCTUnwrap(dlsym(library, "_AXSApplicationAccessibilitySetEnabled"))
        typealias SetEnabled = @convention(c) (Bool) -> Void
        unsafeBitCast(symbol, to: SetEnabled.self)(enabled)
    }
}
#endif
