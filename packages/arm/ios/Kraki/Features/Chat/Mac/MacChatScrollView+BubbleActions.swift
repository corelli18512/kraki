/// Clicks on bubble actions (copy, retry, permission/question buttons) routed before AppKit's own handling.

#if os(macOS)
import AppKit
import QuartzCore
import SwiftUI
import os.log

extension MacChatScrollView {
    func interceptBubbleActionMouseEvent(_ event: NSEvent) -> NSEvent? {
        guard let window,
              event.windowNumber == window.windowNumber,
              !isHidden,
              alphaValue > 0.01 else { return event }
        let windowPoint = event.locationInWindow

        switch event.type {
        case .leftMouseDown:
            guard let context = chatDocumentView.actionCaptureContext(
                atWindowPoint: windowPoint
            ) else {
                pendingBubbleActionClick = nil
                return event
            }
            let capture = context.capture
            #if KRAKI_DIAG
            if case .question(let questionId) = capture {
                KrakiDiag.record(.uiMouse, session: representedSessionId,
                    [.questionId: .id(questionId), .phase: .tag("down"), .eventNumber: .int(event.eventNumber), .clickCount: .int(event.clickCount)])
            }
            #endif
            let target = chatDocumentView.actionHitTarget(
                for: capture,
                atActionPoint: context.actionPoint
            )
            // SwiftUI propagates rendered choice frames asynchronously. Capture
            // the whole interactive action region while that cache is empty so
            // a zoomed click never falls through to SwiftUI's shifted hit test.
            pendingBubbleActionClick = (target, capture, windowPoint, false)
            return nil

        case .leftMouseDragged:
            guard var pending = pendingBubbleActionClick else { return event }
            if hypot(windowPoint.x - pending.start.x, windowPoint.y - pending.start.y) > 5 {
                pending.cancelled = true
                pendingBubbleActionClick = pending
            }
            return nil

        case .leftMouseUp:
            guard let pending = pendingBubbleActionClick else { return event }
            #if KRAKI_DIAG
            if case .question(let questionId) = pending.capture {
                KrakiDiag.record(.uiMouse, session: representedSessionId,
                    [.questionId: .id(questionId), .phase: .tag("up"), .eventNumber: .int(event.eventNumber), .clickCount: .int(event.clickCount)])
            }
            #endif
            pendingBubbleActionClick = nil
            guard !pending.cancelled,
                  let context = chatDocumentView.actionCaptureContext(
                    atWindowPoint: windowPoint
                  ),
                  context.capture == pending.capture else {
                return nil
            }
            if let expectedTarget = pending.target {
                guard chatDocumentView.actionHitTarget(
                    for: pending.capture,
                    atActionPoint: context.actionPoint
                  ) == expectedTarget else { return nil }
                dispatchBubbleAction(expectedTarget)
            } else {
                dispatchBubbleActionWhenReady(
                    atActionPoint: context.actionPoint,
                    expectedCapture: pending.capture
                )
            }
            return nil

        default:
            return event
        }
    }

    func dispatchBubbleAction(_ target: MacBubbleActionHitTarget) {
        let answerCallback = chatDocumentView.onAnswerQuestion
        let permissionCallback = chatDocumentView.onResolvePermission
        DispatchQueue.main.async {
            switch target {
            case .question(let target):
                #if KRAKI_DIAG
                KrakiDiag.record(.uiAnswer, [.questionId: .id(target.questionId), .origin: .tag("mac_monitor")])
                #endif
                answerCallback?(target.questionId, target.answer)
            case .permission(let target):
                permissionCallback?(target.permissionId, target.toolName, target.decision)
            }
        }
    }

    func dispatchBubbleActionWhenReady(
        atActionPoint point: NSPoint,
        expectedCapture: MacBubbleActionCapture,
        attemptsRemaining: Int = 8
    ) {
        if let target = chatDocumentView.actionHitTarget(
            for: expectedCapture,
            atActionPoint: point
        ) {
            dispatchBubbleAction(target)
            return
        }
        guard attemptsRemaining > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0 / 120.0) { [weak self] in
            self?.dispatchBubbleActionWhenReady(
                atActionPoint: point,
                expectedCapture: expectedCapture,
                attemptsRemaining: attemptsRemaining - 1
            )
        }
    }
}
#endif
