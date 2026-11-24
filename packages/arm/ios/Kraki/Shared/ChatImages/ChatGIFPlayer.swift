/// Plays a `ChatGIFAnimation` into a view (iOS and Mac).

import CoreGraphics
import Foundation
import QuartzCore
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// Drives the frames of one chat image's GIF animation on screen (iOS
/// `ChatAnimatedImageView`, Mac thumbnail and viewer). `show(_:)` decodes the
/// GIF in the background (`AttachmentImageCache`) and starts it, unless
/// Reduce Motion is on: then it stays on the first frame until `play()`.
/// One timer per frame change (each GIF frame keeps its own delay), running
/// in common modes so a GIF keeps playing while the chat scrolls. Suspended
/// while the view is off screen; it then resumes where it was.
@MainActor
final class ChatGIFPlayer {
    /// Called with every frame to show (the first one right away), and with
    /// nil when the view should show its still image again.
    var onFrame: (CGImage?) -> Void
    /// Called when the image turns out animated, and on play / pause.
    var onPlaybackChange: () -> Void = {}
    private(set) var animation: ChatGIFAnimation?
    /// The image shown; its GIF animation is loaded for it.
    private(set) var file: ChatImageFile?
    private var loadTask: Task<Void, Never>?
    private var reduceMotionObserver: NSObjectProtocol?
    /// The user's (or Reduce Motion's) choice: playing or paused.
    private(set) var isPlaying = false
    /// Shown on screen (in a window); a hidden player does not tick.
    private var isVisible = false
    /// Playback position, in seconds, when last paused or suspended.
    private var elapsedOffset: TimeInterval = 0
    private var startedAt: CFTimeInterval?
    private var timer: Timer?

    init(onFrame: @escaping (CGImage?) -> Void) {
        self.onFrame = onFrame
        let change = Self.reduceMotionDidChange
        reduceMotionObserver = change.center.addObserver(forName: change.name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reduceMotionChanged() }
        }
    }

    deinit {
        loadTask?.cancel()
        timer?.invalidate()
        if let reduceMotionObserver { Self.reduceMotionDidChange.center.removeObserver(reduceMotionObserver) }
    }

    var isAnimated: Bool { animation != nil }

    /// The chat image to animate (nil, or not an animated GIF: nothing to
    /// play, the view shows its still image). The same image keeps playing.
    func show(_ file: ChatImageFile?) {
        guard file?.id != self.file?.id else { return }
        self.file = file
        loadTask?.cancel()
        loadTask = nil
        load(nil, playing: false)
        onFrame(nil)
        onPlaybackChange()
        guard let file, file.isGIF else { return }
        if let cached = AttachmentImageCache.cachedAnimation(id: file.id) {
            start(cached)
            return
        }
        loadTask = Task { [weak self] in
            let animation = await AttachmentImageCache.animation(id: file.id, data: file.data)
            guard !Task.isCancelled, let self, self.file?.id == file.id, let animation else { return }
            self.start(animation)
        }
    }

    func togglePlayback() {
        if isPlaying { pause() } else { play() }
    }

    private func start(_ animation: ChatGIFAnimation) {
        load(animation, playing: Self.autoplays)
        onPlaybackChange()
    }

    /// Reduce Motion turned on: back to the first frame, paused; off: play.
    private func reduceMotionChanged() {
        guard let animation else { return }
        if Self.autoplays { play() } else { load(animation, playing: false) }
        onPlaybackChange()
    }

    /// Whether a GIF starts playing by itself: not with Reduce Motion on
    /// (it then shows its first frame until the user plays it).
    static var autoplays: Bool {
        if let reduceMotionOverride { return !reduceMotionOverride }
        #if canImport(UIKit)
        return !UIAccessibility.isReduceMotionEnabled
        #else
        return !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        #endif
    }

    /// Tests pin Reduce Motion instead of reading the system setting.
    static var reduceMotionOverride: Bool?

    /// Posted when the system's Reduce Motion setting changes.
    nonisolated static var reduceMotionDidChange: (center: NotificationCenter, name: Notification.Name) {
        #if canImport(UIKit)
        return (NotificationCenter.default, UIAccessibility.reduceMotionStatusDidChangeNotification)
        #else
        return (NSWorkspace.shared.notificationCenter, NSWorkspace.accessibilityDisplayOptionsDidChangeNotification)
        #endif
    }

    var currentFrameIndex: Int {
        animation?.frameIndex(at: elapsed) ?? 0
    }

    private var elapsed: TimeInterval {
        guard let startedAt else { return elapsedOffset }
        return elapsedOffset + (CACurrentMediaTime() - startedAt)
    }

    /// A new animation starts at its first frame, playing if `playing`.
    func load(_ animation: ChatGIFAnimation?, playing: Bool) {
        stopClock()
        self.animation = animation
        elapsedOffset = 0
        isPlaying = playing && animation != nil
        showCurrentFrame()
        startClockIfNeeded()
    }

    func play() {
        guard let animation, !isPlaying else { return }
        // A finished animation starts over.
        if animation.hasFinished(at: elapsed) { elapsedOffset = 0 }
        isPlaying = true
        startClockIfNeeded()
        onPlaybackChange()
    }

    func pause() {
        guard isPlaying else { return }
        stopClock()
        isPlaying = false
        showCurrentFrame()
        onPlaybackChange()
    }

    func setVisible(_ visible: Bool) {
        guard visible != isVisible else { return }
        isVisible = visible
        if visible { startClockIfNeeded() } else { stopClock() }
    }

    private func startClockIfNeeded() {
        guard isPlaying, isVisible, startedAt == nil, animation != nil else { return }
        startedAt = CACurrentMediaTime()
        scheduleNextFrame()
    }

    /// Keeps the position reached and stops ticking.
    private func stopClock() {
        timer?.invalidate()
        timer = nil
        if startedAt != nil { elapsedOffset = elapsed }
        startedAt = nil
    }

    private func scheduleNextFrame() {
        timer?.invalidate()
        timer = nil
        guard let animation, let wait = animation.timeUntilNextFrame(at: elapsed) else {
            // Played its loops: stays on the last frame, ready to replay.
            stopClock()
            isPlaying = false
            showCurrentFrame()
            onPlaybackChange()
            return
        }
        let timer = Timer(timeInterval: wait, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.showCurrentFrame()
                self?.scheduleNextFrame()
            }
        }
        timer.tolerance = min(0.005, wait / 10)
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func showCurrentFrame() {
        guard let animation, !animation.frames.isEmpty else { return }
        onFrame(animation.frames[min(currentFrameIndex, animation.frames.count - 1)])
    }
}
