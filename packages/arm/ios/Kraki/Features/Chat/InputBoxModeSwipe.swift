#if os(iOS)
/// InputBoxModeSwipe — Native-feeling horizontal swipe on the chat
/// input box that cycles `SessionMode`.
///
/// Design goals (what makes it feel "native"):
///   • 1:1 finger tracking with iOS-style rubber-band past one step.
///   • Pre-commit haptic at the moment the finger crosses the commit
///     threshold (and re-arms if the user pulls back) — like a picker
///     "click" you feel before you let go.
///   • Predict-and-snap on release (UIScrollView-style velocity
///     projection) so a light flick commits even from a tiny drag.
///   • Spring carries finger velocity through into a slightly
///     under-damped settle, so a hard fling overshoots and bounces;
///     a soft drop just eases. Real physics.
///   • The `setSessionMode` callback fires inside the same
///     `withAnimation(spring)` that drives the strip, so the
///     send-icon's color cross-fade rides exactly the same curve —
///     no "two-stage" feeling.
///
/// Architecture:
///   `InputBoxModeSwipeController` owns the algorithm + state. It's
///   an `@Observable` reference type so per-tick `offset` updates
///   only invalidate the small subview that reads them — not the
///   whole `MessageInputView`.
///
///   `InputBoxModeSwipeBackground` is the static glass capsule
///   plus the strip subview. Drop it into `.background { }` on the
///   input box. The glass layer never depends on swipe state.
///
///   The gesture itself lives at the call site so it can be
///   composed with the existing `simultaneousGesture` /
///   `holdToTalkGesture` arbitration; the controller just exposes
///   `handleChanged` / `handleEnded` entry points.

import SwiftUI
import UIKit

// MARK: - Controller

@Observable
final class InputBoxModeSwipeController {

    /// Visible horizontal offset of the strip, in points. The strip
    /// renders at `x = -width + offset`, so `offset == 0` centers the
    /// base block in the visible window.
    var offset: CGFloat = 0

    /// Mode snapshot taken at gesture start. While non-nil, the strip
    /// is anchored to this mode so its content stays stable across
    /// the entire drag + spring (avoids a mid-spring color jump when
    /// the live `currentSessionMode` changes). Cleared by the silent
    /// rebase at spring completion.
    var startMode: SessionMode? = nil

    // --- Internal gesture bookkeeping; not observed by views. ---

    /// Translation captured on the first onChanged tick. We subtract
    /// it from subsequent translations so the strip starts at exactly
    /// 0 (instead of jumping by the gesture's `minimumDistance`).
    @ObservationIgnored private var initialDx: CGFloat? = nil

    /// True between the moment `|offset|` first crosses the commit
    /// threshold and the moment it falls back below it. Guards the
    /// "click" haptic from firing repeatedly mid-drag.
    @ObservationIgnored private var hapticArmed = false

    // --- Tuning constants ---

    /// How far past `|offset| == stepWidth * commitFraction` we project
    /// the finger's velocity to decide whether to commit on release.
    /// Roughly UIScrollView's exponential decay over ~150ms.
    private static let predictionTime: Double = 0.15

    /// Position fraction (of one full step) that counts as a commit.
    /// Combined with `predictionTime`, even a small drag commits if
    /// flicked hard.
    private static let commitFraction: CGFloat = 0.35

    /// Rubber-band magnitude beyond one full step, expressed as a
    /// fraction of `stepWidth`. The asymptotic ln-curve hits ~0.30
    /// at infinity, which matches iOS' built-in scroll rubber-band.
    private static let rubberBandFraction: CGFloat = 0.3

    /// Hard cap on the spring's normalized initial velocity. Guards
    /// the corner case where the user releases ~1pt away from the
    /// snap point at high speed (`velocity / remaining` blows up).
    private static let momentumVelocityCap: Double = 35

    /// Cyclic mode order. Wraps modulo, so a swipe past `.delegate`
    /// returns to `.safe` (and vice versa).
    static let allModes: [SessionMode] = [.safe, .discuss, .execute, .delegate]

    /// Snap spring. `response 0.42s` settles in ~half a second on a
    /// soft drop; `dampingRatio 0.74` gives ~6% visible overshoot on
    /// a hard fling and ~1% on a soft drop — small enough to read as
    /// "this thing has mass" without feeling wobbly.
    private static let snapSpring = Spring(response: 0.42, dampingRatio: 0.74)

    // MARK: - Strip read API

