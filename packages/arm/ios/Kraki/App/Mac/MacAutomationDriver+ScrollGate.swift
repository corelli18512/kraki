/// The scroll production gate: a scripted scrolling scenario checked frame by frame.

#if os(macOS) && DEBUG
import AppKit
import Darwin
import Foundation
import CryptoKit
import SwiftUI
import WebKit

extension MacAutomationDriver {
    func scrollProductionGate(id: Any?, connection: Int32) {
        guard let appState,
              let chat = findChatScrollView() else {
            send(error: "invalid_state", message: "No mounted MacChatScrollView is available", id: id, on: connection)
            return
        }

        Task { @MainActor [weak self, weak chat] in
            guard let self, let chat else { return }

            func pause(_ milliseconds: Int) async {
                try? await Task.sleep(for: .milliseconds(milliseconds))
            }

            func number(_ state: [String: Any], _ key: String) -> CGFloat {
                CGFloat(state[key] as? Double ?? 0)
            }

            func bool(_ state: [String: Any], _ key: String) -> Bool {
                state[key] as? Bool ?? false
            }

            @MainActor
            func layout() -> [String: Any] {
                var result = chat.chatDocumentView.layoutDiagnostics(
                    viewport: chat.contentView.bounds
                )
                result["scrollAlpha"] = Double(chat.alphaValue)
                result["distanceToBottom"] = Double(chat.distanceToBottom)
                result["representedSessionId"] = chat.representedSessionId ?? NSNull()
                result["entryBottomLocked"] = chat.isEntryBottomLocked
                for (key, value) in chat.edgePagingDiagnostics {
                    result[key] = value
                }
                return result
            }

            @MainActor
            func event(
                units: CGScrollEventUnit,
                y: Int32,
                x: Int32 = 0
            ) -> NSEvent? {
                guard let cgEvent = CGEvent(
                    scrollWheelEvent2Source: nil,
                    units: units,
                    wheelCount: 1,
                    wheel1: y,
                    wheel2: x,
                    wheel3: 0
                ) else { return nil }
                return NSEvent(cgEvent: cgEvent)
            }

            @MainActor
            func boundsPass(
                _ scroll: MacChatScrollView,
                _ samples: [CGFloat]
            ) -> Bool {
                let minimumY = -scroll.contentInsets.top
                let maximumY = max(
                    minimumY,
                    scroll.chatDocumentView.frame.height
                        - scroll.contentView.bounds.height
                        + scroll.contentInsets.bottom
                )
                return samples.allSatisfy {
                    $0 >= minimumY - 1.0 && $0 <= maximumY + 1.0
                }
            }

            @MainActor
            func runLoop(_ seconds: TimeInterval) {
                RunLoop.current.run(until: Date().addingTimeInterval(seconds))
            }

            @MainActor
            func monotonic(_ samples: [CGFloat], direction: CGFloat) -> Bool {
                zip(samples, samples.dropFirst()).allSatisfy { previous, next in
                    direction < 0
                        ? next <= previous + 3.0
                        : next >= previous - 3.0
                }
            }

            @MainActor
            func screenY(
                for seq: Int,
                in state: [String: Any]
            ) -> CGFloat? {
                guard let frames = state["cellFrames"] as? [[String: Any]] else { return nil }
                guard let frame = frames.first(where: { ($0["seq"] as? Int) == seq }) else {
                    return nil
                }
                guard let value = frame["screenY"] as? Double else { return nil }
                return CGFloat(value)
            }

            @MainActor
            func sessionWindow() -> (id: String, top: Int, bottom: Int)? {
                let sessionId = chat.representedSessionId
                    ?? self.selectedSessionId
                    ?? appState.sessionStore.activeSessionId
                guard let sessionId else { return nil }
                if let state = appState.messageStore.windowState(sessionId) {
                    return (sessionId, state.topSeq, state.bottomSeq)
                }
                // Scenario Test Page owns a deliberately separate temporary
                // AppState. Read the mounted production list's already-sanitized
                // range diagnostics instead of reaching into that fixture.
                if let range = chat.automationWindowRange {
                    return (sessionId, range.top, range.bottom)
                }
                return nil
            }

            @MainActor
            func waitForOlderToSettle(timeoutMs: Int = 2_000) async -> Bool {
                let attempts = max(1, timeoutMs / 25)
                for _ in 0..<attempts {
                    let loading = chat.edgePagingDiagnostics["loadingOlder"] as? Bool ?? false
                    let active = chat.edgePagingDiagnostics["liveScrollActive"] as? Bool ?? false
                    let discrete = chat.edgePagingDiagnostics["discreteWheelActive"] as? Bool ?? false
                    let settle = chat.edgePagingDiagnostics["scrollSettlePending"] as? Bool ?? false
                    if !loading && !active && !discrete && !settle { return true }
                    await pause(25)
                }
                return false
            }

            var tests: [[String: Any]] = []
            for _ in 0..<60 {
                let settledEntry = chat.chatDocumentView.initialViewportIsReady(chat.contentView.bounds)
                    && sessionWindow() != nil
                    && chat.contentView.bounds.height < 800
                if settledEntry { break }
                await pause(100)
            }

            // 1. Session entry: the first visible frame must already be the
            // authoritative tail, not an exposed estimated/top intermediate.
            let entry = layout()
            let entryPassed = chat.alphaValue >= 0.99
                && chat.distanceToBottom <= 24
                && chat.chatDocumentView.initialViewportIsReady(chat.contentView.bounds)
                && (entry["intersectingPlaceholderCount"] as? Int ?? 0) == 0
                && (entry["documentHeight"] as? Double ?? 0) >= (entry["viewportHeight"] as? Double ?? 0)
            tests.append([
                "name": "session-entry-invariant",
                "passed": entryPassed,
                "alpha": Double(chat.alphaValue),
                "distanceToBottom": Double(chat.distanceToBottom),
                "entryBottomLocked": chat.isEntryBottomLocked,
                "intersectingPlaceholderCount": entry["intersectingPlaceholderCount"] ?? 0,
                "initialViewportReady": chat.chatDocumentView.initialViewportIsReady(chat.contentView.bounds),
            ])

            // 1b. The first upward movement from a compact tail is the
            // reported production regression: older prepend must not infer
            // that the user is still bottom-following merely because the
            // compact document was within the 24pt tolerance.
            let entryBeforeY = chat.contentView.bounds.minY
            let entryBeforeRange = chat.chatDocumentView.frame.height
                - chat.contentView.bounds.height
            let entryBeforeItemCount = entry["itemCount"] as? Int ?? 0
            let entryBeforeDocumentHeight = entry["documentHeight"] as? Double ?? 0
            let entryAnchorSeq = entry["stableAnchorSeq"] as? Int
                ?? entry["anchorSeq"] as? Int
            let entryAnchorBeforeY = entryAnchorSeq.flatMap {
                screenY(for: $0, in: entry)
            }
            _ = chat.automationScroll(direction: "up", ticks: 1)
            await pause(1_000)
            let entryAfterY = chat.contentView.bounds.minY
            let entryAfter = layout()
            let entryAfterItemCount = entryAfter["itemCount"] as? Int ?? 0
            let entryAfterDocumentHeight = entryAfter["documentHeight"] as? Double ?? 0
            let entryAnchorAfterY = entryAnchorSeq.flatMap {
                screenY(for: $0, in: entryAfter)
            }
            let entryAnchorDrift = entryAnchorBeforeY.flatMap { before in
                entryAnchorAfterY.map { $0 - before }
            }
            let entryUpPassed = entryBeforeRange <= 24
                && entryAfterItemCount > entryBeforeItemCount
                && entryAfterDocumentHeight > entryBeforeDocumentHeight
                && entryAfterY < entryAfterDocumentHeight
                && !chat.followingBottom
                && entryAnchorDrift.map { abs($0) <= 16 } == true
            tests.append([
                "name": "entry-upward-pagination-preserves-history-position",
                "passed": entryUpPassed,
                "beforeY": Double(entryBeforeY),
                "afterY": Double(entryAfterY),
                "beforeScrollableRange": Double(entryBeforeRange),
                "beforeItemCount": entryBeforeItemCount,
                "afterItemCount": entryAfterItemCount,
                "beforeDocumentHeight": entryBeforeDocumentHeight,
                "afterDocumentHeight": entryAfterDocumentHeight,
                "anchorSeq": entryAnchorSeq ?? NSNull(),
                "anchorBeforeY": entryAnchorBeforeY.map(Double.init) ?? NSNull(),
                "anchorAfterY": entryAnchorAfterY.map(Double.init) ?? NSNull(),
                "anchorDrift": entryAnchorDrift.map(Double.init) ?? NSNull(),
                "distanceToBottom": Double(chat.distanceToBottom),
                "followingBottom": chat.followingBottom,
            ])

            // Build enough local history for motion tests to have a real
            // scroll range, then temporarily disable edge callbacks so these
            // tests measure motion itself rather than prepend compensation.
            let savedOlderHandler = chat.onScrolledNearTop
            let savedNewerHandler = chat.onScrolledNearBottom
            if let savedOlderHandler {
                for _ in 0..<4 {
                    savedOlderHandler()
                    await pause(250)
                }
                await pause(250)
            }
            chat.onScrolledNearTop = nil
            chat.onScrolledNearBottom = nil

            // 2. Discrete wheel: use a real offscreen AppKit window so the
            // animator is driven by a run loop even when the main Debug app
            // intentionally uses activationPolicy=prohibited.
            let motionScroll = NSScrollView(
                frame: NSRect(x: 0, y: 0, width: 420, height: 260)
            )
            motionScroll.documentView = NSView(
                frame: NSRect(x: 0, y: 0, width: 420, height: 4_000)
            )
            motionScroll.hasVerticalScroller = true
            motionScroll.contentView.bounds.origin.y = 1_000
            let motionController = MacSmoothWheelController()
            var targetSamples: [CGFloat] = []
            var discreteActive = false
            motionController.onTargetChanged = { target in
                targetSamples.append(target)
            }
            motionController.onActivityChanged = { active in
                discreteActive = active
            }
            let discreteBefore = motionScroll.contentView.bounds.minY
            let discreteEvent = event(units: .line, y: 3)
            let handled = discreteEvent.map {
                motionController.handle($0, in: motionScroll)
            } ?? false
            let discreteImmediateActive = discreteActive
            await pause(250)
            let discreteMotionTargets = targetSamples.filter {
                $0 < discreteBefore - 0.01
            }
            let discreteAfter = discreteMotionTargets.last ?? discreteBefore
            let discreteSettledActive = discreteActive
            let discreteMinimumY = -motionScroll.contentInsets.top
            let discreteMaximumY = max(
                discreteMinimumY,
                (motionScroll.documentView?.frame.height ?? 0)
                    - motionScroll.contentView.bounds.height
                    + motionScroll.contentInsets.bottom
            )
            let discretePassed = handled
                && discreteEvent?.hasPreciseScrollingDeltas == false
                && discreteAfter < discreteBefore - 12
                && targetSamples.allSatisfy {
                    $0 >= discreteMinimumY - 1 && $0 <= discreteMaximumY + 1
                }
                && discreteImmediateActive
                && !discreteSettledActive
            tests.append([
                "name": "discrete-wheel-controller-motion-and-settle",
                "passed": discretePassed,
                "beforeY": Double(discreteBefore),
                "targetY": Double(discreteAfter),
                "sampleCount": discreteMotionTargets.count,
                "targetSamples": targetSamples.map(Double.init),
                "eventPrecise": discreteEvent?.hasPreciseScrollingDeltas ?? NSNull(),
                "handled": handled,
                "immediateActive": discreteImmediateActive,
                "settledActive": discreteSettledActive,
            ])

            // 3. Precise momentum: pixel events must use the native path, move
            // monotonically, and recover even when didEndLiveScroll is absent.
            let maximumY = max(
                -chat.contentInsets.top,
                chat.chatDocumentView.frame.height - chat.contentView.bounds.height
            )
            let middleY = max(-chat.contentInsets.top, maximumY * 0.52)
            chat.contentView.bounds.origin.y = middleY
            chat.reflectScrolledClipView(chat.contentView)
            let preciseEvent = event(units: .pixel, y: 16)
            var preciseSamples = [chat.contentView.bounds.minY]
            var preciseWasActive = false
            if let preciseEvent {
                preciseWasActive = !preciseEvent.hasPreciseScrollingDeltas
                    ? false
                    : true
                for _ in 0..<18 {
                    _ = chat.automationPreciseScrollPacket(deltaY: 16)
                    preciseSamples.append(chat.contentView.bounds.minY)
                    await pause(18)
                }
            }
            let preciseImmediate = chat.edgePagingDiagnostics
            await pause(780)
            let preciseSettled = chat.edgePagingDiagnostics
            let precisePassed = preciseEvent != nil
                && preciseEvent?.hasPreciseScrollingDeltas == true
                && preciseWasActive
                && preciseSamples.last! < preciseSamples.first! - 8
                && monotonic(preciseSamples, direction: -1)
                && boundsPass(chat, preciseSamples)
                && (preciseImmediate["liveScrollActive"] as? Bool ?? false)
                && !(preciseSettled["liveScrollActive"] as? Bool ?? true)
                && !(preciseSettled["scrollSettlePending"] as? Bool ?? true)
                && !(preciseSettled["scrollWatchdogPending"] as? Bool ?? true)
            tests.append([
                "name": "precise-momentum-and-watchdog-settle",
                "passed": precisePassed,
                "eventPrecise": preciseEvent?.hasPreciseScrollingDeltas ?? NSNull(),
                "sampleCount": preciseSamples.count,
                "beforeY": Double(preciseSamples.first ?? 0),
                "afterY": Double(preciseSamples.last ?? 0),
                "samples": preciseSamples.map(Double.init),
                "immediate": preciseImmediate,
                "settled": preciseSettled,
            ])

            chat.onScrolledNearTop = savedOlderHandler
            chat.onScrolledNearBottom = savedNewerHandler

            // 4. Pagination arming: a long precise gesture may invoke the
            // older-page callback once, but never once per momentum packet.
            // After the settle window, the next gesture must invoke it again.
            let paginationProbe = MacChatScrollView(
                frame: NSRect(x: 0, y: 0, width: 420, height: 260)
            )
            paginationProbe.chatDocumentView.frame = NSRect(
                x: 0, y: 0, width: 420, height: 4_000
            )
            paginationProbe.contentView.bounds.origin.y = 0
            var olderCallbacks = 0
            paginationProbe.onScrolledNearTop = { olderCallbacks += 1 }
            paginationProbe.onScrolledNearBottom = nil
            let paginationWindow = NSWindow(
                contentRect: paginationProbe.bounds,
                styleMask: .borderless,
                backing: .buffered,
                defer: false
            )
            paginationWindow.isReleasedWhenClosed = false
            paginationWindow.contentView = paginationProbe
            paginationWindow.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
            paginationWindow.orderFrontRegardless()
            paginationProbe.layoutSubtreeIfNeeded()
            let firstPacket = paginationProbe.automationPreciseScrollPacket(deltaY: 16)
            for _ in 0..<24 {
                _ = paginationProbe.automationPreciseScrollPacket(deltaY: 16)
                runLoop(0.025)
            }
            let callbacksAfterSameGesture = olderCallbacks
            await pause(1_100)
            let beforeNextGestureState = paginationProbe.edgePagingDiagnostics
            let secondPacket = paginationProbe.automationPreciseScrollPacket(deltaY: 16)
            let callbacksAfterNextGesture = olderCallbacks
            let afterNextGestureState = paginationProbe.edgePagingDiagnostics
            let paginationPassed = callbacksAfterSameGesture == 1
                && callbacksAfterNextGesture == 2
                && firstPacket.after <= firstPacket.before
                && secondPacket.after <= secondPacket.before
            tests.append([
                "name": "older-pagination-one-page-per-gesture",
                "passed": paginationPassed,
                "callbacksAfterSameGesture": callbacksAfterSameGesture,
                "callbacksAfterNextGesture": callbacksAfterNextGesture,
                "firstPacketBeforeY": Double(firstPacket.before),
                "firstPacketAfterY": Double(firstPacket.after),
                "secondPacketBeforeY": Double(secondPacket.before),
                "secondPacketAfterY": Double(secondPacket.after),
                "beforeNextGestureState": beforeNextGestureState,
                "afterNextGestureState": afterNextGestureState,
            ])
            paginationWindow.close()

            // 5. Resize/reflow: after changing the window width, the same
            // stable visible row should remain at essentially the same screen
            // position, and the actual viewport should not expose placeholders.
            var resizeResult: [String: Any] = [
                "name": "resize-anchor-and-viewport-materialization",
                "passed": false,
            ]
            if let window = NSApp.windows
                .filter({ $0.contentView != nil && $0.frame.width > 700 && $0.frame.height > 500 })
                .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
                let beforeResizeState = layout()
                let stableCandidate = beforeResizeState["stableAnchorSeq"] as? Int
                let visibleCandidate = beforeResizeState["anchorSeq"] as? Int
                let stableSeq: Int?
                let beforeResizeY: CGFloat?
                if let stableCandidate,
                   let stableScreenY = screenY(for: stableCandidate, in: beforeResizeState) {
                    stableSeq = stableCandidate
                    beforeResizeY = stableScreenY
                } else {
                    stableSeq = visibleCandidate
                    beforeResizeY = visibleCandidate.flatMap {
                        screenY(for: $0, in: beforeResizeState)
                    }
                }
                let originalSize = window.contentLayoutRect.size
                let targetWidth = max(CGFloat(760), originalSize.width - 180)
                window.setContentSize(NSSize(width: targetWidth, height: originalSize.height))
                window.contentView?.layoutSubtreeIfNeeded()
                chat.layoutSubtreeIfNeeded()
                await pause(550)
                let afterResizeState = layout()
                let afterResizeY = stableSeq.flatMap { screenY(for: $0, in: afterResizeState) }
                let resizeDrift = beforeResizeY.flatMap { before in afterResizeY.map { $0 - before } }
                let resizePassed = abs(targetWidth - originalSize.width) >= 100
                    && stableSeq != nil
                    && resizeDrift.map { abs($0) <= 6 } == true
                    && (afterResizeState["intersectingPlaceholderCount"] as? Int ?? 0) == 0
                    && (afterResizeState["visibleCellCount"] as? Int ?? 0) <= 40
                window.setContentSize(originalSize)
                window.contentView?.layoutSubtreeIfNeeded()
                await pause(350)
                resizeResult = [
                    "name": "resize-anchor-and-viewport-materialization",
                    "passed": resizePassed,
                    "stableSeq": stableSeq ?? NSNull(),
                    "beforeY": beforeResizeY.map(Double.init) ?? NSNull(),
                    "afterY": afterResizeY.map(Double.init) ?? NSNull(),
                    "drift": resizeDrift.map(Double.init) ?? NSNull(),
                    "targetWidth": Double(targetWidth),
                    "originalWidth": Double(originalSize.width),
                    "intersectingPlaceholderCount": afterResizeState["intersectingPlaceholderCount"] ?? 0,
                    "visibleCellCount": afterResizeState["visibleCellCount"] ?? 0,
                ]
            } else {
                resizeResult["reason"] = "no production-sized window"
            }
            tests.append(resizeResult)

            // 6. Hard boundaries: repeated wheel input at either edge must
            // clamp, never overshoot or leave an invalid viewport.
            chat.scrollToBottom(animated: false)
            var bottomSamples = [chat.contentView.bounds.minY]
            for _ in 0..<4 {
                if let down = event(units: .line, y: -3) {
                    chat.scrollWheel(with: down)
                    bottomSamples.append(chat.contentView.bounds.minY)
                }
                await pause(25)
            }
            await pause(180)
            let topSeq = sessionWindow()?.top ?? 1
            _ = chat.automationScrollToBubble(seq: topSeq, screenY: 600)
            var topSamples = [chat.contentView.bounds.minY]
            for _ in 0..<6 {
                if let up = event(units: .line, y: 3) {
                    chat.scrollWheel(with: up)
                    topSamples.append(chat.contentView.bounds.minY)
                }
                await pause(25)
            }
            await pause(180)
            let boundaryState = layout()
            let boundaryPassed = boundsPass(chat, bottomSamples + topSamples)
                && chat.contentView.bounds.minY >= -chat.contentInsets.top - 1
                && chat.contentView.bounds.minY <= max(
                    -chat.contentInsets.top,
                    chat.chatDocumentView.frame.height - chat.contentView.bounds.height
                ) + 1
                && (boundaryState["intersectingPlaceholderCount"] as? Int ?? 0) == 0
            tests.append([
                "name": "top-bottom-boundary-clamping",
                "passed": boundaryPassed,
                "bottomSamples": bottomSamples.map(Double.init),
                "topSamples": topSamples.map(Double.init),
                "finalY": Double(chat.contentView.bounds.minY),
                "intersectingPlaceholderCount": boundaryState["intersectingPlaceholderCount"] ?? 0,
            ])

            let passed = tests.allSatisfy { $0["passed"] as? Bool == true }
            self.send(
                result: [
                    "passed": passed,
                    "scenario": chat.representedSessionId ?? NSNull(),
                    "testCount": tests.count,
                    "tests": tests,
                ],
                id: id,
                on: connection
            )
        }
    }
}
#endif
