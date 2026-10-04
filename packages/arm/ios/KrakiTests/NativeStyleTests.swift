import XCTest
import SwiftUI
#if os(macOS)
import AppKit
@testable import Kraki_Dev
#else
import UIKit
@testable import Kraki
#endif

@MainActor final class NativeStyleTests: XCTestCase {
    func testScrollIndicatorWaitsUntilAllMotionAndHoverEnd() {
        var queued: [(TimeInterval, DispatchWorkItem)] = []
        var changes: [(Bool, TimeInterval)] = []
        let state = TransientScrollIndicatorVisibility { queued.append(($0, $1)) }
        state.onVisibilityChanged = { changes.append(($0, $1)) }
        state.setActive(true, for: .scroll)
        state.setActive(true, for: .wheelGlide)
        state.setActive(true, for: .hover)
        state.setActive(false, for: .scroll)
        state.setActive(false, for: .wheelGlide)
        XCTAssertTrue(queued.isEmpty)
        XCTAssertTrue(state.isVisible)
        state.setActive(false, for: .hover)
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued[0].0, 1.2)
        queued[0].1.perform()
        XCTAssertFalse(state.isVisible)
        XCTAssertEqual(changes.count, 2)
        XCTAssertEqual(changes.last?.1, 0.3)
    }

    func testNewGestureCancelsOldHideAndRevealsDuringFade() {
        var queued: [DispatchWorkItem] = []
        var changes: [Bool] = []
        let state = TransientScrollIndicatorVisibility { _, work in queued.append(work) }
        state.onVisibilityChanged = { visible, _ in changes.append(visible) }
        state.pulse()
        let stale = queued[0]
        state.setActive(true, for: .knob)
        stale.perform()
        XCTAssertTrue(state.isVisible)
        state.setActive(false, for: .knob)
        queued.last!.perform()
        XCTAssertFalse(state.isVisible)
        state.setActive(true, for: .scroll)
        XCTAssertEqual(changes, [true, false, true])
        state.reset()
        XCTAssertFalse(state.isVisible)
        XCTAssertTrue(state.activities.isEmpty)
        queued.forEach { $0.perform() }
        XCTAssertFalse(state.isVisible)
    }

    func testProgrammaticGeometryDoesNotRevealAndShortContentHasNoThumb() {
        let state = TransientScrollIndicatorVisibility()
        let track = CGRect(x: 95, y: 20, width: 3, height: 360)
        XCTAssertNil(TransientScrollIndicatorGeometry.thumb(track: track, viewport: 400, content: 400, offset: 0))
        let top = TransientScrollIndicatorGeometry.thumb(track: track, viewport: 400, content: 1600, offset: -70)!
        XCTAssertEqual(top.minY, 20)
        XCTAssertEqual(top.height, 90)
        let bottom = TransientScrollIndicatorGeometry.thumb(track: track, viewport: 400, content: 1600, offset: 1700)!
        XCTAssertEqual(bottom.maxY, track.maxY)
        XCTAssertEqual(bottom.width, 3)
        XCTAssertFalse(state.isVisible)
        XCTAssertNil(TransientScrollIndicatorGeometry.thumb(track: track, viewport: 0, content: 900, offset: 0))
        XCTAssertNil(TransientScrollIndicatorGeometry.thumb(track: track, viewport: 400, content: .infinity, offset: 0))
    }

    func testMetadataProtectsDeviceAndEffortBeforeWrapping() {
        XCTAssertFalse(SessionMetadataLayout.needsSecondRow(width: 220, device: 60, model: 600, effort: 32))
        XCTAssertTrue(SessionMetadataLayout.needsSecondRow(width: 140, device: 90, model: 600, effort: 32))
        XCTAssertFalse(SessionMetadataLayout.needsSecondRow(width: 140, device: 0, model: 600, effort: 32))
    }

    func testMetadataNativeSizingKeepsLongModelOnOneRowAndWrapsLongDevice() throws {
        func size(device: String?, model: String?, width: CGFloat, type: DynamicTypeSize = .large) throws -> CGSize {
            let content = SessionCardMetadataRow(machineName: device, model: model, effort: model == nil ? nil : "xhigh",
                sessionId: "test", font: .caption, deviceColor: .primary, modelColor: .secondary)
                .frame(width: width).fixedSize(horizontal: false, vertical: true)
                .environment(\.dynamicTypeSize, type)
            let renderer = ImageRenderer(content: content)
            let image = try XCTUnwrap(renderer.cgImage)
            return CGSize(width: image.width, height: image.height)
        }
        let short = try size(device: "My Mac", model: "gpt-5", width: 230)
        let long = try size(device: "My Mac", model: "provider/very-long-prefix/vendor/account/gpt-5.6-sol", width: 230)
        XCTAssertEqual(short, long, "model truncates from head instead of forcing every long model onto two rows")
        let wrapped = try size(device: "My very long named workstation that must remain completely readable", model: "provider/gpt-5", width: 150)
        XCTAssertEqual(wrapped.width, 150)
        XCTAssertGreaterThan(wrapped.height, short.height * 2)
        XCTAssertLessThan(try size(device: nil, model: "provider/gpt-5", width: 150).height, wrapped.height)
        XCTAssertGreaterThan(try size(device: "My very long named workstation", model: "provider/gpt-5", width: 150, type: .accessibility3).height, short.height)
    }

    #if os(iOS)
    func testIOSIndicatorTracksInsetsWithoutInterceptingTouches() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 320, height: 640)
        let vc = UIViewController(); window.rootViewController = vc; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil }
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: 320, height: 600))
        scroll.contentInsetAdjustmentBehavior = .never
        scroll.contentInset = UIEdgeInsets(top: 80, left: 0, bottom: 120, right: 0)
        scroll.verticalScrollIndicatorInsets = UIEdgeInsets(top: 80, left: 0, bottom: 120, right: 0)
        scroll.contentSize = CGSize(width: 320, height: 2000)
        vc.view.addSubview(scroll)
        let indicator = IOSTransientScrollIndicator(); indicator.attach(to: scroll)
        indicator.beginScrolling()
        XCTAssertFalse(indicator.debugThumb.isUserInteractionEnabled)
        XCTAssertFalse(scroll.showsVerticalScrollIndicator)
        XCTAssertFalse(indicator.debugThumb.isHidden)
        XCTAssertGreaterThanOrEqual(indicator.debugThumb.frame.minY, 80)
        scroll.contentOffset.y = 1600
        indicator.updateGeometry()
        XCTAssertLessThanOrEqual(indicator.debugThumb.frame.maxY, 480)
        indicator.endDragging(willDecelerate: true)
        XCTAssertTrue(indicator.visibility.activities.contains(.scroll))
        indicator.endScrolling()
        XCTAssertTrue(indicator.visibility.isVisible)
        indicator.hide()
        XCTAssertEqual(indicator.debugThumb.alpha, 0)
        scroll.contentSize.height = 100
        indicator.updateGeometry()
        XCTAssertTrue(indicator.debugThumb.isHidden)
    }
    #else
    func testMacNativeScrollerRetainsTrackingAndDoesNotReserveGutter() {
        let scroll = NSScrollView(frame: CGRect(x: 0, y: 0, width: 280, height: 400))
        scroll.documentView = NSView(frame: CGRect(x: 0, y: 0, width: 280, height: 1600))
        scroll.hasVerticalScroller = true
        let controller = MacTransientOverlayScrollerController(); controller.attach(to: scroll)
        scroll.tile()
        XCTAssertTrue(scroll.verticalScroller is MacTransientScroller)
        XCTAssertEqual(scroll.scrollerStyle, .overlay)
        XCTAssertEqual(scroll.contentView.bounds.width, 280, accuracy: 0.5)
        let scroller = scroll.verticalScroller as! MacTransientScroller
        XCTAssertFalse(scroller.wantsUpdateLayer, "native overlay updateLayer bypasses the custom knob drawing")
        scroller.layer?.displayIfNeeded()
        scroller.doubleValue = 0.5
        XCTAssertTrue(scroller.layer?.needsDisplay() == true, "scrolling must repaint the custom backing contents")
        scroller.layer?.displayIfNeeded()
        scroller.knobProportion = 0.2
        XCTAssertTrue(scroller.layer?.needsDisplay() == true, "content growth must resize the custom backing contents")
        controller.setWheelGlideActive(true)
        XCTAssertEqual(scroller.alphaValue, 1)
        scroller.onTrackingChanged?(true)
        controller.setWheelGlideActive(false)
        XCTAssertTrue(controller.visibility.activities.contains(.knob))
        scroller.onTrackingChanged?(false)
        XCTAssertTrue(controller.visibility.isVisible)
        controller.hideImmediately()
        XCTAssertEqual(scroller.alphaValue, 0)
    }
    #endif
}