    /// Which mode's color block the strip should center on. Snapshot
    /// during a gesture so the strip's content doesn't churn when
    /// `currentSessionMode` is mutated mid-spring by `commit`.
    func tintBaseMode(currentMode: SessionMode) -> SessionMode {
        startMode ?? currentMode
    }

    // MARK: - Gesture entry points

    /// Feed a `DragGesture.onChanged` translation into the controller.
    /// Returns `true` if the controller is actively tracking this swipe.
    /// Returns `false` on the first tick if motion isn't horizontal
    /// (lets the caller route the gesture elsewhere — e.g. let a
    /// vertical scroll proceed).
    @discardableResult
    func handleChanged(
        translation: CGSize,
        currentMode: SessionMode,
        stepWidth: CGFloat
    ) -> Bool {
        guard let firstDx = initialDx else {
            // First contact: lock to horizontal motion only.
            guard abs(translation.width) > abs(translation.height) else { return false }
            initialDx = translation.width
            startMode = currentMode
            hapticArmed = false
            return true
        }
        let dx = translation.width - firstDx
        offset = rubberBanded(dx, step: stepWidth)
        updateHaptic(threshold: stepWidth * Self.commitFraction)
        return true
    }

    /// Feed a `DragGesture.onEnded` velocity into the controller. The
    /// `commit` closure fires synchronously inside `withAnimation`
    /// when a mode change is decided — putting any side-effects (e.g.
    /// `setSessionMode`, toast presentation) inside this closure makes
    /// them animate together with the strip.
    func handleEnded(
        velocity: CGFloat,
        currentMode _: SessionMode,
        stepWidth: CGFloat,
        commit: (SessionMode) -> Void
    ) {
        defer {
            initialDx = nil
            hapticArmed = false
        }
        guard let start = startMode else { return }

        // 1. Predict where the finger would land if it kept decelerating
        //    at iOS-scroll-like rate. This is the decisive number — it
        //    folds "did the user drag far enough" and "did they flick
        //    hard enough" into one threshold check.
        let projected = offset + velocity * Self.predictionTime
        let threshold = stepWidth * Self.commitFraction

        let commitStep: Int
        if projected > threshold {
            commitStep = -1   // dragged right → previous mode peeks in from the left
        } else if projected < -threshold {
            commitStep = +1   // dragged left → next mode peeks in from the right
        } else {
            commitStep = 0
        }
        let targetOffset: CGFloat = -CGFloat(commitStep) * stepWidth

        // 2. Resolve the new mode (if any) BEFORE entering withAnimation,
        //    so the commit closure runs synchronously with the spring's
        //    state transition.
        let newMode: SessionMode? = {
            guard commitStep != 0 else { return nil }
            let modes = Self.allModes
            let count = modes.count
            let baseIdx = modes.firstIndex(of: start) ?? 1
            let idx = ((baseIdx + commitStep) % count + count) % count
            return modes[idx]
        }()

        if newMode != nil {
            // Commit-confirmation haptic. `rigid` is heavier than the
            // pre-commit `light` so the two feel distinct in your hand.
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
        }

        // 3. Normalize finger velocity into the spring's [0,1]-per-second
        //    space. The spring API wants a unit where 1.0 means "covers
        //    the full remaining distance in 1 second".
        let remaining = targetOffset - offset
        let normalizedV: Double
        if remaining == 0 {
            normalizedV = 0
        } else {
            let v = Double(velocity / remaining)
            // If finger reversed direction at release (v < 0), passing a
            // negative initial velocity makes the spring back up before
            // accelerating toward the target — it looks like a stutter.
            // Treat as zero; the spring's natural acceleration handles it.
            normalizedV = v < 0 ? 0 : min(v, Self.momentumVelocityCap)
        }

        let animation = Animation.interpolatingSpring(
            Self.snapSpring,
            initialVelocity: normalizedV
        )

        withAnimation(animation) {
            // Anything inside here rides the same spring as `offset`:
            // the caller's commit (which mutates currentSessionMode →
            // the send-icon's tint), the strip's settle, etc.
            if let newMode { commit(newMode) }
            offset = targetOffset
        } completion: { [weak self] in
            // Silent rebase: drop the start-mode snapshot and zero the
            // offset. By this point `currentSessionMode` already equals
            // the snapped mode, so the strip rebuilds with the same
            // color in the same screen position — visually a no-op.
            //
            // If a new gesture has already started during the spring
            // (the user immediately started swiping again before the
            // spring settled), leave its in-flight state alone — the
            // rebase would otherwise yank the strip back to 0.
            guard let self, self.initialDx == nil else { return }
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) {
                self.startMode = nil
                self.offset = 0
            }
        }
    }

    /// Drop in-flight gesture state and snap back to rest. Call if the
    /// host view is dismissed or the gesture is interrupted.
    func cancel() {
        initialDx = nil
        hapticArmed = false
        withAnimation(.interpolatingSpring(Self.snapSpring, initialVelocity: 0)) {
            offset = 0
        } completion: { [weak self] in
            guard let self, self.initialDx == nil else { return }
            var t = Transaction()
            t.disablesAnimations = true
            withTransaction(t) { self.startMode = nil }
        }
    }

    // MARK: - Internals

    /// iOS-style rubber-band beyond one full step. The ln curve is
    /// asymptotically bounded by `stepWidth * (1 + rubberBandFraction)`,
    /// so even an infinite drag never blows past it. Matches the feel
    /// of UIScrollView's `bounces = true` behavior.
    private func rubberBanded(_ dx: CGFloat, step: CGFloat) -> CGFloat {
        let limit = max(step, 1)
        if abs(dx) <= limit { return dx }
        let excess = abs(dx) - limit
        let rubber = limit * Self.rubberBandFraction
            * log(1 + 5 * excess / limit) / log(6)
        return (dx > 0 ? 1 : -1) * (limit + rubber)
    }

    private func updateHaptic(threshold: CGFloat) {
        let past = abs(offset) >= threshold
        if past, !hapticArmed {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            hapticArmed = true
        } else if !past, hapticArmed {
            hapticArmed = false
        }
    }
}

// MARK: - Background view

/// Drop in via `.background { InputBoxModeSwipeBackground(...) }`.
/// Renders the glass capsule + the mode-color strip. The glass layer
/// doesn't touch any observable state, so it's never re-rasterized
/// during a drag.
struct InputBoxModeSwipeBackground: View {
    let controller: InputBoxModeSwipeController
    let currentMode: SessionMode
    let width: CGFloat

    var body: some View {
        let shape = Capsule()
        ZStack(alignment: .bottom) {
            glassCapsule(shape)

            // Only this subview observes `controller.offset` /
            // `controller.startMode`, so drag ticks invalidate it
            // alone — not the glass and not the parent.
            InputBoxModeSwipeStripView(
                controller: controller,
                currentMode: currentMode,
                width: width
            )
            .clipShape(shape)
            .allowsHitTesting(false)
        }
    }

    @ViewBuilder
    private func glassCapsule(_ shape: Capsule) -> some View {
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape.fill(.ultraThinMaterial)
        }
    }
}

// MARK: - Strip subview

/// Three colored blocks (prev / base / next mode) stacked
/// horizontally and offset by `controller.offset`. Pinned to the
/// bottom edge of the parent. Width per block matches the input box
/// width so a full step (`|offset| == width`) exactly replaces the
/// visible color with the adjacent one.
private struct InputBoxModeSwipeStripView: View {
    let controller: InputBoxModeSwipeController
    let currentMode: SessionMode
    let width: CGFloat

    private static let stripHeight: CGFloat = 1.5
    private static let stripOpacity: Double = 0.95

    var body: some View {
        let baseMode = controller.tintBaseMode(currentMode: currentMode)
        let offset = controller.offset
        let modes = InputBoxModeSwipeController.allModes
        let count = modes.count
        let baseIdx = modes.firstIndex(of: baseMode) ?? 1
        let prevIdx = ((baseIdx - 1) % count + count) % count
        let nextIdx = ((baseIdx + 1) % count + count) % count

        HStack(spacing: 0) {
            block(modes[prevIdx])
            block(modes[baseIdx])
            block(modes[nextIdx])
        }
        .offset(x: -width + offset)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    private func block(_ mode: SessionMode) -> some View {
        Color.modeColor(mode)
            .opacity(Self.stripOpacity)
            .frame(width: width, height: Self.stripHeight)
    }
}

// MARK: - Width preference

/// Lets the input box measure its own width once via a flat
/// `.background(GeometryReader { ... })`, instead of nesting a
/// GeometryReader inside the strip (which would re-measure on every
/// drag tick).
struct InputBoxWidthPreferenceKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        let next = nextValue()
        if next > 0 { value = next }
    }
}

#endif
